import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import OpenAI from "openai";

// Token and latency logging: a local server plays OpenAI and Groq; no real model is called.

test("token logging: one line per request, background calls on their own, daily totals, no content", async (t) => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url.startsWith("/alt/")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ usage: { prompt_tokens: 999 } }));
      }
      if (req.url.includes("fail")) {
        res.writeHead(429, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "rate limited" } }));
      }
      const groq = req.url.startsWith("/groq");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "stub", object: "chat.completion", created: 0, model: groq ? "llama-stub" : "gpt-stub",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "SECRET ANSWER TEXT" } }],
        usage: groq
          ? { prompt_tokens: 50, completion_tokens: 5 }
          : { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 1024 }, completion_tokens_details: { reasoning_tokens: 30 } },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "dira-tokens-"));
  const saved = { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, GROQ_BASE_URL: process.env.GROQ_BASE_URL, DIRA_TOKEN_LOG: process.env.DIRA_TOKEN_LOG };
  Object.assign(process.env, { OPENAI_BASE_URL: `${base}/v1`, GROQ_BASE_URL: `${base}/groq/v1`, DIRA_TOKEN_LOG: join(dir, "tokens.jsonl") });
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
    server.close();
  });

  const lines = [];
  const log = console.log;
  console.log = (...args) => {
    const text = args.join(" ");
    if (text.startsWith("[tokens]")) lines.push(text);
    else log(...args);
  };
  t.after(() => (console.log = log));

  const { finishRequest, startRequest, tokenTotals } = await import("../src/metrics.js");
  const app = Fastify();
  app.addHook("onRequest", (request, reply, done) => startRequest(request, done));
  app.addHook("onResponse", async (request, reply) => finishRequest(request, reply));
  let background;
  app.post("/ask/:id", async () => {
    const client = new OpenAI({ apiKey: "sk-test-stub" });
    await client.chat.completions.create({ model: "gpt-stub", messages: [{ role: "user", content: "SECRET QUESTION TEXT" }] });
    const groq = await fetch(`${base}/groq/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "llama-stub", messages: [] }) });
    await groq.json();
    await fetch(`${base}/alt/bridge/context`, { method: "POST", body: "{}" }).then((r) => r.json());
    background = new Promise((resolve) => setTimeout(async () => {
      await fetch(`${base}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-stub" }) }).then((r) => r.json());
      resolve();
    }, 30));
    return { ok: true };
  });
  app.get("/quiet", async () => ({ ok: true }));
  app.post("/fail", async () => {
    await fetch(`${base}/v1/fail/chat/completions`, { method: "POST", body: JSON.stringify({ model: "gpt-stub" }) });
    return { ok: false };
  });
  t.after(() => app.close());

  const response = await app.inject({ method: "POST", url: "/ask/123e4567", payload: {} });
  assert.equal(response.statusCode, 200);
  await background;
  await app.inject({ method: "GET", url: "/quiet" });
  await app.inject({ method: "POST", url: "/fail" });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(lines.length, 3, lines.join("\n"));
  const [request, later, failed] = lines;
  assert.match(request, /^\[tokens\] POST \/ask\/:id 200 \d+ms calls=2 in=1250 cached=1024 out=85 reasoning=30 \|/);
  assert.match(request, /openai\/gpt-stub \S+ in=1200 cached=1024 out=80 reasoning=30 \d+ms 200/);
  assert.match(request, /groq\/llama-stub \S+ in=50 cached=0 out=5 reasoning=0 \d+ms 200/);
  assert.doesNotMatch(request, /999/, "an Altimetrix call on the same host is not a model call");
  assert.match(request, /metrics\.test\.js/, "the calling function is named, through the SDK too");
  assert.match(later, /^\[tokens\] background after \/ask\/:id \d+ms calls=1 in=1200/);
  assert.match(failed, /^\[tokens\] POST \/fail 200 \d+ms calls=1 in=0 .*\b429$/);
  assert.equal(lines.some((line) => line.includes("/quiet")), false, "requests without a model call are not logged");
  assert.doesNotMatch(lines.join("\n"), /SECRET|123e4567/, "no prompt, answer or id in the log");

  const json = readFileSync(join(dir, "tokens.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(json.map((entry) => entry.kind), ["request", "background", "request"]);
  assert.deepEqual(json[0].totals, { calls: 2, input: 1250, cached: 1024, output: 85, reasoning: 30 });
  assert.doesNotMatch(JSON.stringify(json), /SECRET/);

  const { today } = tokenTotals();
  assert.equal(today.calls, 4);
  assert.equal(today.failed, 1);
  assert.equal(today.requests, 2);
  assert.equal(today.input, 2450);
  assert.deepEqual(today.byModel["groq/llama-stub"], { calls: 1, input: 50, cached: 0, output: 5, reasoning: 0 });
});
