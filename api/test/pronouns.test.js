import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { resolvePronouns } from "../src/services/graph/peopleGrounding.js";

// "they", "her", "his" in a follow-up refer to the people of the previous people question; when that could mean
// more than one group, DIRA asks who is meant.

test("pronouns resolve to the previous question's people, or ask", () => {
  const cases = [
    ["how many kids do they have?", "list my parents", { question: "how many kids do my parents have?" }],
    ["who is her mother?", "who are my wife and parents?", { question: "who is my wife's mother?" }],
    ["how many children does he have?", "who is my father?", { question: "how many children does my father have?" }],
    ["who are they married to?", "who are my sisters?", { question: "who are my sisters married to?" }],
    ["how many kids do they have?", "who are my wife and parents?", { ask: "Who do you mean by “they”: your wife or your parents?" }],
    ["what does he do?", "who are my sons?", { ask: "Which of your sons do you mean by “he”?" }],
    ["how are you?", "list my parents", { question: "how are you?" }],
    ["who are my wife and her parents?", "who are my sisters?", { question: "who are my wife and her parents?" }],
    ["how much did they cost?", "which properties do I own?", { question: "how much did they cost?" }],
  ];
  for (const [latest, prior, expected] of cases) assert.deepEqual(resolvePronouns(latest, prior), expected, `${latest} after ${prior}`);
});

test("through /home: a pronoun follow-up answers from records", async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub: unavailable" } }));
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
  const user = await prisma.user.create({ data: { email: `pronoun-${stamp}@example.com`, handle: `pronoun${stamp}`, name: "Bjorn Arason" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const person = (name, kind, extra = {}) => prisma.entity.create({ data: { userId: user.id, entityType: "person", name, kind, ...extra } });
  const self = await person("Bjorn Arason", "self", { isSelf: true });
  const edge = (fromId, type, toId) => prisma.relationship.create({ data: { userId: user.id, fromKind: "entity", fromId, toKind: "entity", toId, type, category: "family", status: "confirmed", source: "user" } });
  for (const [name, kind] of [["Gunnar Arason", "father"], ["Hekla Olafsdottir", "mother"]]) await edge((await person(name, kind)).id, "parent_of", self.id);
  for (const name of ["Sigrun Arason", "Thora Arason"]) await edge(self.id, "sibling_of", (await person(name, "sister")).id);
  await edge(self.id, "parent_of", (await person("Einar", "son")).id);

  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    request.userId = user.id;
  });
  await app.register(homeRoutes);
  t.after(() => app.close());
  const ask = (message, conversationHistory) => app.inject({ method: "POST", url: "/home/input", payload: { message, conversationHistory } }).then((r) => r.json());
  const reply = (response) => String(response.result?.content?.reply || response.result?.content?.message || "");

  const first = await ask("list my parents", []);
  const history = [{ role: "user", content: "list my parents" }, { role: "assistant", content: reply(first) }];
  const followUp = await ask("how many kids do they have?", history);
  assert.equal(reply(followUp), "Your parents have 3 kids: Bjorn Arason (you), Sigrun Arason, Thora Arason.");
  assert.doesNotMatch(reply(followUp), /Einar/, "not your own children");
});
