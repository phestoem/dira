import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { isTimelineQuestion, subjectTerms, timelineAnswer, timelineSubjects } from "../src/services/timeline.js";

// Timeline and progress questions: days until the next recorded date, what is recorded per thing asked about,
// what is not recorded, and only recorded progress. Code only; "on track" is never said.

const NOW = new Date("2026-11-20T09:00:00Z");
const day = (iso) => new Date(`${iso}T00:00:00Z`);
const EVENTS = [
  { id: 1, title: "Trip to Lakeview", understoodMeaning: "Trip to Lakeview with Ivy.", occurredAt: day("2026-12-10") },
  { id: 2, title: "Travel plans to Lakeview", understoodMeaning: "Ivy comes along." },
  { id: 3, title: "First flight to Lakeview", understoodMeaning: "Flew to Lakeview for studies.", occurredAt: day("2005-05-02") },
  { id: 4, title: "House purchase in Elmstead", rawInput: "Bought the house.", occurredAt: day("2026-03-13"), financials: { amount: 5000, currency: "EUR" } },
  { id: 5, title: "Renovation plans for Elmstead house", rawInput: "Walls and roof in December.", occurredAt: day("2026-12-15") },
  { id: 6, title: "Cost estimation for Elmstead project", rawInput: "The cost estimation has been completed." },
  { id: 7, title: "Quiet Harbour fence project", rawInput: "A fence for the plot." },
  { id: 8, title: "Dinner with friends", rawInput: "Dinner in Elmstead." },
];

test("timeline questions are recognised; others are not", () => {
  for (const q of ["How many days until my trip to Lakeview?", "Is the Elmstead renovation on track?", "How is the Quiet Harbour fence going?", "Where am I with Elmstead?", "what's the status of the fence project"]) assert.equal(isTimelineQuestion(q), true, q);
  for (const q of ["who is my wife?", "list my plots", "what should I focus on?"]) assert.equal(isTimelineQuestion(q), false, q);
  assert.deepEqual(subjectTerms("Is the Elmstead renovation on track?"), { names: ["elmstead"], topics: ["renovation"] });
});

test("a trip: days left, the trip's own records only, what is not recorded", () => {
  const answer = timelineAnswer("", timelineSubjects("How many days until my trip to Lakeview?", EVENTS, NOW));
  assert.equal(answer, [
    "Lakeview Trip:",
    "- Next date: Trip to Lakeview starts 10 Dec 2026, in 20 days.",
    "- Recorded (2): Trip to Lakeview (10 Dec 2026); Travel plans to Lakeview (no date).",
    "- Recorded progress: none.",
    "- Not recorded: flights, accommodation, return date, local transport, budget.",
  ].join("\n"), "the 2005 flight is not this trip");
});

test("a project: its records by name, recorded progress, missing contractor and materials; never 'on track'", () => {
  const answer = timelineAnswer("", timelineSubjects("Is the Elmstead renovation on track?", EVENTS, NOW));
  assert.match(answer, /^Elmstead Renovation:\n- Next date: Renovation plans for Elmstead house starts 15 Dec 2026, in 25 days\./);
  assert.match(answer, /- Recorded \(3\): House purchase in Elmstead \(13 Mar 2026, 5,000 EUR\); Renovation plans for Elmstead house \(15 Dec 2026\); Cost estimation for Elmstead project \(no date\)\./);
  assert.match(answer, /- Recorded progress: Cost estimation for Elmstead project\./);
  assert.match(answer, /- Not recorded: contractor, materials\./);
  assert.doesNotMatch(answer, /on track|Dinner/i);
});

test("two names, two blocks; nothing dated ahead says so", () => {
  const answer = timelineAnswer("", timelineSubjects("Where am I with Elmstead and Quiet Harbour?", EVENTS, NOW));
  const [first, second] = answer.split("\n\n");
  assert.match(first, /^Elmstead:/);
  assert.match(second, /^Quiet Harbour:\n- No upcoming date recorded\.\n- Recorded \(1\): Quiet Harbour fence project \(no date\)\.\n- Recorded progress: none\.\n- Not recorded: contractor, cost estimate, payments, materials, start or finish date\.$/);
});

test("chat answers by code with no model call, and falls through when nothing matches", async (t) => {
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
  const user = await prisma.user.create({ data: { email: `timeline-${stamp}@example.com`, handle: `timeline${stamp}`, name: "Ada Tester" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const ahead = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  await prisma.event.create({ data: { userId: user.id, eventType: "commitment", title: "Trip to Lakeview", occurredAt: new Date(Date.UTC(ahead.getUTCFullYear(), ahead.getUTCMonth(), ahead.getUTCDate())) } });
  const answer = await chat([{ role: "user", content: "How many days until my trip to Lakeview?" }], user.id);
  assert.match(answer.reply, /^Lakeview Trip:\n- Next date: Trip to Lakeview starts .*, in 20 days\./);
  assert.match(answer.reply, /Not recorded: flights, accommodation, return date, local transport, budget\./);
  assert.equal(calls, 0, "no model call");

  calls = 0;
  const casual = await chat([{ role: "user", content: "How is the weather going?" }], user.id);
  assert.ok(calls > 0, "no matching record: the normal chat path answers");
  assert.doesNotMatch(casual.reply || "", /^Weather:/);
});
