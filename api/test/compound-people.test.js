import assert from "node:assert/strict";
import test from "node:test";
import { answerPeopleQuestion, buildPeopleContext, compoundPeopleAnswer, isPeopleQuestion, usesRecordedAnswer } from "../src/services/graph/peopleGrounding.js";

// A question that names several relations gets every one answered from records, in the order asked, in one reply.

const self = { id: "self", name: "Bjorn Gunnar Arason", kind: "self" };
const people = [
  self,
  { id: "gunnar", name: "Gunnar Arason", kind: "father", birthDate: "1950-02-19", deathDate: "2001-04-25" },
  { id: "hekla", name: "Hekla Bjorg Olafsdottir", kind: "mother" },
  { id: "asta", name: "Asta Kristin Jonsdottir", kind: "wife", birthDate: "1979-12-11" },
  { id: "sigrun", name: "Sigrun Gunnar Arason", kind: "sister", birthDate: "1977-12-04" },
  { id: "einar", name: "Einar", kind: "son", birthDate: "2005-09-25" },
  { id: "kari", name: "Kari", kind: "son" },
];
const edge = (id, type, fromId, toId) => ({ id, type, status: "confirmed", fromId, toId });
const edges = [
  edge("e1", "parent_of", "gunnar", "self"),
  edge("e2", "parent_of", "hekla", "self"),
  { ...edge("e3", "spouse_of", "asta", "self"), validFrom: new Date("2003-08-05T00:00:00Z") },
  edge("e4", "sibling_of", "sigrun", "self"),
  edge("e5", "parent_of", "self", "einar"),
  edge("e6", "parent_of", "self", "kari"),
];
const context = buildPeopleContext({ self, people, edges, events: [] });

test("compound questions go to the recorded answer", () => {
  for (const q of ["my wife and parents?", "who are my sisters and children?"]) {
    assert.equal(isPeopleQuestion(q), true, q);
    assert.equal(usesRecordedAnswer(q), true, q);
  }
});

test("my wife and parents? answers both, wife first", () => {
  assert.equal(answerPeopleQuestion("my wife and parents?", context), [
    "Asta Kristin Jonsdottir — your wife (married 5 Aug 2003).",
    "Gunnar Arason — your father (passed 25 Apr 2001).",
    "Hekla Bjorg Olafsdottir — your mother.",
  ].join("\n"));
});

test("order follows the question; father and mother asked separately", () => {
  const answer = answerPeopleQuestion("who are my children, my mother and my sisters?", context);
  const lines = answer.split("\n");
  assert.match(lines[0], /^Your children: Einar, Kari\.$/);
  assert.match(lines[1], /^Hekla Bjorg Olafsdottir — your mother\.$/);
  assert.match(lines[2], /^Your sisters: Sigrun Gunnar Arason\.$/);
});

test("birth questions give each person's recorded date or say not recorded", () => {
  const answer = answerPeopleQuestion("when were my wife and children born?", context);
  assert.equal(answer, ["Asta Kristin Jonsdottir — 11 Dec 1979", "Einar — 25 Sep 2005", "Kari — birth date not recorded yet"].join("\n"));
});

test("a relation with no record says so; single and possessive questions are unchanged", () => {
  const noKids = buildPeopleContext({ self, people: people.filter((person) => !["einar", "kari"].includes(person.id)), edges: edges.slice(0, 4), events: [] });
  assert.match(answerPeopleQuestion("my wife and kids?", noKids), /Asta Kristin Jonsdottir — your wife[\s\S]*\nYour children aren't recorded yet\.$/);
  assert.equal(answerPeopleQuestion("who is my wife?", context), "Asta Kristin Jonsdottir — your wife (married 5 Aug 2003).");
  assert.equal(compoundPeopleAnswer("who's my father's wife?", context), null, "someone else's relation is not a compound question");
  assert.equal(compoundPeopleAnswer("my mother's sisters and brothers?", context), null);
});
