import { appendFileSync } from "node:fs";
import OpenAI from "openai";
import { prisma } from "../../prisma.js";
import { normalizeName } from "./entityResolver.js";
import { datesIn, MONTH_WORDS } from "./dates.js";
import { kinOf } from "./kinship.js";
import { RELATIONS, roleGroup } from "./peopleSchema.js";

// PEOPLE_ENGINE=tools answering: the model chooses tools over the stored graph and may state only names and dates
// that came back from them (checked by groundAdvisorReply). No question wording is parsed in code.
const MODEL = "gpt-4o-mini";
const MAX_ROUNDS = 6;

const TOOLS = [
  tool("get_relatives", "The narrator's relatives and other people linked to them, filtered by relation. Use \"all\" for everyone.", { kind: { type: "string", enum: ["all", ...RELATIONS] } }, ["kind"]),
  tool("get_person", "Everything recorded about one person, by full or partial name. Returns candidates when the name is ambiguous.", { name: { type: "string" } }, ["name"]),
  tool("find_people", "Everyone recorded with this first name.", { first_name: { type: "string" } }, ["first_name"]),
  tool("get_dates", "Birth, death, marriage and divorce dates for one person (or \"narrator\").", { name: { type: "string" } }, ["name"]),
  tool("family_tree", "The narrator's whole recorded family, grouped by relation.", {}, []),
  tool("get_assets", "Property, land, vehicles and other assets: who owned them and when, plus the records about them. as_of is YYYY-MM-DD; use today for \"now\".", { as_of: { type: "string" } }, ["as_of"]),
];

function tool(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", additionalProperties: false, properties, required } } };
}

function systemPrompt(selfName, today) {
  return `You answer the narrator's questions about their family, the people in their life and their assets.
The narrator is ${selfName}. Today is ${today}.
Use the tools to look things up; never answer from memory. State only names and dates that appear in tool results.
If a tool returns ambiguous candidates, ask which person they mean and list the candidates. If something is not recorded, say it is not recorded yet.
Facts marked unconfirmed must be called unconfirmed. Ended marriages are former spouses, not current ones.
Reply briefly, in the language of the question.`;
}

// Everything the tools read, loaded once per question.
export async function loadSnapshot(userId) {
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true, status: { not: "archived" } } });
  const [entities, edges] = await Promise.all([
    prisma.entity.findMany({ where: { userId, status: { not: "archived" }, mergedIntoId: null }, take: 1000 }),
    prisma.relationship.findMany({ where: { userId, status: { in: ["confirmed", "suggested"] }, fromKind: "entity", toKind: "entity", OR: [{ label: null }, { label: { not: "conflict" } }] }, take: 2000 }),
  ]);
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return { self, entities, edges, byId };
}

// Edge dates carry no precision unless stated (endPrecision "year"). A bare year was stored as 1 January, so a
// 1 January with no stated precision is shown as its year: never more precise than what was said.
export function edgeDay(value, precision = null) {
  const iso = day(value);
  if (!iso) return null;
  return precision === "year" || (!precision && iso.endsWith("-01-01")) ? iso.slice(0, 4) : iso;
}

export const day = (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null);

// The narrator's role word for a person, from the edge that links them.
function relationToNarrator(edge, selfId, other) {
  const kindWord = edge.attributes?.kind || other?.kind || null;
  const selfFrom = edge.fromId === selfId;
  const map = { spouse_of: "spouse", sibling_of: "sibling", relative_of: "relative", knows: "acquaintance", friend_of: "friend" };
  let relation = map[edge.type] || "related";
  if (edge.type === "parent_of") relation = selfFrom ? "child" : "parent";
  if (edge.type === "child_of") relation = selfFrom ? "parent" : "child";
  if (edge.type === "grandparent_of") relation = selfFrom ? "grandchild" : "grandparent";
  const ended = Boolean(edge.validTo || edge.attributes?.ended);
  if (edge.type === "spouse_of" && ended) relation = "former_spouse";
  return { relation, role: kindWord && kinOf(kindWord) ? kindWord : relation, ended };
}

function personSummary(snapshot, entity) {
  return { name: entity.name, born: day(entity.birthDate), died: day(entity.deathDate) };
}

export function links(snapshot) {
  const selfId = snapshot.self?.id;
  const out = [];
  for (const edge of snapshot.edges) {
    if (edge.fromId !== selfId && edge.toId !== selfId) continue;
    if (!["family", "social"].includes(edge.category)) continue;
    const other = snapshot.byId.get(edge.fromId === selfId ? edge.toId : edge.fromId);
    if (!other || other.isSelf) continue;
    const { relation, role, ended } = relationToNarrator(edge, selfId, other);
    if (ended && edge.type !== "spouse_of") continue;
    out.push({ ...personSummary(snapshot, other), relation, role, unconfirmed: edge.status === "suggested", ...(edge.type === "spouse_of" ? { married: edgeDay(edge.validFrom), ended: ended ? edgeDay(edge.validTo, edge.attributes?.endPrecision) || "yes" : null } : {}), id: other.id });
  }
  return out;
}

export function matchesKind(link, kind) {
  if (kind === "all") return true;
  const group = roleGroup(kind);
  const word = kinOf(link.role);
  if (kind === "former_spouse") return link.relation === "former_spouse";
  if (["spouse", "partner"].includes(kind)) return link.relation === "spouse";
  if (["parent", "child", "sibling", "grandparent", "grandchild"].includes(kind)) {
    if (kind === "sibling") return link.relation === "sibling" && !(word?.half);
    return link.relation === kind;
  }
  if (kind === "half_sibling") return link.relation === "sibling" && Boolean(word?.half);
  const wanted = { step_parent: (w) => w?.step && w.group === "relative" && kinOf(w.base)?.group === "parent", step_child: (w) => w?.step && kinOf(w.base)?.group === "child", step_sibling: (w) => w?.step && kinOf(w.base)?.group === "sibling", parent_in_law: (w) => w?.inLaw && kinOf(w.base)?.group === "parent", child_in_law: (w) => w?.inLaw && kinOf(w.base)?.group === "child", sibling_in_law: (w) => w?.inLaw && kinOf(w.base)?.group === "sibling" };
  if (wanted[kind]) return Boolean(wanted[kind](word));
  const words = { aunt_uncle: ["aunt", "uncle", "auntie", "mjomba", "shangazi"], niece_nephew: ["niece", "nephew"], cousin: ["cousin", "binamu"], godparent: ["godmother", "godfather", "godparent"], godchild: ["godson", "goddaughter", "godchild"], friend: ["friend"], neighbour: ["neighbour", "neighbor"], colleague: ["colleague"], other_relative: ["relative"] };
  return (words[kind] || []).includes(word?.base) || (group === "relative" && kind === "other_relative" && link.relation === "relative");
}

export function findByName(snapshot, name) {
  const key = normalizeName(name);
  const people = snapshot.entities.filter((entity) => entity.entityType === "person");
  const exact = people.filter((entity) => normalizeName(entity.name) === key || (entity.aliases || []).some((alias) => normalizeName(alias) === key));
  if (exact.length) return exact;
  const words = key.split(" ").filter(Boolean);
  return people.filter((entity) => {
    const parts = normalizeName(entity.name).split(" ");
    return words.every((word) => parts.includes(word));
  });
}

function describeEdge(snapshot, edge, personId) {
  const name = (id) => (id === snapshot.self?.id ? "narrator" : snapshot.byId.get(id)?.name || null);
  const from = name(edge.fromId);
  const to = name(edge.toId);
  if (!from || !to) return null;
  return {
    fact: `${from} ${edge.type.replaceAll("_", " ")} ${to}`,
    ...(edge.attributes?.kind ? { role: edge.attributes.kind } : {}),
    ...(edge.validFrom ? { from: edgeDay(edge.validFrom) } : {}),
    ...(edge.validTo || edge.attributes?.ended ? { ended: edgeDay(edge.validTo, edge.attributes?.endPrecision) || "yes" } : {}),
    ...(edge.status === "suggested" ? { unconfirmed: true } : {}),
    about: edge.fromId === personId ? "subject" : "object",
  };
}

export function personRecord(snapshot, entity) {
  const link = links(snapshot).find((item) => item.id === entity.id);
  const facts = snapshot.edges.filter((edge) => edge.fromId === entity.id || edge.toId === entity.id).map((edge) => describeEdge(snapshot, edge, entity.id)).filter(Boolean).slice(0, 25);
  return { ...personSummary(snapshot, entity), relation_to_narrator: link ? link.role : null, unconfirmed: link?.unconfirmed || false, facts };
}

export async function assetsAsOf(userId, snapshot, asOf) {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf)) ? new Date(`${asOf}T23:59:59Z`) : new Date();
  const owned = [];
  const evidence = new Set();
  for (const edge of snapshot.edges.filter((item) => item.category === "ownership")) {
    const from = snapshot.byId.get(edge.fromId);
    const to = snapshot.byId.get(edge.toId);
    if (!from || !to) continue;
    const owner = edge.type === "owned_by" ? to : from;
    const asset = edge.type === "owned_by" ? from : to;
    const started = edge.validFrom ? new Date(edge.validFrom) <= at : true;
    const current = started && (!edge.validTo || new Date(edge.validTo) > at);
    owned.push({ asset: asset.name, asset_type: asset.entityType, owner: owner.isSelf ? "narrator" : owner.name, relation: edge.type, from: edgeDay(edge.validFrom), until: edgeDay(edge.validTo, edge.attributes?.endPrecision), held_on_date: current, unconfirmed: edge.status === "suggested" });
    if (edge.evidenceEventId) evidence.add(edge.evidenceEventId);
  }
  // The records behind those edges, and any record with a stated amount: the model reads what the person wrote.
  const events = await prisma.event.findMany({
    where: { userId, status: { not: "archived" }, OR: [{ id: { in: [...evidence] } }, { NOT: { financials: { equals: {} } } }] },
    select: { title: true, occurredAt: true, rawInput: true, understoodMeaning: true },
    orderBy: { occurredAt: { sort: "asc", nulls: "last" } },
    take: 60,
  });
  return { as_of: day(at), ownership: owned, records: events.map((event) => ({ title: event.title, date: day(event.occurredAt), text: String(event.rawInput || event.understoodMeaning || "").slice(0, 400) })) };
}

async function runTool(userId, snapshot, name, args) {
  if (name === "get_relatives") return { relatives: links(snapshot).filter((link) => matchesKind(link, args.kind)).map(({ id, ...rest }) => rest) };
  if (name === "get_person" || name === "get_dates") {
    if (name === "get_dates" && ["narrator", "me", "i"].includes(normalizeName(args.name))) return { name: snapshot.self?.name, born: day(snapshot.self?.birthDate) };
    const found = findByName(snapshot, args.name);
    if (!found.length) return { found: false, name: args.name };
    if (found.length > 1) return { ambiguous: true, candidates: found.map((entity) => ({ name: entity.name, relation_to_narrator: links(snapshot).find((link) => link.id === entity.id)?.role || null })) };
    const record = personRecord(snapshot, found[0]);
    if (name === "get_person") return record;
    const marriages = record.facts.filter((fact) => fact.fact.includes("spouse of")).map((fact) => ({ with: fact.fact, married: fact.from || null, ended: fact.ended || null }));
    return { name: record.name, born: record.born, died: record.died, marriages };
  }
  if (name === "find_people") {
    const first = normalizeName(args.first_name).split(" ")[0];
    return { people: snapshot.entities.filter((entity) => entity.entityType === "person" && normalizeName(entity.name).split(" ")[0] === first).map((entity) => personRecord(snapshot, entity)).map(({ facts, ...rest }) => rest) };
  }
  if (name === "family_tree") {
    const tree = {};
    for (const link of links(snapshot)) {
      const { id, ...rest } = link;
      (tree[link.relation] ||= []).push(rest);
    }
    return { narrator: snapshot.self?.name, ...tree };
  }
  if (name === "get_assets") return assetsAsOf(userId, snapshot, args.as_of);
  return { error: `unknown tool ${name}` };
}

const NAME_RUN = /[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)*/gu;

// What the reply may state, by meaning: the people the tools returned (with every alias the snapshot knows for
// them), the dates they returned at the precision they were stored (a bare year stays a bare year), and the
// words the results use as labels ("relation", "former_spouse"), which are vocabulary, not names.
export function allowedFrom(results, question, snapshot = null) {
  const names = new Set();
  const dates = new Set();
  const months = new Set();
  const years = new Set();
  const vocabulary = new Set();
  const words = (text) => normalizeName(String(text).replaceAll("_", " ")).split(" ").filter(Boolean);
  const walk = (value) => {
    if (value == null) return;
    if (value instanceof Date) {
      if (!Number.isNaN(value.getTime())) dates.add(value.toISOString().slice(0, 10));
      return;
    }
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        words(key).forEach((word) => vocabulary.add(word));
        walk(item);
      }
      return;
    }
    const text = String(value);
    const written = datesIn(text);
    written.dates.forEach((iso) => dates.add(iso));
    written.months.forEach((month) => months.add(month));
    written.years.forEach((year) => years.add(year));
    for (const match of text.matchAll(NAME_RUN)) names.add(match[0]);
    // A short lowercase label ("half-sister", "acquaintance") is vocabulary.
    if (text.length <= 40 && text === text.toLowerCase()) words(text).forEach((word) => vocabulary.add(word));
  };
  walk(results);
  for (const match of String(question).matchAll(NAME_RUN)) names.add(match[0]);
  // Aliases: anyone in the snapshot whose name the tools returned may be called by any of their recorded names.
  if (snapshot?.entities) {
    const returned = new Set([...names].map((name) => normalizeName(name)));
    for (const entity of snapshot.entities) {
      if (returned.has(normalizeName(entity.name))) (entity.aliases || []).forEach((alias) => names.add(alias));
    }
  }
  return { allowedNames: [...names], allowedDates: dates, allowedMonths: months, allowedYears: years, vocabulary };
}

// A dated claim is supported only at the precision the tools gave it: a full date needs that date, a month needs a
// date in that month, a year needs any date in that year. "03/04/2019" is supported when either reading is.
function datesSupported(found, allowed) {
  const dates = allowed.allowedDates;
  const months = new Set([...(allowed.allowedMonths || []), ...[...dates].map((iso) => iso.slice(0, 7))]);
  const years = new Set([...(allowed.allowedYears || []), ...[...months].map((month) => month.slice(0, 4))]);
  const missing = [];
  for (const iso of found.dates) if (!dates.has(iso)) missing.push(iso);
  for (const pair of found.either || []) if (!pair.some((iso) => dates.has(iso))) missing.push(pair[0]);
  for (const month of found.months || []) if (!months.has(month)) missing.push(month);
  for (const year of found.years) if (!years.has(year)) missing.push(year);
  return missing;
}

// Names a sentence states that the tools never returned. Capitalised words that are role words, month words or
// the results' own labels are vocabulary; a lone capitalised word opening a line, sentence or bracket is grammar.
function unsupportedNames(sentence, known, vocabulary) {
  const claims = [];
  const plain = sentence.replace(/[*_`#>|]/g, " ");
  for (const match of plain.matchAll(NAME_RUN)) {
    const words = match[0].split(/\s+/).filter((word) => {
      const key = normalizeName(word);
      return !MONTH_WORDS.has(word.toLowerCase().replace(/\.$/, "")) && !kinOf(word) && !key.split(" ").every((part) => vocabulary.has(part) || kinOf(part));
    });
    if (!words.length) continue;
    const before = plain.slice(0, match.index);
    const opening = before.trim() === "" || /[:(—–-]\s*$/.test(before) || /^\s*(?:\d+[.)]|[-•])\s*$/.test(before);
    if (words.length === 1 && opening) continue;
    if (!words.every((word) => normalizeName(word).split(" ").every((part) => known.has(part)))) claims.push(words.join(" "));
  }
  return claims;
}

// The post-check, in any language, by meaning: a sentence naming someone the tools never returned is dropped, and
// so is one stating a date the tools never returned (or a more precise one than they stored). Lines are checked
// one at a time, so one bad list item never takes the whole list with it.
export function groundToolReply(reply, allowed) {
  const known = new Set(allowed.allowedNames.flatMap((name) => normalizeName(name).split(" ")).filter(Boolean));
  const vocabulary = allowed.vocabulary || new Set();
  const removed = [];
  const lines = [];
  for (const line of String(reply || "").split("\n")) {
    const kept = [];
    const sentences = line.split(/(?<=[.!?])\s+/).filter((part) => part.trim());
    for (const sentence of sentences) {
      const names = unsupportedNames(sentence, known, vocabulary);
      const dates = names.length ? [] : datesSupported(datesIn(sentence), allowed);
      if (names.length || dates.length) {
        removed.push(...names, ...dates);
        continue;
      }
      kept.push(sentence);
    }
    if (kept.length || !line.trim()) lines.push(kept.join(" "));
  }
  for (const claim of removed) console.log(`[advisor] removed unsupported claim: "${claim}"`);
  return { reply: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

// DIRA_POSTCHECK_AUDIT=<file> appends every post-check that removed something, with what the tools returned, for
// auditing on the synthetic set. Never set it for hold-out runs.
export function auditPostCheck(entry) {
  const file = process.env.DIRA_POSTCHECK_AUDIT;
  if (!file || !entry.removed?.length) return;
  try { appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch { /* audit only */ }
}

// Returns null when the model needs no tool for this question; the general advisor answers it then.
export async function answerWithTools(userId, history) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const client = new OpenAI({ apiKey: key, timeout: 30000 });
  const snapshot = await loadSnapshot(userId);
  const today = new Date().toISOString().slice(0, 10);
  const messages = [{ role: "system", content: systemPrompt(snapshot.self?.name || "the narrator", today) }, ...history.slice(-12)];
  const question = [...history].reverse().find((message) => message.role === "user")?.content || "";
  const results = [];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await client.chat.completions.create({ model: MODEL, temperature: 0, messages, tools: TOOLS, tool_choice: "auto" });
    const message = response.choices?.[0]?.message;
    if (!message) return null;
    if (!message.tool_calls?.length) {
      if (!results.length) return null;
      const checked = groundToolReply(message.content || "", allowedFrom(results, question, snapshot));
      auditPostCheck({ question, original: message.content || "", kept: checked.reply, removed: checked.removed, results });
      return { reply: checked.reply || "That isn't recorded yet.", removed: checked.removed, toolsUsed: results.map((item) => item.name), rounds: round + 1 };
    }
    messages.push(message);
    for (const call of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      const output = await runTool(userId, snapshot, call.function.name, args);
      results.push({ name: call.function.name, args, output });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output).slice(0, 12000) });
    }
  }
  return { reply: "I couldn't finish looking that up. Ask again in a moment.", removed: [], toolsUsed: results.map((item) => item.name), rounds: MAX_ROUNDS };
}
