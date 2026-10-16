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
async function loadSnapshot(userId) {
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true, status: { not: "archived" } } });
  const [entities, edges] = await Promise.all([
    prisma.entity.findMany({ where: { userId, status: { not: "archived" }, mergedIntoId: null }, take: 1000 }),
    prisma.relationship.findMany({ where: { userId, status: { in: ["confirmed", "suggested"] }, fromKind: "entity", toKind: "entity", OR: [{ label: null }, { label: { not: "conflict" } }] }, take: 2000 }),
  ]);
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return { self, entities, edges, byId };
}

const day = (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null);

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

function links(snapshot) {
  const selfId = snapshot.self?.id;
  const out = [];
  for (const edge of snapshot.edges) {
    if (edge.fromId !== selfId && edge.toId !== selfId) continue;
    if (!["family", "social"].includes(edge.category)) continue;
    const other = snapshot.byId.get(edge.fromId === selfId ? edge.toId : edge.fromId);
    if (!other || other.isSelf) continue;
    const { relation, role, ended } = relationToNarrator(edge, selfId, other);
    if (ended && edge.type !== "spouse_of") continue;
    out.push({ ...personSummary(snapshot, other), relation, role, unconfirmed: edge.status === "suggested", ...(edge.type === "spouse_of" ? { married: day(edge.validFrom), ended: ended ? (edge.attributes?.endPrecision === "year" ? day(edge.validTo)?.slice(0, 4) || "yes" : day(edge.validTo) || "yes") : null } : {}), id: other.id });
  }
  return out;
}

function matchesKind(link, kind) {
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

function findByName(snapshot, name) {
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
    ...(edge.validFrom ? { from: day(edge.validFrom) } : {}),
    ...(edge.validTo || edge.attributes?.ended ? { ended: day(edge.validTo) || "yes" } : {}),
    ...(edge.status === "suggested" ? { unconfirmed: true } : {}),
    about: edge.fromId === personId ? "subject" : "object",
  };
}

function personRecord(snapshot, entity) {
  const link = links(snapshot).find((item) => item.id === entity.id);
  const facts = snapshot.edges.filter((edge) => edge.fromId === entity.id || edge.toId === entity.id).map((edge) => describeEdge(snapshot, edge, entity.id)).filter(Boolean).slice(0, 25);
  return { ...personSummary(snapshot, entity), relation_to_narrator: link ? link.role : null, unconfirmed: link?.unconfirmed || false, facts };
}

async function assetsAsOf(userId, snapshot, asOf) {
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
    owned.push({ asset: asset.name, asset_type: asset.entityType, owner: owner.isSelf ? "narrator" : owner.name, relation: edge.type, from: day(edge.validFrom), until: day(edge.validTo), held_on_date: current, unconfirmed: edge.status === "suggested" });
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

// Names and dates the reply may state: everything the tools returned, plus what the question itself names.
export function allowedFrom(results, question) {
  const names = new Set();
  const dates = new Set();
  const walk = (value) => {
    if (value == null) return;
    if (value instanceof Date) {
      if (!Number.isNaN(value.getTime())) dates.add(value.toISOString().slice(0, 10));
      return;
    }
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value === "object") return Object.values(value).forEach(walk);
    const text = String(value);
    const written = datesIn(text);
    for (const iso of written.dates) dates.add(iso);
    for (const year of written.years) dates.add(year);
    for (const match of text.matchAll(/[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)*/gu)) names.add(match[0]);
  };
  walk(results);
  for (const match of String(question).matchAll(/[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)*/gu)) names.add(match[0]);
  return { allowedNames: [...names], allowedDates: dates };
}

// The post-check, in any language: a sentence naming someone the tools never returned is dropped, and a date or
// year the tools never returned is replaced. A lone capitalised word opening a sentence is grammar, not a claim.
export function groundToolReply(reply, { allowedNames, allowedDates }) {
  const known = ` ${allowedNames.map((name) => normalizeName(name)).join(" ")} `;
  const allowedYears = new Set([...allowedDates].map((value) => String(value).slice(0, 4)));
  const removed = [];
  const kept = [];
  for (const sentence of String(reply || "").split(/(?<=[.!?])\s+/).filter((part) => part.trim())) {
    const claims = [];
    for (const match of sentence.matchAll(/[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)*/gu)) {
      const words = match[0].split(/\s+/).filter((word) => !MONTH_WORDS.has(word.toLowerCase().replace(/\.$/, "")));
      if (!words.length) continue;
      const opening = sentence.slice(0, match.index).trim() === "" || /[:—-]\s*$/.test(sentence.slice(0, match.index));
      if (words.length === 1 && opening) continue;
      if (!words.every((word) => known.includes(` ${normalizeName(word)} `))) claims.push(words.join(" "));
    }
    if (claims.length) {
      removed.push(...claims);
      continue;
    }
    let next = sentence;
    const found = datesIn(sentence);
    for (const iso of found.dates) if (![...allowedDates].includes(iso)) removed.push(iso);
    if (found.dates.some((iso) => ![...allowedDates].includes(iso)) || found.years.some((year) => !allowedYears.has(year))) {
      removed.push(...found.years.filter((year) => !allowedYears.has(year)));
      next = "";
    }
    if (next) kept.push(next);
  }
  for (const claim of removed) console.log(`[advisor] removed unsupported claim: "${claim}"`);
  return { reply: kept.join(" ").replace(/\s+/g, " ").trim(), removed };
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
      const checked = groundToolReply(message.content || "", allowedFrom(results, question));
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
