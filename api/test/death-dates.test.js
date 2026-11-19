import assert from "node:assert/strict";
import test from "node:test";
import { answerPeopleQuestion, buildPeopleContext } from "../src/services/graph/peopleGrounding.js";

// Dates come only from records. Event text, however it words a birth or a passing, never dates a person; and a
// birth date on or after the death date is never shown.

const self = { id: "self", name: "Bjorn Gunnar Arason", kind: "self" };
const edges = [{ id: "e-father", type: "parent_of", status: "confirmed", fromId: "gunnar", toId: "self", fromName: "Gunnar Arason", toName: "Bjorn Gunnar Arason" }];
const notes = [
  { id: "old", rawInput: "My father is Gunnar Arason, born in Feb 19th 1950 in Dalvik, he died on April 25th 2001." },
  { id: "p1", understoodMeaning: "The document contains family information including the passing of the father, Gunnar Arason, on April 25, 2001, and details about the mother." },
  { id: "p2", rawInput: "Our late father Gunnar Arason, 25 April 2001, rests in Dalvik." },
];
const tree = (father, events = notes) => answerPeopleQuestion("show my family tree", buildPeopleContext({ self, people: [self, { id: "gunnar", name: "Gunnar Arason", kind: "father", ...father }], edges, events }));

test("the dates on the record are shown; event text does not change them", () => {
  assert.match(tree({ birthDate: "1950-02-19", deathDate: "2001-04-25" }), /Gunnar Arason \(father, b\. 19 Feb 1950, passed 25 Apr 2001\)/);
});

test("a date missing on the record is not recorded, even when event text states it", () => {
  assert.match(tree({ deathDate: "2001-04-25" }), /Gunnar Arason \(father, birth date not recorded, passed 25 Apr 2001\)/);
  assert.match(tree({}), /Gunnar Arason \(father, birth date not recorded\)$/m);
});

test("a birth date on or after the death date is not shown", () => {
  assert.match(tree({ birthDate: "2001-04-25", deathDate: "2001-04-25" }, []), /Gunnar Arason \(father, birth date not recorded, passed 25 Apr 2001\)/);
});
