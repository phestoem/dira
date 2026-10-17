import assert from "node:assert/strict";
import test from "node:test";
import { schemaFactsToGraph, validateSchemaFacts } from "../src/services/graph/peopleSchema.js";
import { runHybridTool } from "../src/services/graph/peopleHybrid.js";
import { allowedFrom, groundToolReply } from "../src/services/graph/peopleTools.js";
import { datesIn } from "../src/services/graph/dates.js";

// PEOPLE_ENGINE=tools: invariants only, judged against the source text. Invented people throughout.
const SELF = "Lucía Andrade Pinto";

test("schema facts keep only what the text states verbatim", () => {
  const text = "My half-brother Hugo Andrade lives in Vigo. His wife Clara was born on 4th of May 1991. My husband and I married on 14 February 2009. My first husband Óscar and I divorced in 2005.";
  const known = [{ name: "Pablo Ruiz", kind: "husband" }];
  const checked = validateSchemaFacts({
    people: [{ name: "Hugo Andrade", gender: "male" }, { name: "Clara", gender: "female" }, { name: "Óscar", gender: "male" }],
    relations: [
      { person: "Hugo Andrade", relation: "half_sibling", of: "narrator", evidence: "My half-brother Hugo Andrade" },
      { person: "Clara", relation: "spouse", of: "Hugo Andrade", evidence: "His wife Clara" },
      { person: "Clara", relation: "spouse", of: "narrator", evidence: "My husband and I married on 14 February 2009" },
      { person: "Óscar", relation: "former_spouse", of: "narrator", evidence: "My first husband Óscar and I divorced in 2005" },
      { person: "Rosa", relation: "sibling", of: "narrator", evidence: "My sister Rosa" },
      { person: "she", relation: "sibling", of: "narrator", evidence: "His wife Clara" },
      { person: "Óscar", relation: "spouse", of: "narrator", evidence: "we were happy" },
    ],
    dates: [
      { person: "Clara", kind: "birth", date: "1991-05-04", as_written: "4th of May 1991", with: "", evidence: "His wife Clara was born on 4th of May 1991" },
      { person: "Pablo Ruiz", kind: "marriage", date: "2009-02-14", as_written: "14 February 2009", with: "narrator", evidence: "My husband and I married on 14 February 2009" },
      { person: "Óscar", kind: "divorce", date: "2005", as_written: "2005", with: "narrator", evidence: "My first husband Óscar and I divorced in 2005" },
      { person: "Hugo Andrade", kind: "birth", date: "1988-01-01", as_written: "1 January 1988", with: "", evidence: "My half-brother Hugo Andrade" },
      { person: "Clara", kind: "birth", date: "1991-05-05", as_written: "4th of May 1991", with: "", evidence: "His wife Clara was born on 4th of May 1991" },
    ],
    places: [{ person: "Hugo Andrade", place: "Vigo", evidence: "Hugo Andrade lives in Vigo" }],
  }, { text, selfName: SELF, known });
  const reasons = checked.dropped.map((item) => `${item.item.person}:${item.reason}`);
  // Clara is written in the text, but this evidence does not name her and she is not a known person.
  assert.ok(reasons.includes("Clara:name-not-in-text"));
  assert.ok(reasons.includes("Rosa:evidence-not-in-text"));
  assert.ok(reasons.includes("she:pronoun"));
  assert.ok(reasons.includes("Óscar:evidence-not-in-text"));
  assert.ok(reasons.includes("Hugo Andrade:date-not-in-text"));
  assert.ok(reasons.includes("Clara:date-mismatch"));
  assert.deepEqual(checked.relations.map((item) => `${item.person} ${item.relation} ${item.of}`), ["Hugo Andrade half_sibling narrator", "Clara spouse Hugo Andrade", "Óscar former_spouse narrator"]);
  // A known husband may be recognised by role; the evidence is still verbatim.
  assert.ok(checked.dates.some((item) => item.person === "Pablo Ruiz" && item.kind === "marriage"));

  const graph = schemaFactsToGraph(checked, SELF);
  const lines = graph.triples.map((triple) => `${triple.subject.name} ${triple.predicate} ${triple.object.name}${triple.validFrom ? ` from ${triple.validFrom}` : ""}${triple.validTo ? ` to ${triple.validTo}` : ""}`);
  assert.deepEqual(lines, [
    "Hugo Andrade sibling_of me",
    "Clara spouse_of Hugo Andrade",
    "Óscar spouse_of me",
    "Pablo Ruiz spouse_of me from 2009-02-14",
    "Óscar spouse_of me to 2005-01-01",
    "Hugo Andrade lives_at Vigo",
  ]);
  assert.equal(graph.triples.every((triple) => triple.validated), true);
  assert.equal(graph.entityFacts.find((fact) => fact.name === "Hugo Andrade").kind, "half-brother");
  assert.equal(graph.entityFacts.find((fact) => fact.name === "Clara").birthDate, "1991-05-04");
});

test("one birth date per person, and no death before birth", () => {
  const text = "Inés was born on 5 May 1990. Inés was born on 5 May 1991. Bruno was born on 1 May 2012 and died on 1 May 2001.";
  const checked = validateSchemaFacts({
    people: [],
    relations: [],
    dates: [
      { person: "Inés", kind: "birth", date: "1990-05-05", as_written: "5 May 1990", with: "", evidence: "Inés was born on 5 May 1990" },
      { person: "Inés", kind: "birth", date: "1991-05-05", as_written: "5 May 1991", with: "", evidence: "Inés was born on 5 May 1991" },
      { person: "Bruno", kind: "birth", date: "2012-05-01", as_written: "1 May 2012", with: "", evidence: "Bruno was born on 1 May 2012" },
      { person: "Bruno", kind: "death", date: "2001-05-01", as_written: "1 May 2001", with: "", evidence: "Bruno was born on 1 May 2012 and died on 1 May 2001" },
    ],
    places: [],
  }, { text, selfName: SELF });
  assert.deepEqual(checked.dates.map((item) => `${item.person} ${item.kind}`), ["Bruno birth"]);
  assert.deepEqual(checked.dropped.map((item) => item.reason).sort(), ["conflicting-birth", "conflicting-birth", "death-before-birth"]);
});

test("tool answers may state only names and dates the tools returned, in any language", () => {
  const allowed = { allowedNames: ["Héctor Andrade", "Marta Pinto"], allowedDates: new Set(["1950-06-02", "2011-10-09"]) };
  const swahili = groundToolReply("Wazazi wako ni Héctor Andrade, aliyezaliwa tarehe 2 Juni 1950, na Marta Pinto. Baba yako alifariki tarehe 9 Oktoba 2011.", allowed);
  assert.deepEqual(swahili.removed, []);
  assert.match(swahili.reply, /Marta Pinto/);
  const invented = groundToolReply("Your father is Héctor Andrade. His brother is Ramiro Andrade. Marta Pinto was born in 1952.", allowed);
  assert.equal(invented.reply, "Your father is Héctor Andrade.");
  assert.deepEqual(invented.removed.sort(), ["1952", "Ramiro Andrade"]);
  assert.deepEqual(datesIn("born 3rd of Feb 1993, wed 2006-08-05, alizaliwa tarehe 3 Februari 1993").dates.sort(), ["1993-02-03", "2006-08-05"]);
});

test("the post-check compares meaning: role words, labels and aliases are not inventions", () => {
  const results = [{ parent: [{ name: "Héctor Andrade", relation: "parent", role: "father", died: "2011-10-09" }], former_spouse: [{ name: "Óscar Ruiz", relation: "former_spouse", role: "husband", ended: "2005" }] }];
  const snapshot = { entities: [{ name: "Héctor Andrade", aliases: ["Tito"] }] };
  const allowed = allowedFrom(results, "show my family tree", snapshot);
  const tree = groundToolReply("Here's your family tree:\n\n- **Parents:**\n  - Héctor Andrade (Father, died: 2011-10-09)\n- **Former Spouse:**\n  - Óscar Ruiz (Husband, ended: 2005)\n\nTito is what you called him.", allowed);
  assert.deepEqual(tree.removed, []);
  assert.match(tree.reply, /- \*\*Parents:\*\*\n {2}- Héctor Andrade/);
  const precise = groundToolReply("You divorced Óscar Ruiz in 2005.\n- You divorced on 1 January 2005.\n- Ramiro Andrade is your uncle.", allowed);
  assert.equal(precise.reply, "You divorced Óscar Ruiz in 2005.");
  assert.deepEqual(precise.removed.sort(), ["2005-01-01", "Ramiro Andrade"]);
  assert.deepEqual(groundToolReply("He died on 09/10/2011, in October 2011.", allowed).removed, []);
  assert.deepEqual(groundToolReply("He died in March 2011.", allowed).removed, ["2011-03"]);
});

test("dates are read in any common format; a bare year stays a year", () => {
  assert.deepEqual(datesIn("2016년 3월 2일").dates, ["2016-03-02"]);
  assert.deepEqual(datesIn("21 lipca 1990 and 3.2.1993").dates.sort(), ["1990-07-21", "1993-02-03"]);
  assert.deepEqual(datesIn("on 03/04/2019").either, [["2019-04-03", "2019-03-04"]]);
  assert.deepEqual(datesIn("in March 2019").months, ["2019-03"]);
  const year = datesIn("divorced in 2016");
  assert.deepEqual([year.dates, year.months, year.years], [[], [], ["2016"]]);
});

function snapshotOf(people, edges) {
  const self = { id: "self", name: SELF, isSelf: true, entityType: "person", aliases: [] };
  const entities = [self, ...people.map((person) => ({ entityType: "person", aliases: [], ...person }))];
  return { self, entities, edges: edges.map((edge) => ({ status: "confirmed", attributes: {}, ...edge })), byId: new Map(entities.map((entity) => [entity.id, entity])) };
}

test("hybrid tools answer list, count, date, tree and who-is questions in code", async () => {
  const snapshot = snapshotOf(
    [
      { id: "h", name: "Hugo Andrade" }, { id: "r", name: "Rosa Andrade" }, { id: "p", name: "Pablo Ruiz" }, { id: "o", name: "Óscar Ruiz" },
      { id: "a", name: "Alba", birthDate: new Date("2010-05-04") }, { id: "b", name: "Bruno", birthDate: new Date("2014-09-30") }, { id: "n", name: "Nico Ferrer" },
    ],
    [
      { fromId: "self", toId: "h", type: "sibling_of", category: "family", attributes: { kind: "half-brother" } },
      { fromId: "self", toId: "r", type: "sibling_of", category: "family", attributes: { kind: "sister" } },
      { fromId: "self", toId: "p", type: "spouse_of", category: "family", attributes: { kind: "husband" }, validFrom: new Date("2009-02-14") },
      { fromId: "self", toId: "o", type: "spouse_of", category: "family", attributes: { kind: "husband", ended: true, endPrecision: "year" }, validFrom: new Date("2001-06-02"), validTo: new Date("2005-01-01") },
      { fromId: "self", toId: "a", type: "parent_of", category: "family", attributes: { kind: "daughter" } },
      { fromId: "self", toId: "b", type: "parent_of", category: "family", attributes: { kind: "son" } },
      { fromId: "self", toId: "n", type: "knows", category: "social", attributes: { kind: "neighbour" } },
    ],
  );
  const run = (name, args) => runHybridTool("user", snapshot, name, args);
  assert.equal((await run("list_people", { relation: "sibling", pick: "all" })).reply, "Your siblings: Hugo Andrade (half-brother) and Rosa Andrade (sister).");
  assert.equal((await run("count_people", { relation: "child" })).reply, "You have 2 recorded children: Alba (daughter) and Bruno (son).");
  assert.equal((await run("list_people", { relation: "child", pick: "youngest" })).reply, "Bruno (son) is the youngest, born 30 September 2014.");
  assert.equal((await run("person_dates", { person: "narrator", relation: "none", pick: "all", event: "marriage" })).reply, "You married Pablo Ruiz on 14 February 2009. You married Óscar Ruiz on 2 June 2001.");
  assert.equal((await run("person_dates", { person: "Óscar", relation: "none", pick: "all", event: "divorce" })).reply, "Your marriage to Óscar Ruiz ended in 2005.");
  assert.equal((await run("who_is", { name: "Nico Ferrer" })).reply, "Nico Ferrer is your neighbour.");
  const tree = (await run("family_tree", {})).reply;
  assert.match(tree, /- Children: Alba \(daughter\), Bruno \(son\)/);
  assert.match(tree, /- Former spouse: Óscar Ruiz \(husband\)/);
  assert.doesNotMatch(tree, /Nico/);
});

test("hybrid derives in-laws from the graph and reads a role word passed as a name", async () => {
  const snapshot = snapshotOf(
    [{ id: "r", name: "Rosa Andrade", birthDate: new Date("1988-03-12") }, { id: "t", name: "Tomás Vidal" }, { id: "p", name: "Pablo Ruiz" }, { id: "e", name: "Elena Ruiz" }, { id: "g", name: "Gloria Pinto", birthDate: new Date("1931-07-01") }],
    [
      { fromId: "self", toId: "r", type: "sibling_of", category: "family", attributes: { kind: "half-sister" } },
      { fromId: "r", toId: "t", type: "spouse_of", category: "family" },
      { fromId: "self", toId: "p", type: "spouse_of", category: "family", attributes: { kind: "husband" } },
      { fromId: "e", toId: "p", type: "parent_of", category: "family" },
      { fromId: "g", toId: "self", type: "grandparent_of", category: "family", attributes: { kind: "grandmother" } },
    ],
  );
  const run = (name, args) => runHybridTool("user", snapshot, name, args);
  assert.equal((await run("list_people", { relation: "sibling_in_law", pick: "all" })).reply, "Your siblings-in-law: Tomás Vidal (sibling-in-law).");
  assert.equal((await run("list_people", { relation: "parent_in_law", pick: "all" })).reply, "Your parents-in-law: Elena Ruiz (parent-in-law).");
  assert.equal((await run("person_dates", { person: "half-sister", relation: "none", pick: "all", event: "birth" })).reply, "Rosa Andrade was born on 12 March 1988.");
  assert.equal((await run("person_dates", { person: "grandparent", relation: "none", pick: "all", event: "birth" })).reply, "Gloria Pinto was born on 1 July 1931.");
  assert.equal((await run("who_is", { name: "uncle" })).reply, "No uncle is recorded yet.");
});

test("an edge date from a bare year is told as a year", async () => {
  const snapshot = snapshotOf([{ id: "p", name: "Pablo Ruiz" }], [{ fromId: "self", toId: "p", type: "spouse_of", category: "family", validFrom: new Date("2009-01-01") }]);
  assert.equal((await runHybridTool("user", snapshot, "person_dates", { person: "narrator", relation: "none", pick: "all", event: "marriage" })).reply, "You married Pablo Ruiz in 2009.");
});
