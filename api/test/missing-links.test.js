import assert from "node:assert/strict";
import test from "node:test";
import { entityKeys, findMissingLinks, isMissingConnectionsQuestion, mentions, missingLinksText, NOTHING_MISSING } from "../src/services/missingLinks.js";

// Synthetic records only. "Which connections are missing?" lists records that name a project, place or person but are
// not tied to it; an existing link (ref, relationship of any status, shared vision) is never suggested.

const ENTITIES = [
  { id: "self", name: "Robin Ash Vale", aliases: ["robin", "me"], entityType: "person", isSelf: true },
  { id: "dad", name: "Ash Vale", aliases: [], entityType: "person" },
  { id: "sis", name: "Wren Ash Vale", aliases: [], entityType: "person" },
  { id: "proj", name: "Harbour Cabins", aliases: [], entityType: "project", attributes: { place: "Elmstead, Northshire" } },
  { id: "town", name: "Corrin", aliases: [], entityType: "place" },
  { id: "old", name: "Old Mill", aliases: [], entityType: "project", status: "archived" },
];
const EVENT = (id, title, rawInput, extra = {}) => ({ id, title, rawInput, status: "active", people: [], places: [], ...extra });

test("the question is recognised, other uses of 'link' or 'miss' are not", () => {
  for (const text of ["Which connections are missing?", "Any links I should make?", "Which records are unlinked?", "what is not linked yet"]) assert.ok(isMissingConnectionsQuestion(text), text);
  for (const text of ["Connect Wren to Ash", "I missed my flight", "What is my link to Wren?", "Save the link to the cabin plan"]) assert.equal(isMissingConnectionsQuestion(text), false, text);
});

test("longest name wins; the own name masks a parent's name inside it", () => {
  const keys = entityKeys(ENTITIES);
  const found = (text) => mentions(text, keys).filter((item) => !item.entity.isSelf).map((item) => item.entity.id).sort();
  assert.deepEqual(found("Wren Ash Vale was born in Corrin."), ["sis", "town"]);
  assert.deepEqual(found("Robin Ash Vale signed the form."), []);
  assert.deepEqual(found("Ash Vale signed the form."), ["dad"]);
  // "Ash" is in three names: alone it names nobody.
  assert.deepEqual(found("Ash came by."), []);
  // A first name nobody else's name contains is enough.
  assert.deepEqual(found("Wren called."), ["sis"]);
});

test("unlinked mentions are suggested; existing links never are", () => {
  const events = [
    EVENT("e1", "Cement for the cabins", "Cement delivered to Harbour Cabins.", { people: [{ entityId: "proj", name: "Harbour Cabins", role: "project" }] }),
    EVENT("e2", "Elmstead fence quote", "Quote for a fence at Elmstead."),
    EVENT("e3", "Corrin trip", "Drove to Corrin.", { places: [{ name: "Corrin", role: "location" }] }),
    EVENT("e4", "Call with Wren", "Wren called about the cabins."),
    EVENT("e5", "Old Mill note", "The Old Mill roof."),
    EVENT("e6", "Lunch", "Lunch in town."),
    EVENT("e7", "Garden at Elmstead", "Planted at Elmstead."),
    EVENT("e8", "Archived Corrin note", "Corrin.", { status: "archived" }),
    EVENT("e9", "Wren's visit", "Wren visited.", {}),
  ];
  const visions = [
    { id: "v1", title: "Cabin life", status: "seed", summary: "Living at Harbour Cabins.", connectedEntities: [{ entityId: "proj" }], connectedEvents: [{ eventId: "e7" }] },
    { id: "v2", title: "Corrin market stall", status: "seed", summary: "A stall in Corrin.", connectedEntities: [], connectedEvents: [] },
  ];
  // A rejected relationship was a "no": not suggested again.
  const relationships = [{ fromId: "sis", toId: "e9" }];
  const items = findMissingLinks({ entities: ENTITIES, events, visions, relationships });
  assert.deepEqual(items.map((item) => item.id), [
    "event:e2:proj",
    "vision:v2:town",
    "event:e3:town",
    "event:e4:sis",
  ]);
  assert.match(items[0].line, /mentions its place, Elmstead/);
  assert.ok(!items.some((item) => item.entityId === "self" || item.entityId === "old"));
});

test("nothing found is said plainly", () => {
  assert.equal(missingLinksText([]), NOTHING_MISSING);
  assert.equal(findMissingLinks({ entities: ENTITIES, events: [EVENT("e1", "Lunch", "Lunch.")], visions: [], relationships: [] }).length, 0);
});
