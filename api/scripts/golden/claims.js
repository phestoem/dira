// Claims scoring: a set's expected claims (test/extraction/<set>.expect.json, format in docs/knowledge-layer.md)
// against the stored claims, per domain. Pure: callers pass entities and claims as plain rows.
import { DOMAINS, INVERSES, PREDICATES, domainOf } from "../../src/services/knowledge/vocabulary.js";

const STOP = new Set(["the", "a", "an", "my", "our", "of", "to", "for", "and", "in", "on", "at", "s", "is", "will", "be", "mr", "mrs", "ms", "dr"]);
const words = (text) => String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word && !STOP.has(word));

// How well an expected name fits an entity: 3 exact name, 2 exact alias, 1.5 the entity's name holds every expected
// word ("Oslo house" in "house build on Oslo plot"), 1 the expected name holds the entity's ("Oslo" in "Oslo house"),
// 0.8 at least 70% of three or more expected words, 0 no match. Ties go to the entity with fewest extra words.
function nameFit(expected, entity) {
  const want = words(expected).join(" ");
  if (!want) return { fit: 0, extra: 0 };
  let best = { fit: 0, extra: Infinity };
  for (const [index, name] of [entity.name, ...(entity.aliases || [])].entries()) {
    const have = words(name);
    if (have.join(" ") === want) return { fit: index === 0 ? 3 : 2, extra: 0 };
    const a = want.split(" ");
    const [short, long] = a.length <= have.length ? [a, have] : [have, a];
    if (short.length && short.every((word) => long.includes(word))) {
      const fit = short === a ? 1.5 : 1;
      const extra = long.length - short.length;
      if (fit > best.fit || (fit === best.fit && extra < best.extra)) best = { fit, extra };
    } else if (a.length >= 3) {
      // Two writers naming one thing: most of the expected words are there ("CNH renewal appointment at Detran" /
      // "driver's licence (CNH) renewal appointment").
      const shared = a.filter((word) => have.includes(word)).length;
      if (shared / a.length >= 0.7 && best.fit < 0.8) best = { fit: 0.8, extra: have.length - shared };
    }
  }
  return best;
}

export function resolver(entities, selfId) {
  const cache = new Map();
  return (name) => {
    if (name == null) return [];
    if (name === "me") return selfId ? [selfId] : [];
    if (cache.has(name)) return cache.get(name);
    const scored = entities.map((entity) => ({ id: entity.id, ...nameFit(name, entity) })).filter((item) => item.fit > 0);
    const top = Math.max(0, ...scored.map((item) => item.fit));
    const pool = scored.filter((item) => item.fit === top);
    const fewest = Math.min(Infinity, ...pool.map((item) => item.extra));
    const ids = pool.filter((item) => item.extra === fewest).map((item) => item.id);
    cache.set(name, ids);
    return ids;
  };
}

// Dates compare at the expected precision, and the stored one must not claim more or less than was said.
export function formatDate(value, precision) {
  if (!value) return null;
  const iso = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  return { year: iso.slice(0, 4), month: iso.slice(0, 7), day: iso }[precision || "day"] || iso;
}
const sameDate = (expected, stored) => stored != null && String(stored) === String(expected);

// Free text (plans, decisions, statuses, values): most of the expected content words appear in the stored text.
function sameText(expected, stored) {
  const want = words(expected);
  if (!want.length) return true;
  const have = new Set(words(stored));
  return want.filter((word) => have.has(word)).length / want.length >= 0.6;
}

const sameAmount = (expected, stored) => stored != null && Math.abs(Number(stored) - expected) <= Math.max(1, expected * 0.005);
const sameCurrency = (expected, stored) => !stored || String(stored).toUpperCase() === expected.toUpperCase();

// A stored claim as comparable fields; inverse predicates are turned around once, here.
function canonical(claim) {
  const out = {
    id: claim.id,
    subjectId: claim.subjectId,
    predicate: claim.predicate,
    objectId: claim.objectId || null,
    value: claim.value ?? null,
    label: claim.label ?? null,
    amount: claim.amount == null ? null : Number(claim.amount),
    currency: claim.currency || null,
    contextId: claim.contextId || null,
    date: formatDate(claim.date, claim.datePrecision),
    until: formatDate(claim.until, claim.untilPrecision),
    status: claim.status || "stated",
  };
  const inverse = INVERSES[out.predicate];
  if (inverse && out.objectId) return { ...out, predicate: inverse, subjectId: out.objectId, objectId: out.subjectId };
  return out;
}

function wantedOf(fact) {
  const inverse = INVERSES[fact.predicate];
  if (inverse && fact.object) return { ...fact, predicate: inverse, subject: fact.object, object: fact.subject };
  return fact;
}

// Equivalences that are part of the design, not leniency for one set: plans, intentions and decisions are one family;
// owning follows from a purchase (and ends with a sale), so an expected owns is met by the bought/sold that states it.
// Further families where two writers legitimately pick different words for one fact: a contractor's work on a
// project (contractor_for / works_on), a document's next date (expires_on / renews_on), an event's date
// (happened / scheduled).
const FAMILY = {
  plans: "intent", intends: "intent", decided: "intent",
  contractor_for: "works", works_on: "works",
  expires_on: "renewal", renews_on: "renewal",
  happened: "when", scheduled: "when",
};
const samePredicate = (a, b) => a === b || (FAMILY[a] && FAMILY[a] === FAMILY[b]);
// Kin and free relations whose label carries the direction ("godmother", "wet nurse") read the same both ways.
const EITHER_WAY = new Set(["relative_of", "related_to"]);

// Expectations that restate a stored fact in another shape may share that claim instead of using it up: an owns met
// by the bought/sold that states it, and a works_on next to the contractor_for for the same work.
function sharedMatch(fact, claim, ids) {
  if (ownershipMatch(fact, claim, ids)) return true;
  if (FAMILY[fact.predicate] !== "works" || FAMILY[claim.predicate] !== "works") return false;
  return ids(fact.subject).includes(claim.subjectId) && ids(fact.object).includes(claim.objectId);
}

function ownershipMatch(fact, claim, ids) {
  if (fact.predicate !== "owns" || !fact.object) return false;
  if (!ids(fact.subject).includes(claim.subjectId) || !ids(fact.object).includes(claim.objectId)) return false;
  if (fact.until) return claim.predicate === "sold" && sameDate(fact.until, claim.date);
  // A corrected price does not undo the purchase, so a superseded bought still shows the ownership.
  return claim.predicate === "bought" && (!fact.date || sameDate(fact.date, claim.date));
}

function matches(fact, claim, ids) {
  if (!samePredicate(claim.predicate, fact.predicate)) return false;
  const symmetric = PREDICATES[fact.predicate]?.symmetric || EITHER_WAY.has(fact.predicate);
  // (predicate family members share one shape, so the rest of the comparison is the same)
  const subjects = ids(fact.subject);
  if (fact.object) {
    const objects = ids(fact.object);
    const forward = subjects.includes(claim.subjectId) && objects.includes(claim.objectId);
    const backward = symmetric && objects.includes(claim.subjectId) && subjects.includes(claim.objectId);
    if (!forward && !backward) return false;
  } else if (!subjects.includes(claim.subjectId)) return false;
  // With an amount, the amount is the fact; a value beside it is only a description ("quote (builder)").
  if (fact.value != null && fact.amount == null) {
    const kind = PREDICATES[fact.predicate]?.object;
    // Date values are stored as ISO text at the stated precision (2026, 2026-12, 2026-12-31), so equal text.
    const ok = kind === "date" ? sameDate(fact.value, claim.value)
      : /^\d+(\.\d+)?$/.test(String(fact.value)) ? Number(String(claim.value).replace(/[^\d.]/g, "")) === Number(fact.value)
        : sameText(fact.value, claim.value) || sameText(fact.value, claim.label);
    if (!ok) return false;
  }
  if (fact.amount != null && !(sameAmount(fact.amount, claim.amount) && sameCurrency(fact.currency || "", claim.currency))) return false;
  // A plan's target date may sit in its words ("move in January 2027") rather than in `date`.
  const dateInValue = FAMILY[fact.predicate] && !claim.date && String(claim.value || "").includes(String(fact.date || "").slice(0, 4));
  if (fact.date && !sameDate(fact.date, claim.date) && !dateInValue) return false;
  if (fact.until && !sameDate(fact.until, claim.until)) return false;
  // Context ("what for") is not scored: writers name it differently ("launch costs" / the company) and it never
  // changes whether the fact itself was stored.
  if (fact.status === "superseded" && claim.status !== "superseded") return false;
  if (fact.status !== "superseded" && ["superseded", "rejected"].includes(claim.status)) return false;
  return true;
}

// expect: { claims }; entities: [{ id, name, aliases }]; claims: stored rows; selfId: the narrator's entity.
// Returns per-domain tp/fn/fp, recall and precision, plus the misses and extras for sets that may be inspected.
export function scoreClaims({ expect, entities, claims, selfId }) {
  const ids = resolver(entities, selfId);
  const stored = claims.map(canonical);
  const used = new Set();
  const byDomain = Object.fromEntries(DOMAINS.map((domain) => [domain, { tp: 0, fn: 0, fp: 0 }]));
  const missed = [];
  for (const raw of expect.claims) {
    const fact = wantedOf(raw);
    const domain = (fact.predicate === "related_to" && DOMAINS.includes(raw.domain) ? raw.domain : domainOf(fact.predicate)) || "people";
    const index = stored.findIndex((claim, at) => !used.has(at) && matches(fact, claim, ids));
    // An owns met by the purchase or sale that states it shares that claim instead of using it up.
    const derived = index < 0 ? stored.findIndex((claim) => sharedMatch(fact, claim, ids) && claim.status !== "rejected") : -1;
    if (index >= 0) { used.add(index); byDomain[domain].tp += 1; } else if (derived >= 0) byDomain[domain].tp += 1;
    else { byDomain[domain].fn += 1; missed.push(raw); }
  }
  const extra = [];
  stored.forEach((claim, at) => {
    if (used.has(at) || claim.status === "rejected") return;
    const domain = domainOf(claim.predicate) || "people";
    byDomain[domain].fp += 1;
    extra.push(claim);
  });
  const rate = (a, b) => (b ? a / b : null);
  for (const value of Object.values(byDomain)) Object.assign(value, { recall: rate(value.tp, value.tp + value.fn), precision: rate(value.tp, value.tp + value.fp) });
  const total = Object.values(byDomain).reduce((sum, value) => ({ tp: sum.tp + value.tp, fn: sum.fn + value.fn, fp: sum.fp + value.fp }), { tp: 0, fn: 0, fp: 0 });
  Object.assign(total, { recall: rate(total.tp, total.tp + total.fn), precision: rate(total.tp, total.tp + total.fp) });
  return { claims: expect.claims.length, total, byDomain, missed, extra };
}

// The phase 2 gate: recall >= 85% overall, no scored domain below 70%, nothing dropped at routing.
export function gate(score, droppedAtRouting) {
  const low = Object.entries(score.byDomain).filter(([, value]) => value.tp + value.fn > 0 && value.recall < 0.7).map(([domain]) => domain);
  return { pass: score.total.recall >= 0.85 && !low.length && droppedAtRouting === 0, recall: score.total.recall, lowDomains: low, droppedAtRouting };
}
