import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/prisma.js";
import { mergeEntities, resolveEntity } from "../src/services/graph/entityResolver.js";
import { assemblePaths, getFamilyTree } from "../src/services/graph/graphQuery.js";
import { rebuildGraph } from "../src/services/graph/rebuild.js";
import { alignPredicate, applySupersession, buildSelfAliasSet, dedupeProposedNames, groupSuggestions, mentionsSelf, prepareTriples } from "../src/services/graph/graphQuality.js";
import { absorbDroppedPayment, commitTriples, deterministicEdgePlans, dropReason, extractWithRetry, graphExtractProvider, headerDelayFrom, retryDelayMs } from "../src/services/graph/relationshipExtractor.js";
import { isSensitive, normalizeType } from "../src/services/graph/relationshipTypes.js";

test("normalizeType maps kinship words and work roles", () => {
  assert.deepEqual(normalizeType("mama").type, "parent_of");
  assert.equal(normalizeType("mama").reverse, true);
  assert.equal(normalizeType("dada").type, "sibling_of");
  assert.equal(normalizeType("fundi").type, "contractor_for");
  assert.equal(normalizeType("supervises").type, "supervises");
  assert.equal(normalizeType("supervises").reverse, false);
  assert.equal(isSensitive("parent_of"), true);
  assert.equal(isSensitive("supervises"), false);
});

test("amounts, dates and unknown predicates are not nodes", () => {
  assert.equal(normalizeType("hasTotalContractValue"), null);
  assert.equal(dropReason({
    subject: { name: "Electrical Works", type: "project" },
    predicate: "hasTotalContractValue",
    object: { name: "2,399,500 TSH", type: "asset" },
  }), "amount-as-node");
  assert.equal(dropReason({
    subject: { name: "Plot P9104", type: "property" },
    predicate: "dated",
    object: { name: "12 May 2024", type: "other" },
  }), "date-as-node");
  const birth = prepareTriples([{
    subject: { name: "Ada", type: "person" },
    predicate: "born",
    object: { name: "2004", type: "other" },
    evidence: "born in 2004",
  }]);
  assert.equal(birth.kept.length, 0);
  assert.equal(birth.entityFacts[0].name, "Ada");
  assert.equal(birth.entityFacts[0].birthDate, "2004-01-01");
  assert.equal(dropReason({
    subject: { name: "Ada", type: "self" },
    predicate: "hasTotalContractValue",
    object: { name: "Mbeya Home", type: "property" },
  }), "unknown-predicate");
  assert.equal(dropReason({
    subject: { name: "Burton", type: "person" },
    predicate: "supervises",
    object: { name: "Mbeya Home", type: "property" },
  }), null);

  const event = { id: "event-1", title: "Electrical Works", people: [], places: [], financials: {} };
  const plans = deterministicEdgePlans(event, "Ada");
  const absorbed = absorbDroppedPayment(plans, {
    subject: { name: "Electrical Works", type: "project" },
    predicate: "hasTotalContractValue",
    object: { name: "2,399,500 TSH", type: "asset" },
  }, event, "Ada");
  assert.equal(absorbed, true);
  assert.equal(plans.find((plan) => plan.type === "paid").attributes.amount, 2399500);
  assert.equal(plans.find((plan) => plan.type === "paid").attributes.currency, "TSH");
});

test("graph rebuild quality rules keep self, family and places honest", () => {
  const aliases = buildSelfAliasSet({ names: ["Phesto Enock Mwakyusa", "Phesto Mwakyusa"] });
  assert.equal(mentionsSelf("Phesto Enock Mwakayusa", aliases), true);
  assert.equal(mentionsSelf("Phesto Mwakyusa", aliases), true);
  const selfOwned = prepareTriples([{
    subject: { name: "Phesto Enock Mwakayusa", type: "person" },
    predicate: "owns",
    object: { name: "Plot P9104", type: "property" },
    evidence: "registered occupier",
    confidence: 0.9,
  }], { selfAliases: aliases, selfName: "Phesto Enock Mwakyusa", relatives: [] });
  assert.equal(selfOwned.kept[0].subject.type, "self");
  assert.equal(selfOwned.kept[0].subject.name, "Phesto Enock Mwakyusa");

  const surname = prepareTriples([{
    subject: { name: "Amina Mwakyusa", type: "person" },
    predicate: "sibling_of",
    object: { name: "Phesto Mwakyusa", type: "person" },
    evidence: "Amina Mwakyusa appears on the same title",
  }], { selfAliases: aliases, selfName: "Phesto Enock Mwakyusa", relatives: [] });
  assert.equal(surname.dropped[0].reason, "unsupported-family");

  const wife = prepareTriples([{
    subject: { name: "wife", type: "person" },
    predicate: "spouse_of",
    object: { name: "me", type: "self" },
    evidence: "my wife",
  }], {
    selfAliases: aliases,
    selfName: "Phesto Enock Mwakyusa",
    relatives: [{ role: "spouse", name: "Neema", id: "spouse-1" }],
  });
  assert.equal(wife.kept[0].subject.name, "Neema");
  assert.equal(wife.reviewQuestions.length, 0);

  const unknownWife = prepareTriples([{
    subject: { name: "wife", type: "person" },
    predicate: "spouse_of",
    object: { name: "me", type: "self" },
    evidence: "my wife",
  }], { selfAliases: aliases, selfName: "Phesto Enock Mwakyusa", relatives: [] });
  assert.equal(unknownWife.dropped[0].reason, "unresolved-kinship");
  assert.match(unknownWife.reviewQuestions[0], /Who is 'wife'/);

  assert.equal(alignPredicate("person", "has_participant", "project").type, "participant_in");
  assert.equal(normalizeType("married").type, "spouse_of");
  assert.equal(normalizeType("alioa").type, "spouse_of");

  let places = [];
  places = applySupersession(places, { fromName: "Jimny", toName: "Dar es Salaam", type: "located_in", at: "2019-01-01" });
  places = applySupersession(places, { fromName: "Jimny", toName: "Mbeya", type: "located_in", at: "2024-01-01" });
  assert.equal(places[0].validTo, "2024-01-01");
  assert.equal(places[1].validTo, null);

  const names = dedupeProposedNames(["land in Ntabha, Mbeya", "existing plot in Ntabha"]);
  assert.equal(names.get("land in Ntabha, Mbeya"), "Ntabha plot");
  assert.equal(names.get("existing plot in Ntabha"), "Ntabha plot");

  const grouped = groupSuggestions([
    { id: "1", category: "family", type: "spouse_of", fromName: "Phesto", toName: "Neema" },
    { id: "2", category: "family", type: "parent_of", fromName: "Mara", toName: "Phesto" },
    { id: "3", category: "ownership", type: "owns", fromName: "Phesto", toName: "Plot P9104" },
    { id: "4", category: "work", type: "supervises", fromName: "Burton", toName: "Mbeya Home" },
  ], "Phesto");
  assert.equal(grouped.count, 3);
  assert.equal(grouped.family.people.length, 2);
  assert.equal(grouped.assets.items[0].name, "Plot P9104");
});

test("graph extraction backs off on rate limits", async () => {
  const previous = process.env.GRAPH_EXTRACT_PROVIDER;
  delete process.env.GRAPH_EXTRACT_PROVIDER;
  assert.equal(graphExtractProvider(), "openai");
  process.env.GRAPH_EXTRACT_PROVIDER = "groq";
  assert.equal(graphExtractProvider(), "groq");
  if (previous == null) delete process.env.GRAPH_EXTRACT_PROVIDER;
  else process.env.GRAPH_EXTRACT_PROVIDER = previous;
  assert.equal(retryDelayMs({ retryAfter: 5000 }, 1), 5000);
  assert.equal(retryDelayMs({ status: 429 }, 1), 2000);
  assert.equal(retryDelayMs({ status: 429 }, 2), 4000);
  assert.equal(retryDelayMs({ status: 429 }, 3), 8000);
  assert.equal(retryDelayMs({ status: 429 }, 4), 16000);
  assert.equal(retryDelayMs({ status: 429 }, 5), 32000);
  assert.equal(headerDelayFrom(new Headers({ "retry-after": "3" })), 3000);
  assert.equal(headerDelayFrom(new Headers({ "x-ratelimit-reset-requests": "6s" })), 6000);

  let calls = 0;
  const waits = [];
  await assert.rejects(() => extractWithRetry(() => {
    calls += 1;
    const error = new Error("rate");
    error.status = 429;
    throw error;
  }, async (ms) => { waits.push(ms); }));
  assert.equal(calls, 5);
  assert.deepEqual(waits, [2000, 4000, 8000, 16000]);
});

test("assemblePaths stops at depth and does not loop", () => {
  const edges = [
    edge("1", "a", "b"),
    edge("2", "b", "a"),
    edge("3", "b", "c"),
    edge("4", "c", "d"),
    edge("5", "d", "e"),
  ];
  const paths = assemblePaths(edges, { kind: "entity", id: "a" }, { kind: "entity", id: "c" }, 4, 3);
  assert.ok(paths.length >= 1 && paths.length <= 3);
  assert.ok(paths.every((path) => path.at(-1).node === "entity:c"));
  assert.ok(paths.every((path) => path.length <= 5));
  const tooDeep = assemblePaths(edges, { kind: "entity", id: "a" }, { kind: "entity", id: "e" }, 2, 3);
  assert.equal(tooDeep.length, 0);
});

test("graph records stay consistent", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not ready for graph tests");
    return;
  }
  const user = await prisma.user.create({
    data: { email: `graph-${Date.now()}@example.com`, handle: `graph${Date.now()}`, name: "Ada Tester" },
  });
  try {
    const parent = await prisma.entity.create({
      data: { userId: user.id, name: "Mara Test", entityType: "person", normalizedName: "mara test", status: "active" },
    });
    const self = await prisma.entity.create({
      data: { userId: user.id, name: "Ada Tester", entityType: "person", isSelf: true, normalizedName: "ada tester", status: "active" },
    });
    await prisma.relationship.create({
      data: {
        userId: user.id,
        fromKind: "entity",
        fromId: parent.id,
        toKind: "entity",
        toId: self.id,
        type: "parent_of",
        category: "family",
        status: "confirmed",
        source: "user",
        attributes: {},
      },
    });
    const kinship = await resolveEntity(user.id, { name: "my mother", entityType: "person" });
    assert.equal(kinship.entity?.id, parent.id);
    assert.equal(kinship.matchedBy, "kinship");

    await prisma.entity.create({
      data: { userId: user.id, name: "Nia Solo", entityType: "person", normalizedName: "nia solo", status: "active" },
    });
    const first = await resolveEntity(user.id, { name: "Nia", entityType: "person" });
    assert.equal(first.matchedBy, "first-name");

    await prisma.entity.create({
      data: { userId: user.id, name: "Nia Other", entityType: "person", normalizedName: "nia other", status: "active" },
    });
    const ambiguous = await resolveEntity(user.id, { name: "Nia", entityType: "person" });
    assert.equal(ambiguous.entity, null);
    assert.equal(ambiguous.matchedBy, "ambiguous");

    const sensitive = await commitTriples(user.id, [{
      subject: { name: "Ada Tester", type: "self" },
      predicate: "sister",
      object: { name: "Lina Example", type: "person" },
      confidence: 0.95,
    }], { source: "intake" });
    assert.ok(sensitive.suggested >= 1);

    const confirmed = await commitTriples(user.id, [{
      subject: { name: "Ada Tester", type: "self" },
      predicate: "sister",
      object: { name: "Lina Example", type: "person" },
      confidence: 1,
    }], { source: "user" });
    assert.ok(confirmed.updated + confirmed.created >= 1);
    const sibling = await prisma.relationship.findFirst({ where: { userId: user.id, type: "sibling_of" } });
    assert.equal(sibling.status, "confirmed");

    await prisma.relationship.update({ where: { id: sibling.id }, data: { status: "rejected" } });
    await commitTriples(user.id, [{
      subject: { name: "Ada Tester", type: "self" },
      predicate: "sister",
      object: { name: "Lina Example", type: "person" },
      confidence: 0.99,
    }], { source: "intake" });
    const still = await prisma.relationship.findFirst({ where: { id: sibling.id } });
    assert.equal(still.status, "rejected");

    const money = await commitTriples(user.id, [
      { subject: { name: "Ada Tester", type: "self" }, predicate: "sent money to", object: { name: "Kito Example", type: "person" }, attributes: { amount: 10, currency: "EUR" }, confidence: 0.9 },
      { subject: { name: "Ada Tester", type: "self" }, predicate: "sent money to", object: { name: "Kito Example", type: "person" }, attributes: { amount: 5, currency: "EUR" }, confidence: 0.9 },
    ], { source: "user" });
    assert.ok(money.created + money.updated >= 1);
    const flow = await prisma.relationship.findFirst({ where: { userId: user.id, type: "sent_money_to" } });
    assert.equal(flow.attributes.total, 15);
    assert.equal(flow.attributes.count, 2);

    await prisma.entity.update({ where: { id: parent.id }, data: { deathDate: new Date("2000-01-01") } });
    const tree = await getFamilyTree(user.id);
    assert.equal(tree.parents[0].name, "Mara Test");
    assert.ok(tree.parents[0].deathDate);

    const copy = await prisma.entity.create({
      data: { userId: user.id, name: "Mara T", entityType: "person", normalizedName: "mara t", status: "active" },
    });
    await prisma.relationship.create({
      data: {
        userId: user.id,
        fromKind: "entity",
        fromId: copy.id,
        toKind: "entity",
        toId: self.id,
        type: "knows",
        category: "social",
        status: "suggested",
        source: "inferred",
        attributes: {},
      },
    });
    const before = await prisma.relationship.count({ where: { userId: user.id } });
    const report = await rebuildGraph(user.id, { dryRun: true });
    const after = await prisma.relationship.count({ where: { userId: user.id } });
    assert.equal(after, before);
    assert.equal(report.dryRun, true);
    assert.ok(Array.isArray(report.proposed));

    const merged = await mergeEntities(user.id, parent.id, copy.id);
    assert.ok(merged.moved + merged.deduped >= 1);
    const archived = await prisma.entity.findUnique({ where: { id: copy.id } });
    assert.equal(archived.mergedIntoId, parent.id);
    const moved = await prisma.relationship.findFirst({ where: { userId: user.id, type: "knows", fromId: parent.id } });
    assert.ok(moved);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
});

async function databaseReady() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$queryRaw`SELECT "isSelf" FROM entities LIMIT 1`;
    await prisma.$queryRaw`SELECT "fromKind" FROM relationships LIMIT 1`;
    await prisma.$queryRaw`SELECT "graphExtractedAt" FROM events LIMIT 1`;
    return true;
  } catch {
    return false;
  }
}

function edge(id, fromId, toId) {
  return { id, fromKind: "entity", fromId, toKind: "entity", toId, type: "knows" };
}
