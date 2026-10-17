import OpenAI from "openai";
import { normalizeName } from "./entityResolver.js";
import { kinOf } from "./kinship.js";
import { RELATIONS } from "./peopleSchema.js";
import { answerWithTools, assetsAsOf, day, edgeDay, findByName, links, loadSnapshot, matchesKind } from "./peopleTools.js";

// PEOPLE_ENGINE=hybrid answering: the model only picks one tool and its arguments. List, count, date, family-tree,
// "who is" and asset tools return the final answer, formatted by code from stored facts; the model never rewrites
// it. Open questions go to the tools agent, whose reply is post-checked. No question wording is parsed in code.
const MODEL = "gpt-4o-mini";
const PICK = { type: "string", enum: ["all", "eldest", "youngest"] };

const TOOLS = [
  tool("list_people", "List the narrator's people with one relation (\"all\" for everyone); pick eldest/youngest for questions like \"who is my youngest child\". \"sibling\" includes half-siblings.", { relation: { type: "string", enum: ["all", ...RELATIONS] }, pick: PICK }, ["relation", "pick"]),
  tool("count_people", "How many people the narrator has with one relation.", { relation: { type: "string", enum: RELATIONS } }, ["relation"]),
  tool("person_dates", "Birth, death, marriage or divorce dates. person is a name only; for \"my sister\" leave person \"\" and give the relation to the narrator (person \"\"), or person \"narrator\" for the narrator's own dates; \"when did I marry\" is relation spouse, event marriage.", { person: { type: "string" }, relation: { type: "string", enum: ["none", ...RELATIONS] }, pick: PICK, event: { type: "string", enum: ["all", "birth", "death", "marriage", "divorce"] } }, ["person", "relation", "pick", "event"]),
  tool("family_tree", "The narrator's whole recorded family.", {}, []),
  tool("who_is", "Who one named person is to the narrator.", { name: { type: "string" } }, ["name"]),
  tool("owned_assets", "Property, land, vehicles and other assets the narrator holds on a date. as_of is YYYY-MM-DD; use today for \"now\".", { as_of: { type: "string" } }, ["as_of"]),
  tool("open_question", "Anything about the narrator's people or assets the other tools can't answer directly: how two people are connected, telling about the family, explanations.", {}, []),
];

function tool(name, description, properties, required) {
  return { type: "function", function: { name, description, parameters: { type: "object", additionalProperties: false, properties, required } } };
}

function systemPrompt(selfName, today) {
  return `You route the narrator's questions about their family, the people in their life and their assets to exactly one tool.
The narrator is ${selfName}. Today is ${today}.
Call one tool with its arguments; do not answer yourself. If the question is not about people or assets, call no tool.`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// ISO dates read as "9 January 2007"; a bare year stays a bare year.
export function formatDate(value) {
  const text = String(value || "");
  const full = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (full) return `${Number(full[3])} ${MONTHS[Number(full[2]) - 1]} ${full[1]}`;
  return /^\d{4}$/.test(text) ? text : null;
}

export function joinNames(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const RELATION_WORDS = {
  parent: "parents", child: "children", sibling: "siblings", half_sibling: "half-siblings", step_parent: "step-parents", step_child: "stepchildren",
  step_sibling: "step-siblings", spouse: "spouse", former_spouse: "former spouses", partner: "partner", grandparent: "grandparents",
  grandchild: "grandchildren", aunt_uncle: "aunts and uncles", niece_nephew: "nieces and nephews", cousin: "cousins", parent_in_law: "parents-in-law",
  child_in_law: "children-in-law", sibling_in_law: "siblings-in-law", godparent: "godparents", godchild: "godchildren", friend: "friends",
  neighbour: "neighbours", colleague: "colleagues", other_relative: "other relatives", all: "people",
};

// One person as a list item: name, then the role word when it says more than the list heading, then flags.
function describe(link, generic) {
  const notes = [];
  if (link.role && normalizeName(link.role) !== normalizeName(generic || "") && link.role !== link.relation) notes.push(link.role);
  if (link.died) notes.push(`died ${formatDate(link.died)}`);
  if (link.unconfirmed) notes.push("unconfirmed");
  return notes.length ? `${link.name} (${notes.join(", ")})` : link.name;
}

// Close family of any person, read from the edges: parents, children, siblings, current spouses.
function familyOf(snapshot, id, relation) {
  const out = new Set();
  for (const edge of snapshot.edges) {
    if (edge.category !== "family" || (edge.fromId !== id && edge.toId !== id)) continue;
    const other = edge.fromId === id ? edge.toId : edge.fromId;
    const from = edge.fromId === id;
    const kind = edge.type === "parent_of" ? (from ? "child" : "parent") : edge.type === "child_of" ? (from ? "parent" : "child") : edge.type === "sibling_of" ? "sibling" : edge.type === "spouse_of" && !edge.validTo && !edge.attributes?.ended ? "spouse" : null;
    if (kind === relation) out.add(other);
  }
  return [...out];
}

// In-laws are rarely stated as such; they follow from the graph: a spouse's parents and siblings, a sibling's
// spouse, a child's spouse. Stated in-law links come first and are not repeated.
const IN_LAW_PATHS = { parent_in_law: [["spouse", "parent"]], sibling_in_law: [["spouse", "sibling"], ["sibling", "spouse"]], child_in_law: [["child", "spouse"]] };
const IN_LAW_ROLE = { parent_in_law: "parent-in-law", sibling_in_law: "sibling-in-law", child_in_law: "child-in-law" };

function derivedInLaws(snapshot, relation, stated) {
  const selfId = snapshot.self?.id;
  const seen = new Set([selfId, ...stated.map((link) => link.id)]);
  const out = [];
  for (const [first, second] of IN_LAW_PATHS[relation] || []) {
    for (const middle of familyOf(snapshot, selfId, first)) {
      for (const id of familyOf(snapshot, middle, second)) {
        const entity = snapshot.byId.get(id);
        if (!entity || seen.has(id)) continue;
        seen.add(id);
        out.push({ name: entity.name, born: day(entity.birthDate), died: day(entity.deathDate), relation, role: IN_LAW_ROLE[relation], unconfirmed: false, id });
      }
    }
  }
  return out;
}

function peopleWith(snapshot, relation) {
  const all = links(snapshot);
  if (relation === "sibling") return all.filter((link) => matchesKind(link, "sibling") || matchesKind(link, "half_sibling"));
  const stated = all.filter((link) => matchesKind(link, relation));
  return IN_LAW_PATHS[relation] ? [...stated, ...derivedInLaws(snapshot, relation, stated)] : stated;
}

// The model sometimes passes a role word ("half-sister") where a name goes. With no one of that name, it means the
// narrator's people whose stored role is that kind of relative.
function peopleByRole(snapshot, word) {
  const wanted = kinOf(word);
  if (!wanted) return [];
  const same = (role) => {
    const kin = kinOf(role);
    return kin && kin.group === wanted.group && kin.half === wanted.half && kin.step === wanted.step && kin.inLaw === wanted.inLaw && kin.ex === wanted.ex && (!wanted.gender || !kin.gender || kin.gender === wanted.gender);
  };
  return links(snapshot).filter((link) => same(link.role) || (link.relation === wanted.group && !wanted.half && !wanted.step && !wanted.inLaw && (!wanted.gender || kinOf(link.role)?.gender !== (wanted.gender === "female" ? "male" : "female"))));
}

function pickBy(people, pick) {
  if (pick === "all" || !pick) return { people };
  const dated = people.filter((link) => link.born).sort((a, b) => a.born.localeCompare(b.born));
  if (!dated.length) return { people, undated: true };
  return { people: [pick === "eldest" ? dated[0] : dated.at(-1)] };
}

function listPeople(snapshot, { relation, pick }) {
  const word = RELATION_WORDS[relation] || relation;
  const { people, undated } = pickBy(peopleWith(snapshot, relation), pick);
  if (!people.length) return { reply: `No ${word} are recorded yet.` };
  if (undated) return { reply: `Birth dates aren't recorded for your ${word}, so I can't tell who is ${pick}. Recorded: ${joinNames(people.map((link) => describe(link, word)))}.` };
  if (pick && pick !== "all") {
    const [person] = people;
    return { reply: `${describe(person, word)} is the ${pick}, born ${formatDate(person.born)}.` };
  }
  return { reply: `Your ${word}: ${joinNames(people.map((link) => describe(link, word)))}.` };
}

function countPeople(snapshot, { relation }) {
  const people = peopleWith(snapshot, relation);
  const word = RELATION_WORDS[relation] || relation;
  if (!people.length) return { reply: `No ${word} are recorded yet.` };
  return { reply: `You have ${people.length} recorded ${people.length === 1 ? relation.replaceAll("_", " ") : word}: ${joinNames(people.map((link) => describe(link, word)))}.` };
}

function ambiguity(snapshot, name, found) {
  const all = links(snapshot);
  const options = found.map((entity) => {
    const link = all.find((item) => item.id === entity.id);
    return link ? `${entity.name} (your ${link.role})` : entity.name;
  });
  return { reply: `Which ${name} do you mean: ${joinNames(options)}?` };
}

// Marriages of one person, from their spouse edges: the other party, the date, and how it ended.
function marriagesOf(snapshot, entity) {
  return snapshot.edges
    .filter((edge) => edge.type === "spouse_of" && (edge.fromId === entity.id || edge.toId === entity.id))
    .map((edge) => ({ other: snapshot.byId.get(edge.fromId === entity.id ? edge.toId : edge.fromId), married: edgeDay(edge.validFrom), ended: edge.validTo || edge.attributes?.ended ? edgeDay(edge.validTo, edge.attributes?.endPrecision) || "yes" : null }))
    .filter((item) => item.other);
}

function dateLines(snapshot, entity, event) {
  const self = entity.id === snapshot.self?.id;
  const who = self ? "You" : entity.name;
  const lines = [];
  const missing = [];
  const born = day(entity.birthDate);
  const died = day(entity.deathDate);
  if (["all", "birth"].includes(event)) born ? lines.push(`${who} ${self ? "were" : "was"} born on ${formatDate(born)}.`) : missing.push("birth date");
  if (["all", "death"].includes(event) && (died || event === "death")) died ? lines.push(`${who} died on ${formatDate(died)}.`) : missing.push("date of death");
  if (["all", "marriage", "divorce"].includes(event)) {
    const marriages = marriagesOf(snapshot, entity);
    for (const marriage of marriages) {
      const pair = marriage.other.isSelf ? `You married ${entity.name}` : self ? `You married ${marriage.other.name}` : `${entity.name} married ${marriage.other.name}`;
      if (event !== "divorce") marriage.married ? lines.push(`${pair} ${marriage.married.length === 4 ? "in" : "on"} ${formatDate(marriage.married)}.`) : missing.push(`date of the marriage to ${marriage.other.isSelf ? "you" : marriage.other.name}`);
      const whose = marriage.other.isSelf ? `Your marriage to ${entity.name}` : self ? `Your marriage to ${marriage.other.name}` : `${entity.name}'s marriage to ${marriage.other.name}`;
      if (event !== "marriage" && marriage.ended) lines.push(marriage.ended === "yes" ? `${whose} has ended; the date isn't recorded.` : `${whose} ended ${marriage.ended.length === 4 ? "in" : "on"} ${formatDate(marriage.ended)}.`);
    }
    if (!marriages.length && event !== "all") missing.push("marriage");
  }
  if (!lines.length) return `${self ? "Your" : `${entity.name}'s`} ${joinNames(missing) || "dates"} ${missing.length > 1 ? "aren't" : "isn't"} recorded yet.`;
  return lines.join(" ");
}

function personDates(snapshot, { person, relation, pick, event }) {
  const name = String(person || "").trim();
  const narrator = ["narrator", "me", "i", "myself"].includes(normalizeName(name));
  let targets = [];
  if (name && !narrator) {
    const found = findByName(snapshot, name);
    if (found.length > 1) return ambiguity(snapshot, name, found);
    const byRole = found.length ? [] : pickBy(peopleByRole(snapshot, name), pick).people;
    if (!found.length && !byRole.length) return { reply: kinOf(name) ? `No ${name} is recorded yet.` : `I have no one called ${name} recorded.` };
    targets = found.length ? found : byRole.map((link) => snapshot.byId.get(link.id)).filter(Boolean);
  } else if (relation && relation !== "none") {
    const word = RELATION_WORDS[relation] || relation;
    const { people, undated } = pickBy(peopleWith(snapshot, relation), pick);
    if (!people.length) return { reply: `No ${word} are recorded yet.` };
    if (undated) return { reply: `Birth dates aren't recorded for your ${word}, so I can't tell who is ${pick}.` };
    targets = people.map((link) => snapshot.byId.get(link.id)).filter(Boolean);
  } else if (snapshot.self) {
    // The narrator's own spouse edges carry their marriages, so "when did I get married" lands here too.
    targets = [snapshot.self];
  }
  if (!targets.length) return null;
  return { reply: targets.map((entity) => dateLines(snapshot, entity, event)).join(" ") };
}

const TREE_ORDER = ["parent", "spouse", "former_spouse", "sibling", "child", "grandparent", "grandchild", "relative"];
const TREE_HEADINGS = { parent: "Parents", spouse: "Spouse", former_spouse: "Former spouse", sibling: "Siblings", child: "Children", grandparent: "Grandparents", grandchild: "Grandchildren", relative: "Other relatives" };

function familyTree(snapshot) {
  const groups = {};
  for (const link of links(snapshot)) {
    if (!TREE_ORDER.includes(link.relation) || kinOf(link.role)?.group === "social") continue;
    (groups[link.relation] ||= []).push(link);
  }
  const lines = TREE_ORDER.filter((relation) => groups[relation]?.length).map((relation) => `- ${TREE_HEADINGS[relation]}: ${groups[relation].map((link) => describe(link, relation)).join(", ")}`);
  if (!lines.length) return { reply: "No family is recorded yet." };
  return { reply: `Your family:\n${lines.join("\n")}` };
}

function whoIs(snapshot, { name }) {
  const found = findByName(snapshot, name);
  if (found.length > 1) return ambiguity(snapshot, name, found);
  if (!found.length && kinOf(name)) {
    const people = peopleByRole(snapshot, name);
    return { reply: people.length ? `Your ${name}: ${joinNames(people.map((link) => describe(link, name)))}.` : `No ${name} is recorded yet.` };
  }
  if (!found.length) return { reply: `I have no one called ${name} recorded.` };
  const [entity] = found;
  if (entity.isSelf) return { reply: `${entity.name} is you.` };
  const link = links(snapshot).find((item) => item.id === entity.id);
  // Not linked to the narrator directly: how they connect is an open question.
  if (!link) return null;
  const notes = [link.born ? `born ${formatDate(link.born)}` : null, link.died ? `died ${formatDate(link.died)}` : null].filter(Boolean);
  const role = link.relation === "former_spouse" ? `former ${link.role}` : link.role;
  return { reply: `${entity.name} is your ${role}${link.unconfirmed ? " (unconfirmed)" : ""}${notes.length ? `, ${notes.join(", ")}` : ""}.` };
}

async function ownedAssets(userId, snapshot, { as_of: asOf }) {
  const { as_of: date, ownership } = await assetsAsOf(userId, snapshot, asOf);
  const held = ownership.filter((item) => item.owner === "narrator" && item.held_on_date && item.asset_type !== "person");
  // No ownership facts: the records may still say, and reading them is the open path's job.
  if (!held.length) return null;
  const seen = new Set();
  const lines = [];
  for (const item of held) {
    if (seen.has(item.asset)) continue;
    seen.add(item.asset);
    const notes = [item.from ? `since ${formatDate(item.from)}` : null, item.unconfirmed ? "unconfirmed" : null].filter(Boolean);
    lines.push(`- ${item.asset}${notes.length ? ` (${notes.join(", ")})` : ""}`);
  }
  return { reply: `As of ${formatDate(date)} you hold:\n${lines.join("\n")}` };
}

export async function runHybridTool(userId, snapshot, name, args) {
  if (name === "list_people") return listPeople(snapshot, args);
  if (name === "count_people") return countPeople(snapshot, args);
  if (name === "person_dates") return personDates(snapshot, args);
  if (name === "family_tree") return familyTree(snapshot);
  if (name === "who_is") return whoIs(snapshot, args);
  if (name === "owned_assets") return ownedAssets(userId, snapshot, args);
  return null;
}

// Returns null when the model routes the question to no tool; the general advisor answers it then.
export async function answerWithHybrid(userId, history) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const client = new OpenAI({ apiKey: key, timeout: 30000 });
  const snapshot = await loadSnapshot(userId);
  const today = new Date().toISOString().slice(0, 10);
  const messages = [{ role: "system", content: systemPrompt(snapshot.self?.name || "the narrator", today) }, ...history.slice(-12)];
  const response = await client.chat.completions.create({ model: MODEL, temperature: 0, messages, tools: TOOLS, tool_choice: "auto", parallel_tool_calls: false });
  const call = response.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return null;
  let args = {};
  try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
  const answered = call.function.name === "open_question" ? null : await runHybridTool(userId, snapshot, call.function.name, args);
  if (answered) return { reply: answered.reply, path: "code", toolsUsed: [call.function.name] };
  const open = await answerWithTools(userId, history);
  return open ? { ...open, path: "open", toolsUsed: [call.function.name, ...open.toolsUsed] } : null;
}
