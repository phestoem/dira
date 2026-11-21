import assert from "node:assert/strict";
import test from "node:test";
import { isVisionQuestion, isVisionReview, namedVision, nameKeys, progressFacts, sortRecords, visionAnswer, visionEvents } from "../src/services/visionReview.js";

// Synthetic visions and records only. Vision questions are answered by code from the vision and the events tied to
// it by link or name; progress statements are echoed and offered as a card, written only on confirm.

const VISIONS = [
  { id: "v1", title: "Quiet Harbour Garden Vision", status: "seed", summary: "A small food garden by the sea.", connectedEvents: [], connectedEntities: [{ name: "Elmstead", role: "location" }], createdAt: new Date("2025-03-02") },
  { id: "v2", title: "Stone Wall for Quiet Harbour", status: "seed", summary: "A stone wall around the garden.", connectedEvents: [], connectedEntities: [], createdAt: new Date("2025-03-02") },
  { id: "v3", title: "Mountain Hut", status: "active", summary: null, connectedEvents: [{ eventId: "e9" }], connectedEntities: [], createdAt: new Date("2025-04-01") },
];
const NOW = new Date("2025-06-10T12:00:00Z");
const EVENTS = [
  { id: "e1", title: "First cabin at Quiet Harbour", rawInput: "We started building the first cabin at Quiet Harbour.", occurredAt: new Date("2025-04-01"), financials: {} },
  { id: "e2", title: "Seeds bought", rawInput: "Seeds for Quiet Harbour cost 120 EUR.", financials: { amount: 120, currency: "EUR", direction: "expense" } },
  { id: "e3", title: "Autumn planting", rawInput: "We plan to plant fruit trees at Quiet Harbour in October.", occurredAt: new Date("2025-10-01"), datePrecision: "month", financials: {} },
  { id: "e4", title: "Lunch in town", rawInput: "Lunch with a friend.", financials: {} },
  { id: "e9", title: "Roof repair", rawInput: "Roof repaired.", financials: {} },
];

test("progress statements become short facts", () => {
  assert.deepEqual(progressFacts("The first cabin is finished, and the second cabin is about 40% done."), ["cabin 1 complete", "cabin 2 ~40%"]);
  assert.deepEqual(progressFacts("one cabin is complete and the second is around 40% done"), ["cabin 1 complete", "cabin 2 ~40%"]);
  assert.deepEqual(progressFacts("three sheds are built and the fourth is 10% done"), ["3 sheds complete", "shed 4 ~10%"]);
  assert.deepEqual(progressFacts("The wall is finished."), ["wall complete"]);
  assert.deepEqual(progressFacts("We started the orchard"), ["orchard started"]);
  assert.deepEqual(progressFacts("I liked the view today"), []);
  // A year is not a count.
  assert.deepEqual(progressFacts("We started the second cabin in May 2024."), ["cabin 2 started"]);
});

test("a vision is named by the distinctive part of its title; a tie asks which", () => {
  assert.equal(namedVision("revisit the quiet harbour vision", VISIONS).vision.id, "v1");
  assert.equal(namedVision("how is the mountain hut going?", VISIONS).vision.id, "v3");
  assert.match(namedVision("revisit the harbour vision", VISIONS).ask, /Which vision do you mean: “Quiet Harbour Garden Vision” or “Stone Wall for Quiet Harbour”\?/);
  assert.equal(namedVision("how many days until my trip?", VISIONS), null);
  assert.equal(isVisionQuestion("revisit Quiet Harbour Garden vision", VISIONS), true);
  assert.equal(isVisionReview("revisit Quiet Harbour Garden vision", VISIONS), true);
  // A change to make is not a review.
  assert.equal(isVisionReview("rename the Mountain Hut vision to Alpine Hut", VISIONS), false);
  assert.equal(isVisionQuestion("how many days until my trip?", VISIONS), false);
});

test("events belong to a vision by link or by its name; the answer sorts them and offers nothing", () => {
  const vision = VISIONS[0];
  const keys = nameKeys(vision, "revisit Quiet Harbour Garden vision", EVENTS);
  const records = visionEvents(vision, keys, EVENTS);
  assert.deepEqual(records.map((event) => event.id), ["e1", "e2", "e3"]);
  assert.deepEqual(visionEvents(VISIONS[2], nameKeys(VISIONS[2], "revisit mountain hut", EVENTS), EVENTS).map((event) => event.id), ["e9"]);
  const sorted = sortRecords(records, NOW);
  assert.deepEqual(sorted.done.map((event) => event.id), ["e1"]);
  assert.deepEqual(sorted.planned.map((event) => event.id), ["e3"]);
  assert.deepEqual(sorted.spent.map((event) => event.id), ["e2"]);
  const answer = visionAnswer(vision, records, [VISIONS[1]], NOW);
  assert.match(answer, /Stage: seed/);
  assert.match(answer, /Done: First cabin at Quiet Harbour \(cabin 1 started\)/);
  assert.match(answer, /Spent: 120 EUR/);
  assert.match(answer, /Planned: Autumn planting \(Oct 2025\)/);
  assert.match(answer, /Related vision: Stone Wall for Quiet Harbour \(seed\)/);
  assert.match(answer, /Not recorded: /);
  assert.doesNotMatch(answer, /\b(funding|partner|investor|grant|on track)\b/i);
  assert.doesNotMatch(answer, /Lunch/);
});

test("confirm writes only what was chosen: the linked update, the stage", async (t) => {
  for (const [name, value] of Object.entries({ DIRA_BRIDGE: "off", DIRA_AUTO_EXTRACT: "off" })) process.env[name] = value;
  const { prisma } = await import("../src/prisma.js");
  const { applyVisionProgress, visionProgress } = await import("../src/services/visionReview.js");
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `vision-${stamp}@example.com`, handle: `vision${stamp}`, name: "Ilse Varga" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const vision = await prisma.vision.create({ data: { userId: user.id, title: "Quiet Harbour Garden Vision", status: "seed", connectedEntities: [{ name: "Elmstead", role: "location" }] } });
  const statement = "one cabin is complete and the second is around 40% done";
  // Not named in the statement: the question just before names it. A question is never a progress statement.
  assert.equal(await visionProgress(user.id, statement, "how many days until my trip?"), null);
  assert.equal(await visionProgress(user.id, "is the second cabin 40% done?", "revisit Quiet Harbour vision"), null);
  const progress = await visionProgress(user.id, statement, "revisit Quiet Harbour vision");
  assert.equal(progress.vision.id, vision.id);
  assert.deepEqual(progress.facts, ["cabin 1 complete", "cabin 2 ~40%"]);
  assert.equal(progress.toStage, "active");
  assert.equal(await prisma.event.count({ where: { userId: user.id } }), 0, "nothing written before confirming");

  const proposal = { visionId: vision.id, statement, facts: progress.facts, phrase: progress.phrase, fromStage: "seed", toStage: "active" };
  const linkOnly = await applyVisionProgress(user.id, proposal, new Set(["save"]));
  assert.equal(linkOnly.written.length, 1);
  let saved = await prisma.vision.findUnique({ where: { id: vision.id } });
  assert.equal(saved.status, "seed", "stage unchanged when not chosen");
  assert.deepEqual(saved.connectedEvents, [{ eventId: linkOnly.eventId, relationship: "progress" }]);
  const event = await prisma.event.findUnique({ where: { id: linkOnly.eventId } });
  assert.equal(event.rawInput, statement);
  assert.match(event.understoodMeaning, /cabin 1 complete; cabin 2 ~40%/);
  assert.equal(event.occurredAt, null, "no date invented");
  assert.deepEqual(event.places, [{ name: "Elmstead", role: "location" }]);

  await applyVisionProgress(user.id, proposal, new Set(["stage"]));
  saved = await prisma.vision.findUnique({ where: { id: vision.id } });
  assert.equal(saved.status, "active");
  assert.equal(await prisma.event.count({ where: { userId: user.id } }), 1, "stage alone saves no event");
  // Already active: no stage item is offered again.
  assert.equal((await visionProgress(user.id, statement, "revisit Quiet Harbour vision")).toStage, null);
});
