import assert from "node:assert/strict";
import test from "node:test";
import { answerPeopleQuestion, buildPeopleContext, chainedPeopleAnswer, isPeopleQuestion, parseChain, usesRecordedAnswer } from "../src/services/graph/peopleGrounding.js";

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
  for (const q of ["who's my father's wife?", "who are my wife's parents?", "my sister's children?", "list my parents' children", "how many kids do my parents have?"]) {
    assert.equal(isPeopleQuestion(q), true, q);
    assert.equal(usesRecordedAnswer(q), true, q);
  }
});

test("a parent's spouse is your other parent; a parent's children are you and your siblings", () => {
  assert.equal(answerPeopleQuestion("who's my father's wife?", context), "Your father's wife: Hekla Bjorg Olafsdottir — your mother.");
  assert.equal(answerPeopleQuestion("who is my mother's husband?", context), "Your mother's husband: Gunnar Arason — your father.");
  assert.equal(answerPeopleQuestion("who are my mother's children?", context), "Your mother's children: Bjorn Gunnar Arason (you), Sigrun Gunnar Arason, Thora Gunnar Arason.");
});

test("plural possessives and the 'do my … have' form: my parents' children", () => {
  const expected = "Your parents' children: Bjorn Gunnar Arason (you), Sigrun Gunnar Arason, Thora Gunnar Arason.";
  assert.equal(answerPeopleQuestion("list my parents' children", context), expected, "not your parents plus your own children");
  assert.equal(answerPeopleQuestion("how many kids do my parents have?", context), "Your parents have 3 kids: Bjorn Gunnar Arason (you), Sigrun Gunnar Arason, Thora Gunnar Arason.");
  assert.equal(answerPeopleQuestion("how many kids does my mother have?", context), "Your mother has 3 kids: Bjorn Gunnar Arason (you), Sigrun Gunnar Arason, Thora Gunnar Arason.");
  assert.deepEqual(parseChain("list my parents' children").map((step) => step.word), ["parents", "children"]);
});

test("a spouse's or sibling's relations come only from their recorded connections", () => {
  assert.equal(answerPeopleQuestion("who are my wife's children?", context), "Your wife's children: Einar — your son.", "Ylfa is not assumed to be hers");
  assert.equal(answerPeopleQuestion("who are my wife's parents?", context), "Your wife's parents: Ingrid Mosfell.");
  assert.equal(answerPeopleQuestion("who is my wife's mother?", context), "Your wife's mother: Ingrid Mosfell.", "a parent of unknown gender may be either");
  assert.equal(answerPeopleQuestion("who is my sister Sigrun's husband?", context), "Your sister Sigrun's husband: Olafur Berg.");
  assert.equal(answerPeopleQuestion("my sister's children?", context), "Your sister's children aren't recorded yet.");
  assert.equal(answerPeopleQuestion("who is my sister Thora's husband?", context), "Your sister Thora's husband isn't recorded yet.");
});

test("any depth, left to right", () => {
  assert.equal(answerPeopleQuestion("who are my wife's mother's children?", context), "Your wife's mother's children: Asta Kristin Jonsdottir — your wife.");
  assert.equal(answerPeopleQuestion("who are my sister's parents' children?", context), "Your sister's parents' children: Bjorn Gunnar Arason (you), Sigrun Gunnar Arason, Thora Gunnar Arason.");
  assert.equal(answerPeopleQuestion("who is my son Einar's mother?", context), "Your son Einar's mother: Asta Kristin Jonsdottir — your wife.");
});

test("not a chained question: null; a missing link says so", () => {
  assert.equal(chainedPeopleAnswer("who is my wife?", context), null);
  const noParents = buildPeopleContext({ self, people: [self], edges: [], events: [] });
  assert.equal(answerPeopleQuestion("who's my father's wife?", noParents), "Your father isn't recorded yet.");
});
