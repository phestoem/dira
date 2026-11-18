import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { flagOn, flagStatus } from "../src/services/flags.js";

// Paused features (docs/PERSONAL_SCOPE.md section 4) and the simplified Altimetrix bridge. No real model or
// Altimetrix is called: a local server plays both and counts the calls.

const FLAGS = ["DIRA_BRIDGE", "DIRA_AUTO_EXTRACT", "DIRA_GRAPH_REBUILD", "DIRA_FACT_CHIPS"];

function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("flags: the bridge defaults on, the paused features default off, and on/off words are read", () => {
  assert.deepEqual(flagStatus({}), { DIRA_BRIDGE: "on", DIRA_AUTO_EXTRACT: "off", DIRA_GRAPH_REBUILD: "off", DIRA_FACT_CHIPS: "off" });
  assert.equal(flagOn("DIRA_BRIDGE", { DIRA_BRIDGE: "off" }), false);
  assert.equal(flagOn("DIRA_BRIDGE", { DIRA_BRIDGE: "maybe" }), true, "an unknown value keeps the default");
  for (const word of ["on", "TRUE", "1", "yes"]) assert.equal(flagOn("DIRA_FACT_CHIPS", { DIRA_FACT_CHIPS: word }), true);
  for (const word of ["off", "false", "0", "No"]) assert.equal(flagOn("DIRA_BRIDGE", { DIRA_BRIDGE: word }), false);
});

test("paused features and the bridge", async (t) => {
  const calls = { model: 0, ingest: [], context: [] };
  let failIngest = 1;
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
        return res.end("{}");
      }
      if (req.url.startsWith("/alt/bridge/context")) {
        calls.context.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ context: "Felt good about the cabin.", memoriesFound: 1, threadsFound: 0 }));
      }
      calls.model += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "the model must not be called" } }));
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
  });
  for (const name of FLAGS) {
    const saved = process.env[name];
    delete process.env[name];
    t.after(() => (saved === undefined ? delete process.env[name] : (process.env[name] = saved)));
  }
  t.after(() => server.close());

  const { prisma } = await import("../src/prisma.js");
  const bridge = await import("../src/services/altimetrixBridge.js");
  const { autoExtractOn } = await import("../src/services/graph/autoExtract.js");
  const { catchUpGraphExtractions } = await import("../src/services/graph/rebuild.js");
  const { extractConversationalFacts } = await import("../src/services/intentRouter.js");
  const { detectSignificantFacts } = await import("../src/services/lifeAdvisor.js");
  const graphRoutes = (await import("../src/routes/graph.js")).default;

  const stamp = Date.now();
  const user = await prisma.user.create({
    data: { email: `flags-${stamp}@example.com`, handle: `flags${stamp}`, name: "Ada Tester", altimetrixUserId: `alt-${stamp}`, settings: { graphAutoExtract: true } },
  });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const self = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Ada Tester", isSelf: true } });
  const bo = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Bo Linden" } });
  const cy = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Cy Marsh" } });
  await prisma.entity.create({ data: { userId: user.id, entityType: "place", name: "Lakeview" } });
  await prisma.relationship.create({ data: { userId: user.id, fromKind: "entity", fromId: bo.id, toKind: "entity", toId: self.id, type: "sibling_of", category: "family", status: "confirmed", source: "user" } });
  await prisma.relationship.create({ data: { userId: user.id, fromKind: "entity", fromId: cy.id, toKind: "entity", toId: self.id, type: "friend_of", category: "social", status: "suggested", source: "extraction" } });

  await t.test("auto-extract is paused for every user, even one whose setting is on", async () => {
    assert.equal(await autoExtractOn(user.id, "a test"), false);
    process.env.DIRA_AUTO_EXTRACT = "on";
    assert.equal(await autoExtractOn(user.id, "a test"), true);
    delete process.env.DIRA_AUTO_EXTRACT;
  });

  await t.test("graph rebuilds: the endpoint answers 409 and the catch-up skips", async () => {
    const app = Fastify();
    app.decorate("authenticate", async (request) => {
      request.userId = user.id;
    });
    await app.register(graphRoutes);
    const response = await app.inject({ method: "POST", url: "/graph/rebuild", payload: { dryRun: true } });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /paused/);
    assert.deepEqual(await catchUpGraphExtractions(), { skipped: "DIRA_GRAPH_REBUILD is off" });
    await app.close();
  });

  await t.test("fact chips: no model call and no chips", async () => {
    assert.deepEqual(await extractConversationalFacts("My sister Bo Linden lives in Lakeview since 2019."), []);
    assert.deepEqual(await detectSignificantFacts("My sister Bo Linden lives in Lakeview since 2019.", user.id), []);
    assert.equal(calls.model, 0);
  });

  const event = await prisma.event.create({
    data: {
      userId: user.id,
      title: "Paid Cy Marsh and Bo Linden for the Lakeview roof",
      understoodMeaning: "Cy Marsh and Bo Linden fixed the roof at Lakeview.",
      eventType: "financial",
      financials: { amount: 600000, currency: "TSH" },
      people: [{ name: "Bo Linden", role: "mentioned" }, { name: "Cy Marsh", role: "mentioned" }],
    },
  });

  await t.test("DIRA_BRIDGE=off: nothing is sent", async () => {
    process.env.DIRA_BRIDGE = "off";
    assert.equal(bridge.bridgeConfig(), null);
    assert.deepEqual(await bridge.sendLifeEvent(event, user.id, user), { sent: false });
    assert.equal(await bridge.getAltimetrixContext(["roof"], ["Bo Linden"], "personal", user, "roof"), null);
    assert.equal(calls.ingest.length + calls.context.length, 0);
    delete process.env.DIRA_BRIDGE;
  });

  await t.test("events go out with only confirmed people, and a failed send is retried", async () => {
    assert.deepEqual(await bridge.sendLifeEvent(event, user.id, user), { sent: true });
    assert.equal(calls.ingest.length, 2, "the first attempt failed with 503 and was retried");
    const sent = calls.ingest.at(-1);
    assert.deepEqual(sent.people, [{ name: "Bo Linden", role: "mentioned" }]);
    assert.equal(sent.title, "Paid someone and Bo Linden for the Lakeview roof");
    assert.doesNotMatch(JSON.stringify(sent), /Cy Marsh/);
    assert.equal((await prisma.event.findUnique({ where: { id: event.id } })).sentToAltimetrix, true);
  });

  await t.test("Altimetrix down: the send gives up without throwing and the event stays unsent", async () => {
    const other = await prisma.event.create({ data: { userId: user.id, title: "Milestone", eventType: "milestone" } });
    failIngest = 10;
    const before = calls.ingest.length;
    assert.deepEqual(await bridge.sendLifeEvent(other, user.id, user), { sent: false });
    assert.equal(calls.ingest.length - before, 3);
    assert.equal((await prisma.event.findUnique({ where: { id: other.id } })).sentToAltimetrix, false);
    failIngest = 0;
  });

  await t.test("context requests carry only confirmed people; the reply is read-only context", async () => {
    const before = await prisma.entity.count({ where: { userId: user.id } });
    const context = await bridge.getAltimetrixContext(["roof", "Cy Marsh"], ["Bo Linden", "Cy Marsh", "Lakeview", "Dee Unknown"], "personal", user, "Dee Unknown and Cy Marsh asked Bo Linden about the Lakeview roof");
    assert.equal(context.context, "Felt good about the cabin.");
    const asked = calls.context.at(-1);
    assert.deepEqual(asked.entityNames, ["Bo Linden", "Lakeview"]);
    assert.deepEqual(asked.topics, ["roof"]);
    assert.equal(asked.query, "someone and someone asked Bo Linden about the Lakeview roof");
    assert.equal(await prisma.entity.count({ where: { userId: user.id } }), before, "no records were written");
  });
});
