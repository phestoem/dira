import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import Fastify from "fastify";

// Journal entries are sealed by default; "Share with Altimetrix" is per entry and starts off. A local server plays
// Altimetrix and the model and records every call.

function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, tries = 100) {
  for (let i = 0; i < tries && !(await check()); i += 1) await settle(20);
}

test("journal: sealed by default, shared per entry", async (t) => {
  const calls = { ingest: [], context: [], model: 0 };
  let failIngest = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url.startsWith("/alt/life-events/ingest")) {
        calls.ingest.push(JSON.parse(body));
        if (failIngest-- > 0) {
          res.writeHead(503);
          return res.end("down");
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ received: true }));
      }
      if (req.url.startsWith("/alt/")) {
        calls.context.push({ url: req.url, body });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ context: "From Altimetrix.", memoriesFound: 1, threadsFound: 0 }));
      }
      // The model: every journal entry reads as a vision, so the sealed-vision path is exercised.
      calls.model += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "stub", object: "chat.completion", created: 0, model: "stub",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
          isVision: true, confidence: 0.9, title: "Build a reading cabin", summary: "A cabin by the lake.", tags: ["cabin", "reading"], location: "Lakeview",
        }) } }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  withEnv(t, {
    OPENAI_BASE_URL: `${base}/v1`,
    GROQ_BASE_URL: `${base}/groq/v1`,
    OPENAI_API_KEY: "sk-test-stub",
    GROQ_API_KEY: "gsk-test-stub",
    ALTIMETRIX_URL: `${base}/alt`,
    ALTIMETRIX_BRIDGE_SECRET: "test-secret",
    ALTIMETRIX_RETRY_MS: "10",
    DIRA_BRIDGE: undefined,
    DIRA_BRIDGE_JOURNAL: undefined,
    DIRA_AUTO_EXTRACT: undefined,
  });
  t.after(() => server.close());

  const { prisma } = await import("../src/prisma.js");
  const { syncPendingEvents } = await import("../src/services/altimetrixBridge.js");
  const journalRoutes = (await import("../src/routes/journal.js")).default;

  const stamp = Date.now();
  const user = await prisma.user.create({
    data: { email: `journal-${stamp}@example.com`, handle: `journal${stamp}`, name: "Ada Tester", altimetrixUserId: `alt-j-${stamp}` },
  });
  const other = await prisma.user.create({ data: { email: `journal-o-${stamp}@example.com`, handle: `journalo${stamp}`, name: "Other Tester" } });
  t.after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } }).catch(() => {});
    await prisma.$disconnect();
  });
  const self = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Ada Tester", isSelf: true } });
  const bo = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Bo Linden" } });
  await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Cy Marsh" } });
  await prisma.relationship.create({ data: { userId: user.id, fromKind: "entity", fromId: bo.id, toKind: "entity", toId: self.id, type: "sibling_of", category: "family", status: "confirmed", source: "user" } });

  let asUser = user.id;
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    request.userId = asUser;
  });
  await app.register(journalRoutes);
  t.after(() => app.close());
  const patch = (id, payload) => app.inject({ method: "PATCH", url: `/journal/${id}`, payload });
  const stored = (id) => prisma.diaryEntry.findUnique({ where: { id } });

  let entryId;
  await t.test("a new entry is sealed: nothing goes to Altimetrix, not even through a vision found in it", async () => {
    const response = await app.inject({ method: "POST", url: "/journal", payload: { content: "Walked with Bo Linden and Cy Marsh.\nI want a reading cabin at Lakeview." } });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    entryId = body.id;
    assert.equal(body.sharedWithAltimetrix, false);
    assert.equal(body.sentToAltimetrixAt, null);
    await until(async () => (await prisma.vision.count({ where: { userId: user.id } })) > 0);
    assert.equal(await prisma.vision.count({ where: { userId: user.id } }), 1, "the vision was still found");
    await settle();
    assert.equal(calls.ingest.length, 0);
    assert.equal(calls.context.length, 0, "the vision did not ask Altimetrix for context");
    assert.equal((await syncPendingEvents(user.id, user)).sent, 0, "a sync does not send sealed entries");
    assert.equal(calls.ingest.length, 0);
    const list = (await app.inject({ method: "GET", url: "/journal" })).json();
    assert.equal(list.entries.find((entry) => entry.id === entryId).sharedWithAltimetrix, false);
  });

  await t.test("bad input and other users' entries are refused", async () => {
    assert.equal((await patch(entryId, { sharedWithAltimetrix: "yes" })).statusCode, 400);
    asUser = other.id;
    assert.equal((await patch(entryId, { sharedWithAltimetrix: true })).statusCode, 404);
    asUser = user.id;
    assert.equal((await stored(entryId)).sharedWithAltimetrix, false);
    assert.equal(calls.ingest.length, 0);
  });

  await t.test("DIRA_BRIDGE_JOURNAL=off: the toggle is kept but nothing is sent until the flag is back on", async () => {
    process.env.DIRA_BRIDGE_JOURNAL = "off";
    const response = await patch(entryId, { sharedWithAltimetrix: true });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sharedWithAltimetrix, true);
    await settle();
    assert.equal((await syncPendingEvents(user.id, user)).sent, 0);
    assert.equal(calls.ingest.length, 0);
    assert.equal((await stored(entryId)).sentToAltimetrixAt, null);
    await patch(entryId, { sharedWithAltimetrix: false });
    delete process.env.DIRA_BRIDGE_JOURNAL;
  });

  await t.test("turned on: sent once, unconfirmed people masked, retried on failure", async () => {
    failIngest = 1;
    const response = await patch(entryId, { sharedWithAltimetrix: true });
    assert.equal(response.json().sharedWithAltimetrix, true);
    await until(async () => Boolean((await stored(entryId)).sentToAltimetrixAt));
    assert.equal(calls.ingest.length, 2, "the first attempt failed with 503 and was retried");
    const sent = calls.ingest.at(-1);
    assert.equal(sent.eventType, "journal");
    assert.equal(sent.sourceEventId, `journal:${entryId}`);
    assert.equal(sent.title, "Walked with Bo Linden and someone.");
    assert.equal(sent.context, "Walked with Bo Linden and someone.\nI want a reading cabin at Lakeview.");
    assert.doesNotMatch(JSON.stringify(sent), /Cy Marsh/);
    assert.deepEqual(sent.people, []);
    assert.equal((await syncPendingEvents(user.id, user)).sent, 0, "a sent entry is not sent again");
    assert.equal(calls.ingest.length, 2);
  });

  await t.test("Altimetrix down: the entry stays shared and unsent, and the next sync sends it", async () => {
    const second = await prisma.diaryEntry.create({ data: { userId: user.id, rawContent: "Quiet evening." } });
    failIngest = 10;
    const before = calls.ingest.length;
    await patch(second.id, { sharedWithAltimetrix: true });
    await until(() => calls.ingest.length - before >= 3);
    await settle();
    assert.equal(calls.ingest.length - before, 3);
    assert.equal((await stored(second.id)).sentToAltimetrixAt, null);
    failIngest = 0;
    assert.equal((await syncPendingEvents(user.id, user)).sent, 1);
    assert.ok((await stored(second.id)).sentToAltimetrixAt);
  });

  await t.test("turned off after sending: stays off, the sent time is kept, nothing more goes out", async () => {
    const before = calls.ingest.length;
    const response = await patch(entryId, { sharedWithAltimetrix: false });
    assert.equal(response.json().sharedWithAltimetrix, false);
    assert.ok(response.json().sentToAltimetrixAt);
    await patch(entryId, { sharedWithAltimetrix: true });
    await settle();
    assert.equal((await syncPendingEvents(user.id, user)).sent, 0);
    assert.equal(calls.ingest.length, before);
  });
});
