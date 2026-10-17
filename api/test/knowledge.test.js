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

test("amounts are read in the formats people write them", async () => {
  const { amountsIn } = await import("../src/services/knowledge/validate.js");
  const has = (text, value) => amountsIn(text).some((found) => Math.abs(found - value) < 1);
  assert.ok(has("I paid KES 1,750,000", 1750000));
  assert.ok(has("custou R$ 55.000,00", 55000));
  assert.ok(has("about 1.75 million", 1750000));
  assert.ok(has("shilingi 120,000", 120000));
  assert.ok(has("450k for the roof", 450000));
  assert.ok(has("₹38,50,000 per annum", 3850000));
  assert.ok(has("each put in ₹5 lakh", 500000));
  assert.ok(has("₹14.2 lakh on-road", 1420000));
  assert.ok(has("about 1.2 crore", 12000000));
  assert.ok(has("Angebot über 12.500 €", 12500));
  assert.ok(!has("in 2024 I paid 45,000", 450000));
});

test("extracted claims keep only evidence, names and amounts the text states", async () => {
  const { validateClaims } = await import("../src/services/knowledge/validate.js");
  const text = "I paid Nils 300 EUR for the survey of the Oslo plot in March 2024.";
  const base = { subject: "me", predicate: "paid", object: { name: "Nils Lindqvist", type: "person" }, amount: 300, currency: "EUR", evidence: "I paid Nils 300 EUR", context: { name: "Oslo plot", type: "property" } };
  const { kept, dropped } = validateClaims([
    base,
    { ...base, amount: 3000 },
    { ...base, object: { name: "Elin", type: "person" } },
    { ...base, evidence: "I sent Elin money for the boat" },
    { ...base, object: { name: "Bergen", type: "place" }, predicate: "visited", amount: null },
  ], text, { known: ["Bergen"], selfName: "Ada Lindqvist" });
  assert.equal(kept.length, 2);
  assert.deepEqual(dropped.map((item) => item.reason), ["amount-not-in-text", "name-not-in-text", "evidence-not-in-text"]);
});

test("a year worked out from an age is not stated; a resolved relative date is", async () => {
  const { validateClaims } = await import("../src/services/knowledge/validate.js");
  const text = "My mother turns 75 this September. We moved last month.";
  const born = { subject: { name: "mother", type: "person" }, predicate: "born", value: "1951-09", evidence: "My mother turns 75 this September" };
  const moved = { subject: "me", predicate: "lives_in", object: { name: "mother", type: "place" }, date: "2026-05", evidence: "We moved last month" };
  const { kept, dropped } = validateClaims([born, moved], text, { today: "2026-06-15" });
  assert.deepEqual(dropped.map((item) => item.reason), ["year-not-in-text"]);
  assert.equal(kept.length, 1);
});

test("a thing's place becomes located_in, and today's date on an undated fact is dropped", async () => {
  const { withPlaces } = await import("../src/services/knowledge/extractor.js");
  const { validateClaims } = await import("../src/services/knowledge/validate.js");
  const claim = { subject: "me", predicate: "owns", object: { name: "lake cabin", type: "property", place: "Bergen" }, evidence: "our lake cabin in Bergen" };
  const out = withPlaces([claim, { ...claim, predicate: "rents" }]);
  assert.deepEqual(out.map((item) => item.predicate), ["owns", "located_in", "rents"]);
  assert.deepEqual([out[1].subject.name, out[1].object.name], ["lake cabin", "Bergen"]);
  const stamped = { subject: { name: "Nils", type: "person" }, predicate: "died", value: "2026-06-15", evidence: "my late brother Nils" };
  const { dropped } = validateClaims([stamped], "My late brother Nils loved the sea.", { today: "2026-06-15" });
  assert.deepEqual(dropped.map((item) => item.reason), ["today-stamp"]);
  assert.equal(validateClaims([{ ...stamped, evidence: "Nils died this morning" }], "Nils died this morning, on the 15th.", { today: "2026-06-15" }).kept.length, 1);
});

test("a newer deadline replaces the older one; places inside places are kept", async () => {
  const { withPlaces } = await import("../src/services/knowledge/extractor.js");
  const out = withPlaces([{ subject: { name: "Old Town", type: "place", place: "Bergen" }, predicate: "lives_in", object: null, evidence: "Old Town in Bergen" }]);
  assert.deepEqual(out.map((item) => item.predicate), ["lives_in", "located_in"]);
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `single-${stamp}@example.com`, handle: `single${stamp}`, name: "Ada Lindqvist" } });
  try {
    const { writeClaims } = await import("../src/services/knowledge/store.js");
    const due = (value) => ({ subject: { name: "kitchen refit", type: "project" }, predicate: "due_on", value, evidence: "due" });
    await writeClaims(user.id, [due("2026-07-31")]);
    await writeClaims(user.id, [due("2026-09-30")]);
    const rows = await prisma.claim.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(rows.map((row) => [row.value, row.status]), [["2026-07-31", "superseded"], ["2026-09-30", "stated"]]);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

test("a correction replaces the one payment it is about and keeps its date", async () => {
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `fix-${stamp}@example.com`, handle: `fix${stamp}`, name: "Ada Lindqvist" } });
  try {
    const { writeClaims } = await import("../src/services/knowledge/store.js");
    const pay = (amount, date, extra = {}) => ({ subject: "me", predicate: "paid", object: { name: "Nils Berg", type: "person" }, amount, currency: "EUR", date, evidence: "paid", ...extra });
    await writeClaims(user.id, [pay(1400, "2024-04-20"), pay(1200, "2024-08-02"), pay(1500, "2024-11", { label: "slab stage" })]);
    await writeClaims(user.id, [pay(1350, null, { label: "slab stage", corrects: true })]);
    const rows = await prisma.claim.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(rows.map((row) => [Number(row.amount), row.status]), [[1400, "stated"], [1200, "stated"], [1500, "superseded"], [1350, "stated"]]);
    assert.equal(rows[3].datePrecision, "month", "the correction keeps the corrected payment's date");
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});
