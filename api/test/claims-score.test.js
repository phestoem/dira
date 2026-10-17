import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gate, resolver, scoreClaims } from "../scripts/golden/claims.js";
import { DOMAINS, PREDICATES } from "../src/services/knowledge/vocabulary.js";

// Invented life. Scoring reads stored claim rows; nothing here calls a model.
const entities = [
  { id: "self", name: "Ines Ferreira" },
  { id: "rui", name: "Rui Ferreira", aliases: ["Rui"] },
  { id: "plot", name: "Plot 44 Sintra", aliases: ["Sintra plot"] },
  { id: "sintra", name: "Sintra" },
  { id: "house", name: "Sintra house" },
  { id: "tiago", name: "Tiago Mendes" },
];

test("names resolve to the closest entity: exact, alias, then fewest extra words", () => {
  const ids = resolver(entities, "self");
  assert.deepEqual(ids("me"), ["self"]);
  assert.deepEqual(ids("Sintra"), ["sintra"]);
  assert.deepEqual(ids("the Sintra plot"), ["plot"]);
  assert.deepEqual(ids("Rui"), ["rui"]);
  assert.deepEqual(ids("Marta"), []);
});

test("claims score per domain with inverses, symmetry, precision, amounts and corrections", () => {
  const expect = { claims: [
    { seed: 0, subject: "Rui Ferreira", predicate: "sibling_of", object: "me" },
    { seed: 1, subject: "me", predicate: "paid", object: "Tiago Mendes", amount: 12000, currency: "EUR", date: "2024-03", context: "Sintra house" },
    { seed: 2, subject: "me", predicate: "bought", object: "Sintra plot", amount: 90000, currency: "EUR", status: "superseded" },
    { seed: 3, subject: "me", predicate: "bought", object: "Sintra plot", amount: 85000, currency: "EUR" },
    { seed: 4, subject: "Sintra house", predicate: "due_on", value: "2026-12" },
    { seed: 5, subject: "me", predicate: "plans", value: "move into the Sintra house" },
    { seed: 6, subject: "Rui", predicate: "born", value: "1990" },
  ] };
  const claims = [
    { id: 1, subjectId: "self", predicate: "sibling_of", objectId: "rui" },
    { id: 2, subjectId: "tiago", predicate: "received_from", objectId: "self", amount: 12000, currency: "EUR", date: new Date("2024-03-01"), datePrecision: "month", contextId: "house" },
    { id: 3, subjectId: "self", predicate: "bought", objectId: "plot", amount: 90000, currency: "EUR", status: "superseded" },
    { id: 4, subjectId: "self", predicate: "bought", objectId: "plot", amount: 85000, currency: "EUR" },
    { id: 5, subjectId: "house", predicate: "due_on", value: "2026-12-31" },
    { id: 6, subjectId: "self", predicate: "plans", value: "We will move into the house in Sintra" },
    { id: 7, subjectId: "rui", predicate: "born", value: "1990" },
    { id: 8, subjectId: "rui", predicate: "lives_in", objectId: "sintra" },
  ];
  const score = scoreClaims({ expect, entities, claims, selfId: "self" });
  assert.deepEqual(score.missed.map((fact) => fact.seed), [4], "a day is more precise than the month that was said");
  assert.equal(score.byDomain.people.tp, 1);
  assert.equal(score.byDomain.money.tp, 1);
  assert.equal(score.byDomain.assets.tp, 2);
  assert.equal(score.byDomain.time.fn, 1);
  assert.equal(score.byDomain.time.fp, 2);
  assert.equal(score.total.tp, 6);

  const stale = scoreClaims({ expect: { claims: [expect.claims[2]] }, entities, claims: [{ ...claims[2], status: "stated" }], selfId: "self" });
  assert.equal(stale.total.tp, 0, "a corrected fact still marked stated does not count");
});

test("the gate needs 85% overall, every domain at 70% and nothing dropped at routing", () => {
  const domain = (tp, fn) => ({ tp, fn, fp: 0, recall: tp / (tp + fn) });
  const score = { total: { recall: 0.9 }, byDomain: { people: domain(9, 1), money: domain(6, 4), plans: { tp: 0, fn: 0, fp: 0, recall: null } } };
  assert.deepEqual(gate(score, 0), { pass: false, recall: 0.9, lowDomains: ["money"], droppedAtRouting: 0 });
  assert.equal(gate({ ...score, byDomain: { people: domain(9, 1) } }, 1).pass, false);
  assert.equal(gate({ ...score, byDomain: { people: domain(9, 1) } }, 0).pass, true);
});

test("the life set's expected claims use only the core vocabulary and cover every domain", () => {
  const set = JSON.parse(readFileSync(new URL("../scripts/golden/sets/life.json", import.meta.url), "utf8"));
  const expect = JSON.parse(readFileSync(new URL("./extraction/life.expect.json", import.meta.url), "utf8"));
  for (const fact of expect.claims) {
    assert.ok(PREDICATES[fact.predicate], `unknown predicate ${fact.predicate}`);
    assert.ok(fact.seed >= 0 && fact.seed < set.seeds.length, `seed ${fact.seed} out of range`);
    const kind = PREDICATES[fact.predicate].object;
    if (kind === "entity") assert.ok(fact.object, `${fact.predicate} needs an object`);
    if (kind === "date") assert.match(String(fact.value), /^\d{4}(-\d{2}){0,2}$/, `${fact.predicate} needs an ISO date value`);
  }
  const domains = new Set(expect.claims.map((fact) => PREDICATES[fact.predicate].domain));
  for (const domain of DOMAINS) assert.ok(domains.has(domain), `no expected claims in ${domain}`);
  const asked = new Set(set.questions.map((question) => question.domain));
  for (const domain of [...DOMAINS, "open"]) assert.ok(asked.has(domain), `no questions in ${domain}`);
});

test("ownership follows from a purchase or sale, and plans, intentions and decisions are one family", () => {
  const expect = { claims: [
    { seed: 0, subject: "me", predicate: "owns", object: "Sintra plot", date: "2020" },
    { seed: 1, subject: "me", predicate: "owns", object: "Sintra house", until: "2023-09" },
    { seed: 2, subject: "me", predicate: "decided", value: "move into the Sintra house" },
    { seed: 3, subject: "me", predicate: "paid", object: "Tiago Mendes", amount: 500, context: "Sintra house" },
  ] };
  const claims = [
    { id: 1, subjectId: "self", predicate: "bought", objectId: "plot", date: new Date("2020-01-01"), datePrecision: "year" },
    { id: 2, subjectId: "self", predicate: "sold", objectId: "house", date: new Date("2023-09-01"), datePrecision: "month" },
    { id: 3, subjectId: "self", predicate: "plans", value: "we will move into the Sintra house" },
    { id: 4, subjectId: "self", predicate: "paid", objectId: "tiago", amount: 500 },
  ];
  assert.equal(scoreClaims({ expect, entities, claims, selfId: "self" }).total.tp, 4);
  const wrong = scoreClaims({ expect: { claims: [expect.claims[3]] }, entities, claims: [{ ...claims[3], contextId: "plot" }], selfId: "self" });
  assert.equal(wrong.total.tp, 0, "a different context is wrong");
});
