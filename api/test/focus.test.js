import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { isFocusQuestion, relativeDay } from "../src/services/focus.js";

// "What should I focus on?" answers from dated records: overdue, under way, coming up, recent, waiting.

test("focus questions are recognised; other questions are not", () => {
  for (const q of ["What should I focus on this week?", "what's coming up?", "Help me prioritise", "What should I do next?", "next steps?"]) assert.equal(isFocusQuestion(q), true, q);
  for (const q of ["How much did the focus group cost?", "which cars are registered?", "who are my sisters?"]) assert.equal(isFocusQuestion(q), false, q);
});

test("relativeDay", () => {
  const today = new Date("2026-11-18T00:00:00Z");
  assert.equal(relativeDay(new Date("2026-11-18T15:00:00Z"), today), "today");
  assert.equal(relativeDay(new Date("2026-11-19T00:00:00Z"), today), "tomorrow");
  assert.equal(relativeDay(new Date("2026-12-22T00:00:00Z"), today), "in 34 days");
  assert.equal(relativeDay(new Date("2026-11-13T00:00:00Z"), today), "5 days ago");
});

test("focus answers: compact dated context, one model call, code list without a model", async (t) => {
  const calls = [];
  let modelUp = true;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push(JSON.parse(body || "{}"));
      if (!modelUp) {
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "stub down" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "stub", object: "chat.completion", created: 0, model: "stub", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "1. Pay the insurance renewal, overdue." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = {};
  for (const [name, value] of Object.entries({ OPENAI_BASE_URL: `${base}/v1`, GROQ_BASE_URL: `${base}/groq/v1`, OPENAI_API_KEY: "sk-test-stub", GROQ_API_KEY: "gsk-test-stub", DIRA_BRIDGE: "off" })) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
    server.close();
  });

  const { prisma } = await import("../src/prisma.js");
  const { chat } = await import("../src/services/lifeAdvisor.js");
  const { focusContext } = await import("../src/services/focus.js");
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `focus-${stamp}@example.com`, handle: `focus${stamp}`, name: "Ada Tester" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const day = (offset) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
  };
  const event = (data) => prisma.event.create({ data: { userId: user.id, eventType: "personal", ...data } });
  await event({ title: "Insurance renewal", dueAt: day(-3), occurredAt: day(-30) });
  await event({ title: "Cabin stay", occurredAt: day(-2), endsAt: day(3), people: [{ name: "Bo Linden", role: "mentioned" }] });
  await event({ title: "Trip to Lakeview", occurredAt: day(20), endsAt: day(27), financials: { amount: 1200, currency: "EUR" } });
  await event({ title: "Roof repair", occurredAt: day(-5) });
  await event({ title: "Old dinner", occurredAt: day(-40) });
  await event({ title: "Far conference", occurredAt: day(90) });
  await event({ title: "Cancelled concert", occurredAt: day(10), status: "archived" });
  await prisma.inputQueue.create({ data: { userId: user.id, rawContent: "A note to confirm", contentType: "text", source: "manual", processingStatus: "processing" } });

  const context = await focusContext(user.id);
  assert.deepEqual(context.due.map((item) => item.event.title), ["Insurance renewal"]);
  assert.equal(context.due[0].when, "overdue, was due 3 days ago");
  assert.deepEqual(context.ongoing.map((item) => item.event.title), ["Cabin stay"]);
  assert.equal(context.ongoing[0].when, "under way, ends in 3 days");
  assert.deepEqual(context.upcoming.map((item) => item.event.title), ["Trip to Lakeview"]);
  assert.match(context.upcoming[0].text, /^Trip to Lakeview, \d+ \w+ \d{4} → \d+ \w+ \d{4}, 1,200 EUR — starts in 20 days/);
  assert.deepEqual(context.recent.map((item) => item.event.title), ["Roof repair"], "the stay under way is not listed again as recent");
  assert.equal(context.waiting, 1);

  await t.test("one model call with the dated context and the no-generic-advice rules", async () => {
    calls.length = 0;
    const answer = await chat([{ role: "user", content: "What should I focus on this week?" }], user.id);
    assert.equal(answer.reply, "1. Pay the insurance renewal, overdue.");
    assert.equal(calls.length, 1);
    const system = calls[0].messages[0].content;
    assert.match(system, /OVERDUE OR DUE SOON:\n- Insurance renewal/);
    assert.match(system, /UNDER WAY NOW:\n- Cabin stay, .* with Bo Linden — under way, ends in 3 days/);
    assert.match(system, /COMING UP \(next 60 days\):\n- Trip to Lakeview/);
    assert.match(system, /WAITING FOR THE USER TO CONFIRM: 1 saved input\n/);
    assert.match(system, /No generic advice/);
    assert.doesNotMatch(system, /Old dinner|Far conference|Cancelled concert/);
    assert.ok(system.length < 3000, `compact context (${system.length} chars)`);
  });

  await t.test("no model: the same items as numbered actions, most urgent first", async () => {
    modelUp = false;
    const answer = await chat([{ role: "user", content: "What should I focus on?" }], user.id);
    const lines = answer.reply.split("\n");
    assert.match(lines[1], /^1\. Insurance renewal: overdue, was due 3 days ago\.$/);
    assert.match(lines[2], /^2\. Cabin stay: under way, ends in 3 days\.$/);
    assert.match(lines[3], /^3\. Get ready for Trip to Lakeview: .* \(in 20 days\)\.$/);
    assert.match(lines[4], /^4\. Confirm the 1 saved input waiting in the queue\.$/);
    modelUp = true;
  });
});
