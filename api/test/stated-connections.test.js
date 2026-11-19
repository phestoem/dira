import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import Fastify from "fastify";

// "X is the mother of my children, except Y" about people who are records: a card listing each connection to add,
// exceptions left out; nothing is written until the user confirms. A message that states a relationship is never
// taken as a yes to something offered earlier.

test("statement → card → confirm writes only the chosen connections", async (t) => {
  let routerReply = null;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const system = String(JSON.parse(body || "{}").messages?.[0]?.content || "");
      if (routerReply && /followUp/.test(system)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "stub", object: "chat.completion", created: 0, model: "stub", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(routerReply) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }
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
  const { answerPeopleQuestion, loadPeopleContext } = await import("../src/services/graph/peopleGrounding.js");
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `connect-${stamp}@example.com`, handle: `connect${stamp}`, name: "Bjorn Arason" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const person = (name, kind, extra = {}) => prisma.entity.create({ data: { userId: user.id, entityType: "person", name, kind, ...extra } });
  const self = await person("Bjorn Arason", "self", { isSelf: true });
  const asta = await person("Asta Jonsdottir", "wife");
  const ylfa = await person("Ylfa", "daughter");
  const einar = await person("Einar", "son");
  const kari = await person("Kari", "son");
  const edge = (fromId, type, toId) => prisma.relationship.create({ data: { userId: user.id, fromKind: "entity", fromId, toKind: "entity", toId, type, category: "family", status: "confirmed", source: "user" } });
  await edge(asta.id, "spouse_of", self.id);
  for (const child of [ylfa, einar, kari]) await edge(self.id, "parent_of", child.id);

  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    request.userId = user.id;
  });
  await app.register(homeRoutes);
  t.after(() => app.close());
  const input = (message, history = []) => app.inject({ method: "POST", url: "/home/input", payload: { message, conversationHistory: history } }).then((r) => r.json());
  const confirm = (sessionId, extra = {}) => app.inject({ method: "POST", url: "/home/confirm", payload: { sessionId, confirmed: true, ...extra } }).then((r) => r.json());
  const count = () => prisma.relationship.count({ where: { userId: user.id } });
  const events = () => prisma.event.count({ where: { userId: user.id } });

  const before = await count();
  const card = await input("Asta is the mother of my children, except Ylfa.");
  assert.equal(card.result.type, "relationship_preview");
  assert.equal(card.result.confirmationText, "Save these 2 connections? Left out, as you said: Ylfa.");
  assert.deepEqual(card.result.content.edges.map((item) => item.line).sort(), ["Asta Jonsdottir — mother of Einar", "Asta Jonsdottir — mother of Kari"]);
  assert.equal(await count(), before, "nothing written before the confirm");

  await t.test("confirm with one unticked: only the chosen one is written, confirmed", async () => {
    const chosen = card.result.content.edges.find((item) => / Einar$/.test(item.line)).id;
    const done = await confirm(card.sessionId, { selectedEdgeIds: [chosen] });
    assert.equal(done.result.content.message, "Connections saved: 1.");
    const written = await prisma.relationship.findMany({ where: { userId: user.id, fromId: asta.id, type: "parent_of" } });
    assert.deepEqual(written.map((row) => [row.toId, row.status, row.source, row.attributes.parentRole]), [[einar.id, "confirmed", "user", "mother"]]);
    assert.equal(answerPeopleQuestion("who are my wife's children?", await loadPeopleContext(user.id)), "Your wife's children: Einar — your son.");
  });

  await t.test("said again: the recorded one is not proposed twice", async () => {
    const again = await input("Asta Jonsdottir is the mother of Einar and Kari");
    assert.deepEqual(again.result.content.edges.map((item) => item.line), ["Asta Jonsdottir — mother of Kari"]);
  });

  await t.test("after an offer, the statement is still a card, never the offered fact saved", async () => {
    routerReply = { intent: "relationship_add", confidence: 0.92, interpretation: "Save a connection.", extractedData: {}, alternatives: [], followUp: { action: "accept", fact: "Asta Jonsdottir lives in the family home in Reykjavik." } };
    const history = [{ role: "user", content: "Asta lives in Reykjavik" }, { role: "assistant", content: "Do you want me to note that Asta lives in Reykjavik?" }];
    const eventsBefore = await events();
    const reply = await input("Asta is the mother of my children, except Ylfa", history);
    routerReply = null;
    assert.equal(reply.result.type, "relationship_preview");
    assert.equal(await events(), eventsBefore, "no event saved");
  });
});
