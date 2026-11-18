import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { modelErrorKind, modelErrorMessage, modelStatus } from "../src/services/modelStatus.js";

// No real model is called: a local server plays OpenAI (out of credit) and Groq (down).

test("model errors are told apart: no credit, rate limit, key, timeout", () => {
  assert.equal(modelErrorKind({ status: 429, code: "insufficient_quota", message: "You exceeded your current quota" }), "no_credit");
  assert.equal(modelErrorKind({ status: 429, message: "429 You have no credits remaining." }), "no_credit");
  assert.equal(modelErrorKind({ status: 429, message: "Rate limit reached for gpt-4o-mini" }), "rate_limit");
  assert.equal(modelErrorKind({ status: 401, message: "Incorrect API key provided" }), "auth");
  assert.equal(modelErrorKind(new Error("OPENAI_API_KEY is not set")), "auth");
  assert.equal(modelErrorKind(Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" })), "timeout");
  assert.equal(modelErrorKind({ status: 503, message: "Groq advisor status 503" }), "unavailable");
  assert.match(modelErrorMessage("no_credit"), /no credit/);
});

test("without any model: open questions get the records, saves become plain notes, routing falls back", async (t) => {
  const calls = { openai: 0, groq: 0 };
  const server = createServer((req, res) => {
    const groq = req.url.startsWith("/groq");
    calls[groq ? "groq" : "openai"] += 1;
    req.resume();
    req.on("end", () => {
      if (groq) {
        res.writeHead(503, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "service unavailable" } }));
      }
      res.writeHead(429, { "content-type": "application/json", "x-should-retry": "false" });
      res.end(JSON.stringify({ error: { message: "You have no credits remaining.", type: "insufficient_quota", code: "insufficient_quota" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = { openaiBase: process.env.OPENAI_BASE_URL, groqBase: process.env.GROQ_BASE_URL, openai: process.env.OPENAI_API_KEY, groq: process.env.GROQ_API_KEY };
  Object.assign(process.env, { OPENAI_BASE_URL: `${base}/v1`, GROQ_BASE_URL: `${base}/groq/v1`, OPENAI_API_KEY: "sk-test-stub", GROQ_API_KEY: "gsk-test-stub" });
  t.after(() => {
    server.close();
    for (const [name, value] of [["OPENAI_BASE_URL", saved.openaiBase], ["GROQ_BASE_URL", saved.groqBase], ["OPENAI_API_KEY", saved.openai], ["GROQ_API_KEY", saved.groq]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const { prisma } = await import("../src/prisma.js");
  const { chat } = await import("../src/services/lifeAdvisor.js");
  const { understandText } = await import("../src/services/contextEngine.js");
  const { routeIntent } = await import("../src/services/intentRouter.js");
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `nomodel-${stamp}@example.com`, handle: `nomodel${stamp}`, name: "Ada Tester" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  await prisma.event.create({ data: { userId: user.id, title: "Roof repair at the lake cabin", eventType: "project_update", understoodMeaning: "Paid the roofer for the lake cabin." } });

  const answer = await chat([{ role: "user", content: "what happened with the lake cabin roof?" }], user.id);
  assert.match(answer.reply, /no credit/);
  assert.match(answer.reply, /Roof repair at the lake cabin/, "the matching record is in the reply");

  const note = await understandText("Met the plumber about the kitchen sink on Tuesday.", user.id);
  assert.equal(note.understood.title, "Met the plumber about the kitchen sink on Tuesday.");
  assert.match(note.understood.needsClarification, /plain note/);

  const routed = await routeIntent("Met the plumber about the kitchen sink on Tuesday.", user.id, null, [], null);
  assert.ok(routed.intent, "the heuristic router still decides");

  assert.ok(calls.openai >= 3 && calls.groq >= 1, "OpenAI was tried and Groq was tried as the fallback");
  const status = modelStatus();
  assert.equal(status.openai.ok, false);
  assert.equal(status.openai.lastError.kind, "no_credit");
  assert.equal(status.groq.ok, false);
});
