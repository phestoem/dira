import assert from "node:assert/strict";
import test from "node:test";
import { answerPeopleQuestion, buildPeopleContext, chainedPeopleAnswer, isPeopleQuestion, usesRecordedAnswer } from "../src/services/graph/peopleGrounding.js";

// "my father's wife", "my wife's parents", "my sister's children": answered from records. A recorded connection of
// that person first; otherwise only a parent's spouse (your other parent) and a parent's children (you and your
// siblings) follow from your own connections. Nothing else is guessed.

const self = { id: "self", name: "Bjorn Gunnar Arason", kind: "self" };
const people = [
  self,
  { id: "gunnar", name: "Gunnar Arason", kind: "father" },
  { id: "hekla", name: "Hekla Bjorg Olafsdottir", kind: "mother" },
  { id: "asta", name: "Asta Kristin Jonsdottir", kind: "wife" },
  { id: "sigrun", name: "Sigrun Gunnar Arason", kind: "sister" },
  { id: "thora", name: "Thora Gunnar Arason", kind: "sister" },
  { id: "ylfa", name: "Ylfa", kind: "daughter" },
  { id: "einar", name: "Einar", kind: "son" },
];
const edge = (id, type, fromId, toId, fromName, toName) => ({ id, type, status: "confirmed", fromId, toId, fromName, toName });
const edges = [
  edge("e1", "parent_of", "gunnar", "self"),
  edge("e2", "parent_of", "hekla", "self"),
  edge("e3", "spouse_of", "asta", "self"),
  edge("e4", "sibling_of", "self", "sigrun"),
  edge("e5", "sibling_of", "self", "thora"),
  edge("e6", "parent_of", "self", "ylfa"),
  edge("e7", "parent_of", "self", "einar"),
  // Recorded connections of other people
  edge("e8", "parent_of", "asta", "einar", "Asta Kristin Jonsdottir", "Einar"),
  edge("e9", "spouse_of", "sigrun", "olafur", "Sigrun Gunnar Arason", "Olafur Berg"),
  edge("e10", "parent_of", "ingrid", "asta", "Ingrid Mosfell", "Asta Kristin Jonsdottir"),
];
const context = buildPeopleContext({ self, people, edges, events: [] });

test("chained questions use the recorded answer", () => {
  for (const q of ["who's my father's wife?", "who are my wife's parents?", "my sister's children?"]) {
    assert.equal(isPeopleQuestion(q), true, q);
    assert.equal(usesRecordedAnswer(q), true, q);
  }
});

test("a parent's spouse is your other parent; a parent's children are you and your siblings", () => {
  assert.equal(answerPeopleQuestion("who's my father's wife?", context), "Gunnar Arason's wife: Hekla Bjorg Olafsdottir — your mother.");
  assert.equal(answerPeopleQuestion("who is my mother's husband?", context), "Hekla Bjorg Olafsdottir's husband: Gunnar Arason — your father.");
  assert.equal(answerPeopleQuestion("who are my mother's children?", context), "Hekla Bjorg Olafsdottir's children: Bjorn Gunnar Arason (you), Sigrun Gunnar Arason, Thora Gunnar Arason.");
});

test("a spouse's or sibling's relations come only from their recorded connections", () => {
  assert.equal(answerPeopleQuestion("who are my wife's children?", context), "Asta Kristin Jonsdottir's children: Einar.", "Ylfa is not assumed to be hers");
  assert.equal(answerPeopleQuestion("who are my wife's parents?", context), "Asta Kristin Jonsdottir's parents: Ingrid Mosfell.");
  assert.equal(answerPeopleQuestion("who is my wife's father?", context), "Asta Kristin Jonsdottir's father: Ingrid Mosfell.", "a parent with no recorded kind may be either");
  assert.equal(answerPeopleQuestion("who is my sister Sigrun's husband?", context), "Sigrun Gunnar Arason's husband: Olafur Berg.");
  assert.equal(answerPeopleQuestion("my sister's children?", context), "Sigrun Gunnar Arason's children aren't recorded yet.\nThora Gunnar Arason's children aren't recorded yet.");
  assert.equal(answerPeopleQuestion("who is my sister Thora's husband?", context), "Thora Gunnar Arason's husband isn't recorded yet.");
});

test("not a chained question: null; a missing base says so", () => {
  assert.equal(chainedPeopleAnswer("who is my wife?", context), null);
  const noParents = buildPeopleContext({ self, people: [self], edges: [], events: [] });
  assert.equal(answerPeopleQuestion("who's my father's wife?", noParents), "Your father isn't recorded yet.");
});
