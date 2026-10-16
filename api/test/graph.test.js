import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/prisma.js";
import { chooseSelfName, getOrCreateSelf, mergeEntities, resolveEntity } from "../src/services/graph/entityResolver.js";
import { isNoiseReply, previousExchangeFrom, rejectsCorrection } from "../src/services/intentRouter.js";
import { answerPeopleQuestion, buildPeopleContext, contextualQuestion, deliverPeopleAnswer, groundAdvisorReply, isPeopleQuestion, peopleFromTree, resolvePeopleFollowUp } from "../src/services/graph/peopleGrounding.js";
import { isReadonly, runReadonly } from "../src/readonly.js";
import { graphAutoExtractEnabled } from "../src/services/graph/rebuild.js";
import { autoExtractOn } from "../src/services/graph/autoExtract.js";
import { resetGraph } from "../src/services/graph/reset.js";
import { extractAndLinkEntities } from "../src/routes/entities.js";
import { assemblePaths, getFamilyTree } from "../src/services/graph/graphQuery.js";
import { rebuildGraph } from "../src/services/graph/rebuild.js";
import { stripEntityIds } from "../src/services/graph/reset.js";
import { alignPredicate, applySupersession, buildSelfAliasSet, dedupeProposedNames, groupSuggestions, mentionsSelf, prepareTriples, selfMatchKind } from "../src/services/graph/graphQuality.js";
import { absorbDroppedPayment, commitTriples, deterministicEdgePlans, dropReason, extractWithRetry, graphExtractProvider, headerDelayFrom, retryDelayMs } from "../src/services/graph/relationshipExtractor.js";
import { isSensitive, normalizeType } from "../src/services/graph/relationshipTypes.js";

// The Prisma client keeps the process alive; close it so `npm test` exits on its own.
test.after(async () => {
  await prisma.$disconnect();
});

test("graph reset drops entity ids and keeps names", () => {
  const people = stripEntityIds([
    { entityId: "person-1", name: "Burton", role: "supervisor" },
    "Ada",
    { name: "Neema", role: "spouse" },
  ]);
  assert.equal(people.removed, 1);
  assert.deepEqual(people.list[0], { name: "Burton", role: "supervisor" });
  assert.equal(people.list[1], "Ada");
  assert.deepEqual(people.list[2], { name: "Neema", role: "spouse" });
  const places = stripEntityIds([{ entityId: "place-1", name: "Mbeya", role: "location", relationship: "location" }]);
  assert.equal(places.removed, 1);
  assert.equal(places.list[0].name, "Mbeya");
  assert.equal(places.list[0].role, "location");
  assert.equal(places.list[0].entityId, undefined);
});

test("questions are not corrections and kinship uses the full source", () => {
  assert.equal(rejectsCorrection("what are their names?"), true);
  assert.equal(rejectsCorrection("and his family?"), true);
  assert.equal(rejectsCorrection("their names"), true);
  assert.equal(rejectsCorrection("no, that's wrong"), false);
  assert.equal(rejectsCorrection("actually I meant Leah"), false);
  const history = [
    { role: "user", content: "how many kids do I have?" },
    { role: "assistant", content: "Four" },
    { role: "assistant", content: "Request failed" },
    { role: "assistant", content: "Taking a moment…" },
    { role: "user", content: "what are their names?" },
  ];
  const prior = previousExchangeFrom(history);
  assert.equal(prior.lastResponse, "Four");
  assert.equal(isNoiseReply("Request failed"), true);
  assert.equal(isNoiseReply(""), true);
  assert.equal(contextualQuestion("what are their names?", "how many kids do I have?", "Four").includes("Previous answer: Four"), true);
  assert.equal(contextualQuestion("and his family?", "who is my father?", "Enock Mwakyusa — your father."), "my father's family tree\n\nPrevious answer: Enock Mwakyusa — your father.");
  const family = "My sisters are Jeni, Leah, Neema and Zenah Enock Mwakyusa. My wife is Zelda Goodluck Mambosho.";
  assert.equal(dropReason({
    subject: { name: "Jeni", type: "person" },
    predicate: "sibling_of",
    object: { name: "me", type: "self" },
    evidence: "Jeni",
  }, { message: family }), null);
  assert.equal(dropReason({
    subject: { name: "Zelda Goodluck Mambosho", type: "person" },
    predicate: "spouse_of",
    object: { name: "me", type: "self" },
    evidence: "Zelda",
  }, { sourceText: family }), null);
  assert.equal(dropReason({
    subject: { name: "Jeni", type: "person" },
    predicate: "sibling_of",
    object: { name: "me", type: "self" },
    evidence: "Jeni",
  }), "unsupported-family");
  assert.equal(graphAutoExtractEnabled({ graphAutoExtract: false }, "true"), false);
  assert.equal(graphAutoExtractEnabled({ graphAutoExtract: true }, "false"), true);
  assert.equal(graphAutoExtractEnabled({}, "false"), false);
  assert.equal(graphAutoExtractEnabled({}, "true"), true);
});

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
    relatives: [{ role: "spouse", name: "Neema", id: "spouse-1", gender: "female" }],
  });
  assert.equal(wife.kept[0].subject.name, "Neema");
  assert.equal(wife.reviewQuestions.length, 0);

  // "my mother" never lands on the father, nor on a parent whose role is unknown.
  for (const parent of [{ role: "parent", name: "Enock Mwakyusa", id: "father-1", gender: "male" }, { role: "parent", name: "Somebody", id: "parent-1", gender: null }]) {
    const mother = prepareTriples([{
      subject: { name: "my mother", type: "person" },
      predicate: "lives_at",
      object: { name: "Mbeya", type: "place" },
      evidence: "my mother lives in Mbeya",
    }], { selfAliases: aliases, selfName: "Phesto Enock Mwakyusa", relatives: [parent] });
    assert.equal(mother.kept.length, 0);
    assert.equal(mother.dropped[0].reason, "unresolved-kinship");
  }

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

test("a generic entity kind never hides the tree role", () => {
  const rows = peopleFromTree({
    self: { id: "self", name: "Phesto Enock Mwakyusa", kind: "self" },
    parents: [{ id: "enock", name: "Enock Mwakyusa", kind: "person" }],
    siblings: [{ id: "jeni", name: "Jeni", kind: "person" }, { id: "leah", name: "Leah", kind: "sister" }],
    spouse: [{ id: "zelda", name: "Zelda Goodluck Mambosho", kind: "person" }],
    children: [{ id: "patrick", name: "Patrick", kind: null }],
  });
  assert.deepEqual(rows.map((row) => `${row.name}:${row.kind}`), [
    "Phesto Enock Mwakyusa:self",
    "Enock Mwakyusa:parent",
    "Jeni:sibling",
    "Leah:sister",
    "Zelda Goodluck Mambosho:spouse",
    "Patrick:child",
  ]);
});

test("a readonly request cannot write, even from background work", async () => {
  assert.equal(isReadonly(), false);
  await runReadonly(async () => {
    assert.equal(isReadonly(), true);
    await assert.rejects(() => prisma.entity.create({ data: { userId: "nobody", name: "x", entityType: "person" } }), /readonly request: refused to create Entity/);
    await assert.rejects(() => prisma.$executeRawUnsafe("DELETE FROM entities WHERE false"), /readonly request/);
    const late = await new Promise((resolve) => {
      setImmediate(() => prisma.relationship.deleteMany({ where: { userId: "nobody" } }).then(() => resolve("wrote"), (err) => resolve(err.name)));
    });
    assert.equal(late, "ReadonlyError");
  });
  assert.equal(isReadonly(), false);
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

test("after a reset, stated connections save and automatic extraction waits", async (t) => {
  if (!(await databaseReady())) {
    t.skip("Postgres is not ready for graph tests");
    return;
  }
  const user = await prisma.user.create({
    data: { email: `gate-${Date.now()}@example.com`, handle: `gate${Date.now()}`, name: "Ada Tester", settings: { graphAutoExtract: true } },
  });
  try {
    assert.equal(await autoExtractOn(user.id), true);
    await resetGraph(user.id, { dryRun: false });
    assert.equal(await autoExtractOn(user.id), false);

    const event = await prisma.event.create({
      data: {
        userId: user.id,
        title: "Certificate of Occupancy - Plot P9200",
        eventType: "personal",
        space: "personal",
        rawInput: "Certificate of Occupancy for Plot P9200 in Kitunda, witnessed by Hassani Juma Mrisho.",
        people: [{ name: "Hassani Juma Mrisho", role: "witness" }],
        places: [{ name: "Kitunda" }],
      },
    });
    const linked = await extractAndLinkEntities(event, user.id, { location: "Kitunda", summary: event.rawInput });
    assert.deepEqual(linked, []);
    assert.equal(await prisma.entity.count({ where: { userId: user.id, isSelf: false } }), 0);
    assert.equal(await prisma.relationship.count({ where: { userId: user.id } }), 0);
    assert.equal((await prisma.event.findUnique({ where: { id: event.id } })).graphExtractedAt, null);

    const stated = await commitTriples(user.id, [{
      subject: { name: "Lina Example", type: "person", kind: "sister" },
      predicate: "sibling_of",
      object: { name: "me", type: "self" },
      evidence: "My sister Lina Example lives in Mbeya.",
      confidence: 0.9,
    }], { source: "conversation", forceStatus: "suggested", message: "My sister Lina Example lives in Mbeya." });
    assert.equal(stated.created + stated.updated + stated.suggested >= 1, true);
    assert.equal(await prisma.relationship.count({ where: { userId: user.id, type: "sibling_of" } }), 1);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  }
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
      data: { userId: user.id, name: "Mara Test", entityType: "person", kind: "mother", normalizedName: "mara test", status: "active" },
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
    // "my father" must not resolve to the only parent when she is known as a mother; nothing is invented either.
    const father = await resolveEntity(user.id, { name: "my father", entityType: "person" });
    assert.equal(father.entity, null);
    assert.equal(father.matchedBy, "unresolved-kinship");

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
      evidence: "Lina Example is my sister.",
      confidence: 0.95,
    }], { source: "intake" });
    assert.ok(sensitive.suggested >= 1);

    const confirmed = await commitTriples(user.id, [{
      subject: { name: "Ada Tester", type: "self" },
      predicate: "sister",
      object: { name: "Lina Example", type: "person" },
      evidence: "Lina Example is my sister.",
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
      evidence: "Lina Example is my sister.",
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
