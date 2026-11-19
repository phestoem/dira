import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { holdingMentions, holdingsAnswer, holdingsFromEvents, isPropertyListQuestion } from "../src/services/holdings.js";

// "Which properties do I own?" is listed by code from the saved records; no model call, nothing left out.

test("list questions are recognised; other property questions are not", () => {
  for (const q of ["which properties do I own?", "list my plots", "how many houses do I own?", "Which lands do I have"]) assert.equal(isPropertyListQuestion(q), true, q);
  for (const q of ["how much did I pay for the Brookfield land?", "when did I buy the house?", "what should I focus on?"]) assert.equal(isPropertyListQuestion(q), false, q);
});

test("holdings: plot numbers, kind in place, named places; one entry per plot or place", () => {
  assert.deepEqual(holdingMentions("I own two plots in Lakeview, plot numbers P1234 and P5678.").map((item) => item.label), ["Plot P1234, Lakeview", "Plot P5678, Lakeview"]);
  assert.deepEqual(holdingMentions("I have land in Hollow Creek, Ridge, and a house in Elmstead. Quiet Harbour is our place in Westmark.").map((item) => `${item.kind} ${item.label}`), ["place Quiet Harbour", "land Hollow Creek", "house Elmstead"]);
  assert.deepEqual(holdingMentions("This land in Brookfield is lovely; I came home in Oslo.").map((item) => item.label), ["Brookfield"]);
  const events = [
    { id: 1, title: "Plots", rawInput: "I own two plots in Lakeview, plot numbers P1234 and P5678." },
    { id: 2, title: "Land purchase", rawInput: "I bought land in Brookfield for 2,000,000 TSH in 2021.", occurredAt: new Date("2021-06-01T00:00:00Z") },
    { id: 3, title: "Brookfield land survey", rawInput: "Survey done.", occurredAt: new Date("2022-01-10T00:00:00Z") },
    { id: 4, title: "Holdings", rawInput: "I have land in Hollow Creek, Ridge, and a house in Elmstead. Quiet Harbour is our place in Westmark." },
    { id: 5, title: "Quiet Harbour fence project", rawInput: "New fence." },
    { id: 6, title: "Dinner", rawInput: "Dinner in Elmstead with friends." },
    { id: 7, title: "House repairs", rawInput: "Repairs on the house in Elmstead Westmark." },
  ];
  assert.equal(holdingsAnswer(holdingsFromEvents(events), "which properties do I own?"), [
    "Your properties on record (6):",
    "- Plot P1234, Lakeview — Plots",
    "- Plot P5678, Lakeview — Plots",
    "- Land in Brookfield — Land purchase, 1 Jun 2021 (+1 more record)",
    "- Land in Hollow Creek — Holdings",
    "- House in Elmstead — Holdings (+1 more record)",
    "- Quiet Harbour — Holdings (+1 more record)",
  ].join("\n"));
  assert.equal(holdingsAnswer([]), "No properties are recorded yet.");
});

test("chat answers a property list question without a model call", async (t) => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub: unavailable" } }));
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
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `holdings-${stamp}@example.com`, handle: `holdings${stamp}`, name: "Ada Tester" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  await prisma.event.create({ data: { userId: user.id, eventType: "personal", title: "Land purchase", rawInput: "I bought land in Brookfield in 2021." } });
  await prisma.event.create({ data: { userId: user.id, eventType: "personal", title: "Plots", rawInput: "Two plots in Lakeview, plot numbers P1234 and P5678." } });
  const answer = await chat([{ role: "user", content: "Which properties do I own?" }], user.id);
  assert.match(answer.reply, /^Your properties on record \(3\):/);
  assert.match(answer.reply, /Plot P1234, Lakeview/);
  assert.match(answer.reply, /Plot P5678, Lakeview/);
  assert.match(answer.reply, /Land in Brookfield/);
  assert.equal(calls, 0, "no model call");
});
