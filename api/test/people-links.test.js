import assert from "node:assert/strict";
import test from "node:test";
import { linkPeople, mentionedPeople, nameKeys } from "../src/services/peopleLinks.js";

// Mentions of confirmed people link to their records by plain name lookup; no model is involved.

const PEOPLE = [
  { id: "bo", name: "Bo Linden", aliases: ["Bobo"] },
  { id: "cy", name: "Cy Marsh", aliases: [] },
  { id: "cy2", name: "Cy Okafor", aliases: [] },
  { id: "zoe", name: "Zoë Brandt", aliases: [] },
];

test("full names, aliases and unique first names match whole words, any case or accent", () => {
  const keys = nameKeys(PEOPLE);
  assert.deepEqual(mentionedPeople("Lunch with BOBO, then cy marsh and zoe brandt", keys).map((p) => p.id), ["bo", "cy", "zoe"]);
  assert.deepEqual(mentionedPeople("Zoë called; Bo will drive", keys).map((p) => p.id), ["zoe"], "a unique first name links; a 2-letter one alone does not");
  assert.deepEqual(mentionedPeople("Cy called", keys), [], "two confirmed people are called Cy: no guess");
  assert.deepEqual(mentionedPeople("Bought a boat in Boston", keys), [], "no match inside other words");
  assert.deepEqual(mentionedPeople("Bo Linden and Bo again", keys).map((p) => p.id), ["bo"], "each person once");
});

test("linkPeople adds ids to plain names, adds mentioned people, keeps unknown names", () => {
  const keys = nameKeys(PEOPLE);
  const out = linkPeople([{ name: "Bo Linden", role: "mentioned" }, { name: "Dee Park", role: "mentioned" }], "Dinner with Bo Linden, Dee Park and Cy Marsh", keys);
  assert.deepEqual(out, [
    { name: "Bo Linden", entityId: "bo", role: "mentioned" },
    { name: "Dee Park", role: "mentioned" },
    { name: "Cy Marsh", entityId: "cy", role: "mentioned" },
  ]);
  assert.deepEqual(linkPeople([{ entityId: "bo", role: "vehicle" }], "Bo Linden", keys), [{ entityId: "bo", role: "vehicle" }], "an existing link is kept as it is");
});

test("saves link only confirmed people, and create no records", async (t) => {
  const { prisma } = await import("../src/prisma.js");
  const { createEventFromUnderstanding } = await import("../src/services/contextEngine.js");
  const { confirmedPeople, linkConfirmedPeople } = await import("../src/services/peopleLinks.js");
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `links-${stamp}@example.com`, handle: `links${stamp}`, name: "Ada Tester" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const self = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Ada Tester", isSelf: true } });
  const bo = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Bo Linden", aliases: ["Bobo"] } });
  const cy = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Cy Marsh" } });
  await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Eli Stone", status: "archived" } });
  await prisma.relationship.create({ data: { userId: user.id, fromKind: "entity", fromId: bo.id, toKind: "entity", toId: self.id, type: "sibling_of", category: "family", status: "confirmed", source: "user" } });
  await prisma.relationship.create({ data: { userId: user.id, fromKind: "entity", fromId: cy.id, toKind: "entity", toId: self.id, type: "friend_of", category: "social", status: "suggested", source: "extraction" } });

  assert.deepEqual((await confirmedPeople(user.id)).map((person) => person.name), ["Bo Linden"], "suggested, archived and the self are not confirmed");

  const records = await prisma.entity.count({ where: { userId: user.id } });
  const event = await createEventFromUnderstanding(user.id, {
    title: "Lunch with Bobo",
    summary: "Lunch with Bobo and Cy Marsh; Ada Tester paid.",
    people: ["Cy Marsh"],
    financial: { hasFinancials: false },
    confidence: 0.9,
  }, null, true, null);
  assert.deepEqual(event.people, [
    { name: "Cy Marsh", role: "mentioned" },
    { name: "Bo Linden", entityId: bo.id, role: "mentioned" },
  ]);
  assert.equal(await prisma.entity.count({ where: { userId: user.id } }), records, "no record was created");

  assert.deepEqual(await linkConfirmedPeople(user.id, [], "Bo Linden called about the roof."), [{ name: "Bo Linden", entityId: bo.id, role: "mentioned" }]);
});
