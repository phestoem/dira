// Claims scoring: a set's expected claims (test/extraction/<set>.expect.json, format in docs/knowledge-layer.md)
// against the stored claims, per domain. Pure: callers pass entities and claims as plain rows.
import { DOMAINS, INVERSES, PREDICATES, domainOf } from "../../src/services/knowledge/vocabulary.js";

const STOP = new Set(["the", "a", "an", "my", "our", "of", "to", "for", "and", "in", "on", "at", "s", "is", "will", "be", "mr", "mrs", "ms", "dr"]);
const words = (text) => String(text || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word && !STOP.has(word));

// How well an expected name fits an entity: 3 exact name, 2 exact alias, 1 every word of the shorter inside the
// longer, 0 no match. Ties go to the entity with fewest extra words.
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
      const extra = long.length - short.length;
      if (best.fit < 1 || extra < best.extra) best = { fit: 1, extra };
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
const FAMILY = { plans: "intent", intends: "intent", decided: "intent" };
const samePredicate = (a, b) => a === b || (FAMILY[a] && FAMILY[a] === FAMILY[b]);

function ownershipMatch(fact, claim, ids) {
  if (fact.predicate !== "owns" || !fact.object) return false;
  if (!ids(fact.subject).includes(claim.subjectId) || !ids(fact.object).includes(claim.objectId)) return false;
  if (fact.until) return claim.predicate === "sold" && sameDate(fact.until, claim.date);
  // A corrected price does not undo the purchase, so a superseded bought still shows the ownership.
  return claim.predicate === "bought" && (!fact.date || sameDate(fact.date, claim.date));
}

function matches(fact, claim, ids) {
  if (ownershipMatch(fact, claim, ids)) return claim.status !== "rejected";
  if (!samePredicate(claim.predicate, fact.predicate)) return false;
  const symmetric = PREDICATES[fact.predicate]?.symmetric;
  // (predicate family members share one shape, so the rest of the comparison is the same)
  const subjects = ids(fact.subject);
  if (fact.object) {
    const objects = ids(fact.object);
    const forward = subjects.includes(claim.subjectId) && objects.includes(claim.objectId);
    const backward = symmetric && objects.includes(claim.subjectId) && subjects.includes(claim.objectId);
    if (!forward && !backward) return false;
  } else if (!subjects.includes(claim.subjectId)) return false;
  if (fact.value != null) {
    const kind = PREDICATES[fact.predicate]?.object;
    // Date values are stored as ISO text at the stated precision (2026, 2026-12, 2026-12-31), so equal text.
    const ok = kind === "date" ? sameDate(fact.value, claim.value)
      : /^\d+(\.\d+)?$/.test(String(fact.value)) ? Number(String(claim.value).replace(/[^\d.]/g, "")) === Number(fact.value)
        : sameText(fact.value, claim.value);
    if (!ok) return false;
  }
  if (fact.amount != null && !(sameAmount(fact.amount, claim.amount) && sameCurrency(fact.currency || "", claim.currency))) return false;
  if (fact.date && !sameDate(fact.date, claim.date)) return false;
  if (fact.until && !sameDate(fact.until, claim.until)) return false;
  // A missing context is a less complete claim, not a wrong one; a different context is wrong.
  if (fact.context && claim.contextId && !ids(fact.context).includes(claim.contextId)) return false;
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
    if (index >= 0) { used.add(index); byDomain[domain].tp += 1; } else { byDomain[domain].fn += 1; missed.push(raw); }
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
