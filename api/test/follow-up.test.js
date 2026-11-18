import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { looksLikeContinuation } from "../src/services/followUp.js";

// A follow-up right after a save is offered to that event ("Add to <title>?") instead of becoming a new one.
// A local server plays the model: the router call fails (so the code router decides), the understanding call
// answers from a fixed table.

test("looksLikeContinuation: openers and shared title words, not unrelated saves", () => {
  for (const text of ["Also booked the ferry", "We come back on 17 March", "and the hotel is paid", "Returning on the 20th", "The Lakeview cabin has two rooms"]) {
    assert.equal(looksLikeContinuation(text, "Trip to Lakeview"), true, text);
  }
  for (const text of ["Paid the electricity bill", "Bo Linden called about the roof", ""]) {
    assert.equal(looksLikeContinuation(text, "Trip to Lakeview"), false, text);
  }
});

const UNDERSTOOD = [
  [/^Trip to Lakeview/, { title: "Trip to Lakeview", contentType: "schedule", people: ["Bo Linden"], location: "Lakeview", occurredAt: "2027-03-10", summary: "A trip to Lakeview with Bo Linden.", confidence: 0.9, financial: { hasFinancials: false } }],
  [/^We'll also take Cy Marsh/, { title: "Flights for the trip", contentType: "notes", people: ["Bo Linden", "Cy Marsh"], summary: "Cy Marsh joins; flights cost 1200 EUR.", confidence: 0.9, financial: { hasFinancials: true, totalAmount: 1200, currency: "EUR", direction: "expense", items: [] } }],
  [/^Paid the electricity bill/, { title: "Electricity bill", contentType: "notes", people: [], summary: "Paid the electricity bill.", confidence: 0.9, financial: { hasFinancials: false } }],
  [/^Also renewed the car insurance/, { title: "Car insurance", contentType: "notes", people: [], summary: "Renewed the car insurance.", confidence: 0.9, financial: { hasFinancials: false } }],
];

test("follow-ups attach to the event just saved", async (t) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const system = String(parsed.messages?.[0]?.content || "");
      const user = String(parsed.messages?.at(-1)?.content || "");
      const hit = system.includes("context engine") && UNDERSTOOD.find(([pattern]) => pattern.test(user));
      if (!hit) {
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "stub: unavailable" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "stub", object: "chat.completion", created: 0, model: "stub", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(hit[1]) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = {};
  for (const [name, value] of Object.entries({ OPENAI_BASE_URL: `${base}/v1`, GROQ_BASE_URL: `${base}/groq/v1`, OPENAI_API_KEY: "sk-test-stub", GROQ_API_KEY: "gsk-test-stub", DIRA_BRIDGE: "off", DIRA_FACT_CHIPS: "off", DIRA_AUTO_EXTRACT: "off" })) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
    server.close();
  });

  const { prisma } = await import("../src/prisma.js");
  const homeRoutes = (await import("../src/routes/home.js")).default;
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `follow-${stamp}@example.com`, handle: `follow${stamp}`, name: "Ada Tester" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    request.userId = user.id;
  });
  await app.register(homeRoutes);
  t.after(() => app.close());

  const input = (message, lastAction) => app.inject({ method: "POST", url: "/home/input", payload: { message, conversationHistory: [], lastAction } }).then((r) => r.json());
  const confirm = (sessionId, extra = {}) => app.inject({ method: "POST", url: "/home/confirm", payload: { sessionId, confirmed: true, ...extra } }).then((r) => r.json());
  const savedAction = (response) => ({ sessionId: response.sessionId, intent: "intake_text", summary: response.result.content?.message || "", saved: true });

  const first = await input("Trip to Lakeview with Bo Linden from 10 March 2027.");
  assert.equal(first.result.type, "understanding");
  const done = await confirm(first.sessionId);
  assert.equal(done.result.type, "saved");
  const eventId = done.result.content.eventId;

  let after = savedAction(done);
  await t.test("a message that continues the save is offered to that event, then merged into it", async () => {
    const offer = await input("We'll also take Cy Marsh, and the flights cost 1,200 EUR.", after);
    assert.equal(offer.result.type, "clarification");
    assert.equal(offer.result.content.prompt, "Add to “Trip to Lakeview”?");
    assert.deepEqual(offer.clarificationOptions.map((option) => option.intent), ["attach", "new"]);
    const added = await confirm(offer.sessionId, { selectedOption: "attach" });
    assert.equal(added.result.type, "saved");
    assert.equal(added.result.content.eventId, eventId);
    assert.equal(added.result.content.message, "Added to Trip to Lakeview: with Cy Marsh, 1,200 EUR.");
    after = savedAction(added);

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    assert.deepEqual(event.people.map((person) => person.name), ["Bo Linden", "Cy Marsh"], "Bo Linden is not added twice");
    assert.equal(event.financials.amount, 1200);
    assert.equal(event.occurredAt.toISOString().slice(0, 10), "2027-03-10", "the date it had is kept");
    assert.match(event.rawInput, /Trip to Lakeview[\s\S]*\n\nWe'll also take Cy Marsh/);
    assert.equal(await prisma.event.count({ where: { userId: user.id } }), 1, "no second event");
  });

  await t.test("\"Save as new\" shows the normal preview, which saves its own event", async () => {
    const offer = await input("Also renewed the car insurance today.", after);
    assert.equal(offer.result.type, "clarification");
    const preview = await confirm(offer.sessionId, { selectedOption: "new" });
    assert.equal(preview.result.type, "understanding");
    assert.equal(preview.result.content.understood.title, "Car insurance");
    const saved = await confirm(preview.sessionId);
    assert.equal(saved.result.type, "saved");
    assert.notEqual(saved.result.content.eventId, eventId);
    after = savedAction(saved);
  });

  await t.test("an unrelated message after a save goes straight to its own preview", async () => {
    const preview = await input("Paid the electricity bill for March.", after);
    assert.equal(preview.result.type, "understanding");
    assert.equal(preview.result.content.understood.title, "Electricity bill");
  });

  await t.test("without a save just before, there is no offer", async () => {
    const preview = await input("We'll also take Cy Marsh, and the flights cost 1,200 EUR.", { sessionId: null, intent: "question", summary: "", saved: false });
    assert.equal(preview.result.type, "understanding");
  });
});
