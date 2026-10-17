import assert from "node:assert/strict";
import test from "node:test";
import { routeOf, sameName, scoreExtraction } from "../scripts/golden/extraction.js";

// Invented family. Scoring reads the stored graph and the extraction trace; nothing here calls a model.
test("extraction scoring types stored facts and traces each miss to the stage that lost it", () => {
  const self = { id: "self", name: "Lucía Andrade", isSelf: true, entityType: "person" };
  const entities = [self, { id: "h", name: "Hugo Andrade", entityType: "person", birthDate: new Date("1990-05-04") }, { id: "x", name: "older son", entityType: "person" }];
  const edges = [
    { fromId: "self", toId: "h", type: "sibling_of", category: "family", status: "confirmed", attributes: { kind: "half-brother" } },
    { fromId: "self", toId: "x", type: "parent_of", category: "family", status: "suggested", attributes: { kind: "son" } },
  ];
  const snapshot = { self, entities, edges, byId: new Map(entities.map((entity) => [entity.id, entity])) };
  const seeds = ["My half-brother Hugo Andrade was born on 4 May 1990.", "My aunt Rosa lives in Vigo.", "Who is Hugo?", "My cousin Teo moved."];
  const expect = { facts: [
    { seed: 0, person: "Hugo Andrade", relation: "half_sibling" },
    { seed: 0, person: "Hugo", born: "1990-05-04" },
    { seed: 1, person: "Rosa", relation: "aunt_uncle" },
    { seed: 2, person: "Hugo Andrade", relation: "sibling" },
    { seed: 3, person: "Teo", relation: "cousin" },
  ] };
  const traces = [
    { text: seeds[1], raw: [{ name: "Rosa", relation: "aunt" }], kept: [], dropped: [{ name: "Rosa", reason: "name-not-in-text" }] },
    { text: seeds[3], raw: [], kept: [], dropped: [] },
  ];
  const routes = ["relationship_add", "relationship_add", "question", "intake"];
  const score = scoreExtraction({ expect, seeds, routes, snapshot, traces });
  assert.deepEqual(score.byType.half_sibling, { tp: 1, fp: 0, fn: 0 });
  assert.deepEqual(score.byType["date:born"], { tp: 1, fp: 0, fn: 0 });
  assert.deepEqual(score.byType.child, { tp: 0, fp: 1, fn: 0 });
  assert.deepEqual(score.lost, { validation: 1, routing: 1, "not-extracted": 1 });
  assert.deepEqual(score.people, { tp: 1, fp: 1, fn: 2 });
  assert.deepEqual(score.validationDrops, { "name-not-in-text": 1 });
  assert.equal(sameName("Cian", { name: "Cian Byrne" }), true);
  assert.equal(sameName("Cian Murphy", { name: "Cian Byrne" }), false);
  assert.equal(routeOf(["question/answer", "NOT SAVED"]), "question");
  assert.equal(routeOf(["relationship_add/relationship_preview", "confirmed → saved"]), "relationship_add");
});
