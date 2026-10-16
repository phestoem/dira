import assert from "node:assert/strict";
import test from "node:test";
import { schemaFactsToGraph, validateSchemaFacts } from "../src/services/graph/peopleSchema.js";
import { groundToolReply } from "../src/services/graph/peopleTools.js";
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
