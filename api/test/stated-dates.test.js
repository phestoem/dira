import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import Fastify from "fastify";
import { findStatedDates } from "../src/services/graph/statedDates.js";
import { nameKeys } from "../src/services/peopleLinks.js";

// Dates a message states for people with records go on those records, but only when the save is confirmed, and
// only into empty fields. Answers then read them from the records.

test("findStatedDates: births, deaths and marriages per clause, known people only", () => {
  const keys = nameKeys([{ id: "bo", name: "Bo Linden Ek" }, { id: "cy", name: "Cy Linden Ek" }, { id: "ed", name: "Ed Moss" }, { id: "fay", name: "Fay Moss" }]);
  const pick = (text) => findStatedDates(text, keys).map((item) => `${item.id} ${item.field} ${item.iso}`);
  assert.deepEqual(pick("Bo Linden Ek was born on 4 December 1980, Cy Linden Ek on 14 December 1983 and Gil Ek on 1 May 1990."), ["bo birthDate 1980-12-04", "cy birthDate 1983-12-14"]);
  assert.deepEqual(pick("My father is Ed Moss, born 19 February 1956 in Dalvik, and he died on 25 April 2004."), ["ed birthDate 1956-02-19", "ed deathDate 2004-04-25"]);
  assert.deepEqual(pick("The note mentions the passing of the father, Ed Moss, on April 25, 2004."), ["ed deathDate 2004-04-25"]);
  assert.deepEqual(pick("I married Fay Moss on 5th August 2006."), ["fay marriageDate 2006-08-05"]);
  assert.deepEqual(pick("Paid Fay Moss 200 EUR on 3 May 2021."), [], "a date with no birth, death or marriage word is not a person's date");
});

test("save preview lists the dates; confirm writes them to empty record fields", async (t) => {
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
  const { loadPeopleContext, answerPeopleQuestion } = await import("../src/services/graph/peopleGrounding.js");
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `dates-${stamp}@example.com`, handle: `dates${stamp}`, name: "Ada Tester" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  });
  const self = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Ada Tester", isSelf: true } });
  const bo = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Bo Linden Ek", kind: "sister" } });
  const fay = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Fay Moss", kind: "wife" } });
  const ed = await prisma.entity.create({ data: { userId: user.id, entityType: "person", name: "Ed Moss", kind: "father", deathDate: new Date("2004-04-25T00:00:00Z") } });
  const edge = (fromId, type) => prisma.relationship.create({ data: { userId: user.id, fromKind: "entity", fromId, toKind: "entity", toId: self.id, type, category: "family", status: "confirmed", source: "user" } });
  await edge(bo.id, "sibling_of");
  const marriage = await edge(fay.id, "spouse_of");
  await edge(ed.id, "parent_of");

  const app = Fastify();
  app.decorate("authenticate", async (request) => {
    request.userId = user.id;
  });
  await app.register(homeRoutes);
  t.after(() => app.close());
  const input = (message) => app.inject({ method: "POST", url: "/home/input", payload: { message, conversationHistory: [] } }).then((r) => r.json());
  const confirm = (sessionId) => app.inject({ method: "POST", url: "/home/confirm", payload: { sessionId, confirmed: true } }).then((r) => r.json());

  const preview = await input("Bo Linden Ek was born on 4 December 1980. I married Fay Moss on 5 August 2006. Ed Moss was born on 3 March 2010.");
  assert.equal(preview.result.type, "understanding");
  assert.match(preview.result.confirmationText, /Also records on their pages: Bo Linden Ek born 4 Dec 1980; Fay Moss married 5 Aug 2006\.$/);
  assert.equal((await prisma.entity.findUnique({ where: { id: bo.id } })).birthDate, null, "nothing is written before the confirm");

  const done = await confirm(preview.sessionId);
  assert.equal(done.result.type, "saved");
  assert.match(done.result.content.message, /Recorded on their pages: Bo Linden Ek born 4 Dec 1980; Fay Moss married 5 Aug 2006\.$/);
  assert.equal((await prisma.entity.findUnique({ where: { id: bo.id } })).birthDate.toISOString().slice(0, 10), "1980-12-04");
  assert.equal((await prisma.relationship.findUnique({ where: { id: marriage.id } })).validFrom.toISOString().slice(0, 10), "2006-08-05");
  assert.equal((await prisma.entity.findUnique({ where: { id: ed.id } })).birthDate, null, "a birth after the death is not written");

  const tree = answerPeopleQuestion("show my family tree", await loadPeopleContext(user.id));
  assert.match(tree, /Spouse: Fay Moss \(wife, married 5 Aug 2006\)/);
  assert.match(tree, /Bo Linden Ek \(sister, b\. 4 Dec 1980\)/);
  assert.match(tree, /Ed Moss \(father, birth date not recorded, passed 25 Apr 2004\)/);

  const differs = await input("Bo Linden Ek was born on 5 December 1980.");
  assert.match(differs.result.confirmationText, /Not changed \(the record says otherwise\): Bo Linden Ek born 4 Dec 1980 on record, 5 Dec 1980 here\./);
  await confirm(differs.sessionId);
  assert.equal((await prisma.entity.findUnique({ where: { id: bo.id } })).birthDate.toISOString().slice(0, 10), "1980-12-04", "a recorded date is never overwritten");
});
