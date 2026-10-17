import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/prisma.js";
import { runReadonly } from "../src/readonly.js";
import { extractEvent, ingest, setExtractor, settled } from "../src/services/knowledge/ingest.js";
import { fit } from "../src/services/knowledge/resolver.js";
import { fallbackKind } from "../src/services/knowledge/router.js";
import { parseWhen, shapeProblem } from "../src/services/knowledge/store.js";

// Invented life. Nothing here calls a model: the extractor is a stand-in that returns fixed claims per text.

test.after(async () => {
  await prisma.$disconnect();
});

test("dates keep the precision they were said with", () => {
  assert.deepEqual(parseWhen("2019"), { date: new Date(Date.UTC(2019, 0, 1)), precision: "year" });
  assert.equal(parseWhen("2019-04").precision, "month");
  assert.equal(parseWhen("2019-04-30").precision, "day");
  assert.equal(parseWhen("2019-02-30"), null);
  assert.equal(parseWhen("April 2019"), null);
});

test("claims need a known predicate, an object or value where the predicate does, and real dates", () => {
  assert.equal(shapeProblem({ subject: "me", predicate: "adores", object: { name: "Ada" } }), "unknown-predicate");
  assert.equal(shapeProblem({ subject: "me", predicate: "owns" }), "no-object");
  assert.equal(shapeProblem({ subject: { name: "passport" }, predicate: "expires_on", value: "soon" }), "bad-date-value");
  assert.equal(shapeProblem({ subject: "me", predicate: "paid", object: { name: "Ada" }, amount: "lots" }), "bad-amount");
  assert.equal(shapeProblem({ subject: "me", predicate: "paid", object: { name: "Ada" }, amount: 300, date: "2024-03" }), null);
});

test("without the model, only a message that is all questions is left unsaved", () => {
  assert.equal(fallbackKind("My sister Ada moved to Oslo.").kind, "statement");
  assert.equal(fallbackKind("When is Ada's birthday?").kind, "question");
  assert.deepEqual(fallbackKind("Ada moved to Oslo. When is her birthday?"), { kind: "mixed", question: "When is her birthday?" });
});

test("one resolver for every type: exact, then a unique partial of the same type", () => {
  const person = { entityType: "person", name: "Ada Lindqvist", aliases: [] };
  const place = { entityType: "place", name: "Oslo", aliases: [] };
  const plot = { entityType: "property", name: "Oslo plot", aliases: [] };
  assert.equal(fit({ name: "Ada", type: "person" }, person), "partial");
  assert.equal(fit({ name: "Lindqvist", type: "person" }, person), null, "a surname alone is not the person");
  assert.equal(fit({ name: "Oslo", type: "place" }, place), "exact");
  assert.equal(fit({ name: "Oslo", type: "place" }, plot), null, "a place is not the property named for it");
  assert.equal(fit({ name: "the Oslo plot", type: "property" }, plot), "exact");
  assert.equal(fit({ name: "Ada Lindqvist", type: "organisation" }, person), null);
});

test("ingest saves every statement, extracts it into claims in order, corrects and materialises", async () => {
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `claims-${stamp}@example.com`, handle: `claims${stamp}`, name: "Ada Lindqvist" } });
  const said = {
    "My brother Nils Lindqvist was born in 1988.": [
      { subject: { name: "Nils Lindqvist", type: "person" }, predicate: "sibling_of", object: "me", evidence: "My brother Nils Lindqvist" },
      { subject: { name: "Nils Lindqvist", type: "person" }, predicate: "born", value: "1988", evidence: "born in 1988" },
    ],
    "I paid Nils 300 EUR for the Oslo plot survey in March 2024. I bought the Oslo plot for 90,000 EUR.": [
      { subject: "me", predicate: "paid", object: { name: "Nils", type: "person" }, amount: 300, currency: "eur", date: "2024-03", context: { name: "Oslo plot", type: "property" }, evidence: "I paid Nils 300 EUR" },
      { subject: "me", predicate: "bought", object: { name: "Oslo plot", type: "property" }, amount: 90000, currency: "EUR", evidence: "I bought the Oslo plot" },
      { subject: "me", predicate: "adores", object: { name: "Oslo plot", type: "property" } },
    ],
    "Correction: the Oslo plot cost 85,000 EUR.": [
      { subject: "me", predicate: "bought", object: { name: "the Oslo plot", type: "property" }, amount: 85000, currency: "EUR", corrects: true, evidence: "the Oslo plot cost 85,000 EUR" },
    ],
  };
  setExtractor(async (text) => ({ claims: said[text] || [], extractor: "test", model: "none" }));
  try {
    const results = [];
    for (const text of Object.keys(said)) results.push(await ingest(user.id, text, { source: "email" }));
    assert.ok(results.every((result) => result.kind === "statement" && result.stored), "non-chat sources are statements and always saved");
    await settled(user.id);

    const events = await prisma.event.findMany({ where: { userId: user.id } });
    assert.equal(events.length, 3);
    assert.ok(events.every((event) => event.graphExtractedAt && event.source === "email"));

    const entities = await prisma.entity.findMany({ where: { userId: user.id } });
    const nils = entities.filter((entity) => entity.name.startsWith("Nils"));
    assert.equal(nils.length, 1, "Nils and Nils Lindqvist are one person");
    assert.equal(entities.filter((entity) => /oslo plot/i.test(entity.name)).length, 1);

    const claims = await prisma.claim.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    assert.equal(claims.length, 5, "the unknown predicate is skipped");
    const paid = claims.find((claim) => claim.predicate === "paid");
    assert.equal(Number(paid.amount), 300);
    assert.equal(paid.currency, "EUR");
    assert.equal(paid.datePrecision, "month");
    assert.ok(paid.contextId);
    const bought = claims.filter((claim) => claim.predicate === "bought");
    assert.deepEqual(bought.map((claim) => [Number(claim.amount), claim.status]), [[90000, "superseded"], [85000, "stated"]]);
    assert.equal(bought[1].supersedesId, bought[0].id);

    const edges = await prisma.relationship.findMany({ where: { userId: user.id, source: "claims" } });
    assert.ok(edges.some((edge) => edge.type === "sibling_of" && edge.toId === nils[0].id || edge.fromId === nils[0].id));
    const born = await prisma.entity.findUnique({ where: { id: nils[0].id } });
    assert.equal(born.birthDate.toISOString().slice(0, 10), "1988-01-01");

    // Repeating a source adds nothing.
    const again = await extractEvent(user.id, events[0], { source: "email" });
    assert.equal(again.written.length, 0);
    assert.deepEqual(again.skipped.map((item) => item.reason), ["duplicate", "duplicate"]);

    // A readonly request answers but saves nothing.
    const quiet = await runReadonly(() => ingest(user.id, "My sister Elin lives in Bergen.", { source: "journal" }));
    assert.equal(quiet.stored, false);
    assert.equal(await prisma.event.count({ where: { userId: user.id } }), 3);
  } finally {
    setExtractor(null);
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});
