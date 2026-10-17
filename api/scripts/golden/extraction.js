// Extraction scoring: what a set's seed sentences should store (test/extraction/<set>.expect.json) against what the
// stored graph holds after seeding, with every missed fact traced to the stage that lost it.
import { normalizeName } from "../../src/services/graph/entityResolver.js";
import { links, matchesKind } from "../../src/services/graph/peopleTools.js";

// Most specific first: a half-sister is a half_sibling, not a sibling.
const KINDS = [
  "former_spouse", "half_sibling", "step_parent", "step_child", "step_sibling", "parent_in_law", "child_in_law", "sibling_in_law",
  "spouse", "parent", "child", "sibling", "grandparent", "grandchild", "aunt_uncle", "niece_nephew", "cousin",
  "godparent", "godchild", "friend", "neighbour", "colleague", "other_relative",
];
const DATE_KINDS = ["born", "died", "married", "divorced"];

// "Cian" matches "Cian Byrne" (same first word, one name inside the other); aliases count.
export function sameName(expected, entity) {
  const want = normalizeName(expected).split(" ").filter(Boolean);
  return [entity.name, ...(entity.aliases || [])].some((name) => {
    const have = normalizeName(name).split(" ").filter(Boolean);
    if (!want.length || !have.length || want[0] !== have[0]) return false;
    const [short, long] = want.length <= have.length ? [want, have] : [have, want];
    return short.every((word) => long.includes(word));
  });
}

export function routeOf(steps) {
  const [intent] = String(steps[0] || "").split("/");
  if (steps.includes("NOT SAVED")) return intent === "question" || intent === "graph_query" ? "question" : "dropped";
  if (intent === "relationship_add") return "relationship_add";
  if (intent === "intake_text") return "intake";
  if (/journal/.test(steps.join(" "))) return "journal";
  return intent || "dropped";
}

const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : null);
const sameDate = (expected, stored) => Boolean(stored) && (expected.length === 4 ? stored.slice(0, 4) === expected : stored === expected);

function pairKey(a, rel, b) {
  if (rel === "child") return pairKey(b, "parent", a);
  if (["spouse", "former_spouse", "sibling"].includes(rel)) return [rel, ...[a, b].sort()].join("|");
  return [rel, a, b].join("|");
}

// Each trace entry's people as flat facts, before (raw) and after (kept) validation, for either extractor: who,
// their relation and to whom, and every date stated for them.
function traceFacts(entry, stage) {
  const value = entry[stage];
  const out = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item?.name) continue;
      out.push({ person: item.name, relation: item.relation || null, of: item.relationOf || "narrator", dates: [item.birthDate, item.deathDate, item.marriageDate, item.endDate].filter(Boolean).map(String) });
    }
  } else if (value && typeof value === "object") {
    for (const item of value.people || []) if (item?.name) out.push({ person: item.name, relation: null, of: null, dates: [] });
    for (const item of value.relations || []) if (item?.person) out.push({ person: item.person, relation: item.relation || null, of: item.of || "narrator", dates: [] });
    for (const item of value.dates || []) {
      const dates = [item?.value || item?.date].filter(Boolean).map(String);
      for (const person of [item?.person, item?.with]) if (person) out.push({ person, relation: null, of: null, dates });
    }
  }
  return out;
}

// Does this stage hold the fact at all (person named, a relation to the right person, or the date)? Whether the
// relation word was the right one is judged by the stored graph, not here.
function holds(facts, fact) {
  const mine = facts.filter((item) => sameName(fact.person, { name: item.person }));
  if (!mine.length) return { named: false, has: false };
  if (fact.relation) {
    const of = fact.of || "narrator";
    const toOf = (item) => (of === "narrator" ? !item.of || ["narrator", "self"].includes(String(item.of).toLowerCase()) : item.of && sameName(of, { name: item.of }));
    return { named: true, has: mine.some((item) => item.relation && toOf(item)) };
  }
  const kind = DATE_KINDS.find((name) => fact[name]);
  const wanted = fact[kind];
  return { named: true, has: mine.some((item) => item.dates.some((date) => date === wanted || date.slice(0, 4) === wanted || date === wanted.slice(0, 4))) };
}

export function scoreExtraction({ expect, seeds, routes, snapshot, traces }) {
  const people = snapshot.entities.filter((entity) => entity.entityType === "person" && !entity.isSelf);
  const find = (name) => people.filter((entity) => sameName(name, entity));
  const tally = {};
  const bump = (key, field) => { (tally[key] ||= { tp: 0, fp: 0, fn: 0 })[field] += 1; };

  // Stored facts, typed the same way as the expectations.
  const stored = { narrator: [], pairs: [], dates: [] };
  for (const link of links(snapshot)) {
    stored.narrator.push({ id: link.id, kind: KINDS.find((kind) => matchesKind(link, kind)) || "unknown" });
    if (link.relation === "spouse" || link.relation === "former_spouse") {
      if (link.married) stored.dates.push({ id: link.id, kind: "married", value: String(link.married) });
      if (link.ended && link.ended !== "yes") stored.dates.push({ id: link.id, kind: "divorced", value: String(link.ended) });
    }
  }
  const selfId = snapshot.self?.id;
  for (const edge of snapshot.edges) {
    if (edge.category !== "family" || edge.fromId === selfId || edge.toId === selfId) continue;
    const ended = Boolean(edge.validTo || edge.attributes?.ended);
    const rel = { spouse_of: ended ? "former_spouse" : "spouse", sibling_of: "sibling", parent_of: "parent", child_of: "child" }[edge.type];
    if (rel) stored.pairs.push({ key: pairKey(edge.fromId, rel, edge.toId), rel: rel === "child" ? "parent" : rel, label: `${snapshot.byId.get(edge.fromId)?.name} ${edge.type} ${snapshot.byId.get(edge.toId)?.name}` });
  }
  for (const entity of people) {
    if (entity.birthDate) stored.dates.push({ id: entity.id, kind: "born", value: day(entity.birthDate) });
    if (entity.deathDate) stored.dates.push({ id: entity.id, kind: "died", value: day(entity.deathDate) });
  }

  const matched = { narrator: new Set(), pairs: new Set(), dates: new Set() };
  const missed = [];
  for (const fact of expect.facts) {
    const ids = find(fact.person).map((entity) => entity.id);
    let hit = -1;
    let key;
    if (fact.relation && !fact.of) {
      key = fact.relation;
      hit = stored.narrator.findIndex((item, index) => !matched.narrator.has(index) && ids.includes(item.id) && item.kind === fact.relation);
      if (hit >= 0) matched.narrator.add(hit);
    } else if (fact.relation) {
      const rel = fact.relation === "child" ? "parent" : fact.relation;
      key = `pair:${rel}`;
      const others = find(fact.of).map((entity) => entity.id);
      const wanted = new Set(ids.flatMap((a) => others.map((b) => pairKey(a, fact.relation, b))));
      hit = stored.pairs.findIndex((item, index) => !matched.pairs.has(index) && wanted.has(item.key));
      if (hit >= 0) matched.pairs.add(hit);
    } else {
      const kind = DATE_KINDS.find((name) => fact[name]);
      key = `date:${kind}`;
      hit = stored.dates.findIndex((item, index) => !matched.dates.has(index) && ids.includes(item.id) && item.kind === kind && sameDate(fact[kind], item.value));
      if (hit >= 0) matched.dates.add(hit);
    }
    bump(key, hit >= 0 ? "tp" : "fn");
    if (hit < 0) missed.push({ fact, key, stage: lostAt(fact, seeds, routes, traces) });
  }
  const extra = [];
  const name = (id) => snapshot.byId.get(id)?.name;
  stored.narrator.forEach((item, index) => matched.narrator.has(index) || (bump(item.kind, "fp"), extra.push(`${name(item.id)}: ${item.kind}`)));
  stored.pairs.forEach((item, index) => matched.pairs.has(index) || (bump(`pair:${item.rel}`, "fp"), extra.push(item.label)));
  stored.dates.forEach((item, index) => matched.dates.has(index) || (bump(`date:${item.kind}`, "fp"), extra.push(`${name(item.id)}: ${item.kind} ${item.value}`)));

  // People: every distinct name the expectations mention, against every stored person (duplicates count against).
  const expectedNames = [];
  for (const name of expect.facts.flatMap((fact) => [fact.person, fact.of].filter(Boolean))) {
    if (!expectedNames.some((known) => sameName(name, { name: known }))) expectedNames.push(name);
  }
  const usedIds = new Set();
  const peopleScore = { tp: 0, fp: 0, fn: 0 };
  for (const name of expectedNames) {
    const entity = people.find((item) => !usedIds.has(item.id) && sameName(name, item));
    if (entity) { usedIds.add(entity.id); peopleScore.tp += 1; } else peopleScore.fn += 1;
  }
  peopleScore.fp = people.length - usedIds.size;

  const routing = {};
  routes.forEach((route) => { routing[route] = (routing[route] || 0) + 1; });
  const validationDrops = {};
  for (const entry of traces) for (const item of entry.dropped || []) validationDrops[item.reason] = (validationDrops[item.reason] || 0) + 1;
  const lost = {};
  missed.forEach((item) => { lost[item.stage] = (lost[item.stage] || 0) + 1; });
  return { facts: expect.facts.length, byType: tally, people: peopleScore, routing, validationDrops, lost, missed, extra, extraPeople: people.filter((entity) => !usedIds.has(entity.id)).map((entity) => entity.name) };
}

// The first stage that lost a fact: the seed never saved, no extraction ran on it, the model never stated it (or
// never named the person), validation removed it, or it survived validation but the graph doesn't hold it (wrong
// relation word, merged into the wrong person, or lost when saving).
function lostAt(fact, seeds, routes, traces) {
  if (["question", "dropped"].includes(routes[fact.seed])) return "routing";
  const text = normalizeName(seeds[fact.seed]);
  const entries = traces.filter((entry) => normalizeName(entry.text).includes(text));
  if (!entries.length) return "no-extraction";
  const raw = holds(entries.flatMap((entry) => traceFacts(entry, "raw")), fact);
  if (!raw.has) return raw.named ? "not-extracted:fact" : "not-extracted:person";
  const kept = holds(entries.flatMap((entry) => traceFacts(entry, "kept")), fact);
  if (!kept.has) return kept.named ? "validation:fact" : "validation:person";
  return "kept-not-stored";
}

const ratio = (a, b) => (b ? a / b : null);
export function precisionRecall({ tp, fp, fn }) {
  return { precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
}
