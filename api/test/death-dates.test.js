import assert from "node:assert/strict";
import test from "node:test";
import { answerPeopleQuestion, buildPeopleContext } from "../src/services/graph/peopleGrounding.js";

// A date stated next to someone's passing is their death date, never their birth date; a birth date is never on or
// after the death date.

const people = [
  { id: "self", name: "Bjorn Gunnar Arason", kind: "self" },
  { id: "gunnar", name: "Gunnar Arason", kind: "father", deathDate: "2001-04-25" },
];
const edges = [{ id: "e-father", type: "parent_of", status: "confirmed", fromId: "gunnar", toId: "self", fromName: "Gunnar Arason", toName: "Bjorn Gunnar Arason" }];
const self = people[0];
const born = { id: "old", rawInput: "My father is Gunnar Arason, born in Feb 19th 1950 in Dalvik, he died on April 25th 2001." };
const passing = [
  { id: "p1", understoodMeaning: "The document contains family information including the passing of the father, Gunnar Arason, on April 25, 2001, and details about the mother." },
  { id: "p2", rawInput: "Our late father Gunnar Arason, 25 April 2001, rests in Dalvik." },
  { id: "p3", rawInput: "The funeral of Gunnar Arason on 2 May 2001 was in Dalvik." },
];
const tree = (events) => answerPeopleQuestion("show my family tree", buildPeopleContext({ self, people, edges, events }));

test("a newer note about the passing does not become the birth date", () => {
  for (const note of passing) {
    const answer = tree([note, born]);
    assert.match(answer, /Gunnar Arason \(father, b\. 19 Feb 1950, passed 25 Apr 2001\)/, note.id);
  }
});

test("with only the passing recorded there is no birth date", () => {
  for (const note of passing) assert.doesNotMatch(tree([note]), /b\. /, note.id);
});

test("a birth date on or after the death date is not shown", () => {
  const answer = tree([{ id: "bad", rawInput: "Gunnar Arason was born on 3 March 2005." }]);
  assert.doesNotMatch(answer, /b\. 3 Mar 2005/);
});
