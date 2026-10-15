import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/prisma.js";
import { mergeEntities, resolveEntity } from "../src/services/graph/entityResolver.js";
import { assemblePaths, getFamilyTree } from "../src/services/graph/graphQuery.js";
import { rebuildGraph } from "../src/services/graph/rebuild.js";
import { commitTriples } from "../src/services/graph/relationshipExtractor.js";
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
    return true;
  } catch {
    return false;
  }
}

function edge(id, fromId, toId) {
  return { id, fromKind: "entity", fromId, toKind: "entity", toId, type: "knows" };
}
