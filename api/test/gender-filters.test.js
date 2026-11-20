import assert from "node:assert/strict";
import test from "node:test";
import { answerPeopleQuestion, buildPeopleContext, resolvePronouns } from "../src/services/graph/peopleGrounding.js";

// sons/daughters/brothers/sisters filter by gender on every path: own children, chains, compound questions and
// pronoun follow-ups. A child recorded as neither is named apart, never counted in.

const self = { id: "self", name: "Bjorn Arason", kind: "self" };
const people = [
  self,
  { id: "gunnar", name: "Gunnar Arason", kind: "father" },
  { id: "hekla", name: "Hekla Olafsdottir", kind: "mother" },
  { id: "asta", name: "Asta Jonsdottir", kind: "wife" },
  { id: "sigrun", name: "Sigrun Arason", kind: "sister" },
  { id: "thora", name: "Thora Arason", kind: "sister" },
  { id: "ylfa", name: "Ylfa", kind: "daughter", birthDate: "2001-02-04" },
  { id: "einar", name: "Einar", kind: "son", birthDate: "2005-09-25" },
  { id: "kari", name: "Kari", kind: "son", birthDate: "2009-12-11" },
  { id: "brynja", name: "Brynja", kind: "child" },
];
const edge = (id, type, fromId, toId) => ({ id, type, status: "confirmed", fromId, toId });
const edges = [
  edge("e1", "parent_of", "gunnar", "self"), edge("e2", "parent_of", "hekla", "self"), edge("e3", "spouse_of", "asta", "self"),
  edge("e4", "sibling_of", "self", "sigrun"), edge("e5", "sibling_of", "self", "thora"),
  ...["ylfa", "einar", "kari", "brynja"].map((id, index) => edge(`c${index}`, "parent_of", "self", id)),
];
const context = buildPeopleContext({ self, people, edges, events: [] });

test("own children by gender; unknown gender named apart", () => {
  assert.equal(answerPeopleQuestion("how many sons do I have?", context), "You have 2 sons: Einar, Kari.\nNot recorded as son or daughter: Brynja.");
  assert.equal(answerPeopleQuestion("list my daughters", context), "Your daughter: Ylfa.\nNot recorded as son or daughter: Brynja.");
  assert.equal(answerPeopleQuestion("how many kids do I have?", context), "You have 4 children: Ylfa, Einar, Kari, Brynja.");
});

test("chains and compound questions filter too", () => {
  assert.equal(answerPeopleQuestion("how many daughters do my parents have?", context), "Your parents have 2 daughters: Sigrun Arason, Thora Arason.");
  assert.equal(answerPeopleQuestion("when were my wife and sons born?", context), "Asta Jonsdottir — birth date not recorded yet\nEinar — 25 Sep 2005\nKari — 11 Dec 2009");
  assert.doesNotMatch(answerPeopleQuestion("who are my sisters and sons?", context), /Ylfa|Brynja — /);
});

test("pronoun follow-ups keep the filter", () => {
  const resolved = resolvePronouns("how many daughters does she have?", "who is my mother?");
  assert.equal(resolved.question, "how many daughters does my mother have?");
  assert.equal(answerPeopleQuestion(resolved.question, context), "Your mother has 2 daughters: Sigrun Arason, Thora Arason.");
});

test("counts agree in number: 1 son, 2 sons", async () => {
  const { countOf } = await import("../src/services/graph/peopleGrounding.js");
  assert.equal(countOf(1, "sons"), "1 son");
  assert.equal(countOf(2, "sons"), "2 sons");
  assert.equal(countOf(1, "children"), "1 child");
  assert.equal(countOf(0, "daughters"), "0 daughters");
  assert.equal(answerPeopleQuestion("how many sons does my mother have?", context), "Your mother has 1 son: Bjorn Arason (you).");
  assert.equal(answerPeopleQuestion("how many daughters do I have?", context), "You have 1 daughter: Ylfa.\nNot recorded as son or daughter: Brynja.");
  assert.equal(answerPeopleQuestion("list my daughters", context), "Your daughter: Ylfa.\nNot recorded as son or daughter: Brynja.");
  assert.equal(answerPeopleQuestion("how many sisters do I have?", context), "You have 2 sisters: Sigrun Arason, Thora Arason.");
  const one = buildPeopleContext({ self, people: [self, people.find((person) => person.id === "einar")], edges: [edge("c", "parent_of", "self", "einar")], events: [] });
  assert.equal(answerPeopleQuestion("how many kids do I have?", one), "You have 1 child: Einar.");
});
