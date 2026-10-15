import { prisma } from "../prisma.js";
import { findDuplicateCandidates, getOrCreateSelf, mergeEntities, normalizeName } from "../services/graph/entityResolver.js";
import {
  findPaths,
  getEntityTimeline,
  getFamilyTree,
  getMoneyFlows,
  getNeighbors,
  getSubgraph,
} from "../services/graph/graphQuery.js";
import { commitTriples } from "../services/graph/relationshipExtractor.js";
import { categoryOf, listRelationshipTypes, normalizeType } from "../services/graph/relationshipTypes.js";
import { groupSuggestions } from "../services/graph/graphQuality.js";
import { rebuildGraph } from "../services/graph/rebuild.js";
import { resetGraph } from "../services/graph/reset.js";

export default async function graphRoutes(fastify) {
  fastify.get("/graph/types", { preHandler: [fastify.authenticate] }, async () => ({
    types: listRelationshipTypes(),
  }));

  fastify.get("/graph/entity/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const entity = await ownEntity(request.userId, request.params.id);
    if (!entity) return reply.code(404).send({ error: "Entity not found" });
    const [neighbors, timeline, money] = await Promise.all([
      getNeighbors(request.userId, "entity", entity.id, { includeSuggested: true }),
      getEntityTimeline(request.userId, entity.id),
      getMoneyFlows(request.userId, { counterpart: entity.id }),
    ]);
    return { entity: present(entity), neighbors: neighbors.map(presentNeighbor), timeline, money };
  });

  fastify.get("/graph/subgraph", { preHandler: [fastify.authenticate] }, async (request) => {
    const seedId = typeof request.query?.seed === "string" ? request.query.seed : "";
    const self = seedId ? await ownEntity(request.userId, seedId) : await getOrCreateSelf(request.userId);
    const depth = Number(request.query?.depth) || 2;
    if (!self) return { nodes: [], edges: [] };
    return getSubgraph(request.userId, [{ kind: "entity", id: self.id }], { depth, includeSuggested: false });
  });

  fastify.get("/graph/path", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const from = await resolveNode(request.userId, request.query?.from);
    const to = await resolveNode(request.userId, request.query?.to);
    if (!from || !to) return reply.code(400).send({ error: "Both ends of the path are required" });
    return { paths: await findPaths(request.userId, from, to, { maxDepth: 4, limit: 3 }) };
  });

  fastify.get("/graph/family", { preHandler: [fastify.authenticate] }, async (request) => getFamilyTree(request.userId));

  fastify.get("/graph/money", { preHandler: [fastify.authenticate] }, async (request) => ({
    flows: await getMoneyFlows(request.userId, {
      counterpart: request.query?.counterpart,
      from: request.query?.from,
      to: request.query?.to,
    }),
  }));

  fastify.get("/graph/suggestions", { preHandler: [fastify.authenticate] }, async (request) => {
    const [edges, duplicates] = await Promise.all([
      prisma.relationship.findMany({
        where: { userId: request.userId, status: "suggested" },
        orderBy: { createdAt: "desc" },
        take: 80,
      }),
      findDuplicateCandidates(request.userId),
    ]);
    const conflicts = edges.filter((edge) => edge.label === "conflict" || edge.attributes?.conflictWith);
    const relationships = edges.filter((edge) => edge.label !== "conflict" && !edge.attributes?.conflictWith);
    const self = await prisma.entity.findFirst({ where: { userId: request.userId, isSelf: true }, select: { name: true } });
    const grouped = groupSuggestions(await decorate(request.userId, relationships), self?.name || "");
    const decoratedConflicts = await decorate(request.userId, conflicts);
    return {
      relationships: grouped.relationships,
      family: grouped.family,
      assets: grouped.assets,
      duplicates,
      conflicts: decoratedConflicts,
      count: grouped.count + duplicates.length + decoratedConflicts.length,
    };
  });

  fastify.post("/graph/relationships", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body || {};
    const normalized = normalizeType(body.type);
    if (!normalized) return reply.code(400).send({ error: "Unknown relationship type" });
    const committed = await commitTriples(request.userId, [{
      subject: { name: body.fromName, type: body.fromType || "person" },
      predicate: normalized.type,
      object: { name: body.toName, type: body.toType || "person" },
      validFrom: body.validFrom || null,
      validTo: body.validTo || null,
      attributes: body.attributes || {},
      confidence: 1,
      evidence: body.note || "",
    }], { source: "user" });
    if (!committed.created && !committed.updated) return reply.code(400).send({ error: "Could not save that connection" });
    return committed;
  });

  fastify.post("/graph/facts", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
    if (text.length < 8) return reply.code(400).send({ error: "Say who is connected" });
    const { extractTriples } = await import("../services/graph/relationshipExtractor.js");
    const self = await getOrCreateSelf(request.userId);
    let extracted;
    try {
      extracted = await extractTriples(text, { selfName: self.name, today: new Date().toISOString().slice(0, 10) });
    } catch (err) {
      const busy = err.status === 429;
      return reply.code(busy ? 503 : 502).send({ error: busy ? "DIRA is busy right now. Send that again." : "Could not read that connection" });
    }
    return commitTriples(request.userId, extracted.triples, { source: "user", entityFacts: extracted.entityFacts });
  });

  fastify.patch("/graph/relationships/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const existing = await ownEdge(request.userId, request.params.id);
    if (!existing) return reply.code(404).send({ error: "Relationship not found" });
    const body = request.body || {};
    const data = {};
    if (body.type) {
      const normalized = normalizeType(body.type);
      if (!normalized) return reply.code(400).send({ error: "Unknown relationship type" });
      data.type = normalized.type;
      data.category = categoryOf(normalized.type);
    }
    if (body.label !== undefined) data.label = textOrNull(body.label);
    if (body.status && ["suggested", "confirmed", "rejected"].includes(body.status)) data.status = body.status;
    if (body.validFrom !== undefined) data.validFrom = body.validFrom ? new Date(body.validFrom) : null;
    if (body.validTo !== undefined) data.validTo = body.validTo ? new Date(body.validTo) : null;
    if (body.attributes && typeof body.attributes === "object") data.attributes = { ...existing.attributes, ...body.attributes };
    const updated = await prisma.relationship.update({ where: { id: existing.id }, data });
    return presentEdge(updated);
  });

  fastify.post("/graph/relationships/:id/confirm", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const existing = await ownEdge(request.userId, request.params.id);
    if (!existing) return reply.code(404).send({ error: "Relationship not found" });
    const updated = await prisma.relationship.update({
      where: { id: existing.id },
      data: { status: "confirmed", source: "user" },
    });
    return presentEdge(updated);
  });

  fastify.post("/graph/relationships/:id/reject", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const existing = await ownEdge(request.userId, request.params.id);
    if (!existing) return reply.code(404).send({ error: "Relationship not found" });
    const updated = await prisma.relationship.update({
      where: { id: existing.id },
      data: { status: "rejected" },
    });
    return presentEdge(updated);
  });

  fastify.post("/graph/entities/merge", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      return await mergeEntities(request.userId, request.body?.keepId, request.body?.mergeId);
    } catch (err) {
      return reply.code(err.statusCode || 500).send({ error: err.statusCode ? err.message : "Could not merge those records" });
    }
  });

  fastify.post("/graph/entities/separate", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const left = await ownEntity(request.userId, request.body?.leftId);
    const right = await ownEntity(request.userId, request.body?.rightId);
    if (!left || !right) return reply.code(404).send({ error: "Entity not found" });
    await markSeparate(left, right.id);
    await markSeparate(right, left.id);
    return { success: true };
  });

  fastify.patch("/graph/entities/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const existing = await ownEntity(request.userId, request.params.id);
    if (!existing) return reply.code(404).send({ error: "Entity not found" });
    const body = request.body || {};
    const data = {};
    if (typeof body.name === "string" && body.name.trim()) {
      data.name = body.name.trim();
      data.normalizedName = normalizeName(data.name);
    }
    if (body.kind !== undefined) data.kind = textOrNull(body.kind);
    if (body.birthDate !== undefined) data.birthDate = body.birthDate ? new Date(body.birthDate) : null;
    if (body.deathDate !== undefined) data.deathDate = body.deathDate ? new Date(body.deathDate) : null;
    if (Array.isArray(body.aliases)) data.aliases = body.aliases.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
    const updated = await prisma.entity.update({ where: { id: existing.id }, data });
    return present(updated);
  });

  fastify.post("/graph/reset", { preHandler: [fastify.authenticate] }, async (request) => {
    const dryRun = request.body?.dryRun !== false;
    return resetGraph(request.userId, { dryRun });
  });

  fastify.post("/graph/rebuild", { preHandler: [fastify.authenticate] }, async (request) => {
    const body = request.body || {};
    const dryRun = body.dryRun !== false;
    const force = body.force === true;
    return rebuildGraph(request.userId, {
      dryRun,
      force,
      onlyMissing: force ? false : body.onlyMissing !== false,
    });
  });
}

async function resolveNode(userId, value) {
  if (!value || typeof value !== "string") return null;
  if (value === "self" || value === "me") {
    const self = await getOrCreateSelf(userId);
    return { kind: "entity", id: self.id };
  }
  const entity = await prisma.entity.findFirst({
    where: { userId, status: { not: "archived" }, OR: [{ id: value }, { name: { equals: value, mode: "insensitive" } }] },
  });
  return entity ? { kind: "entity", id: entity.id } : null;
}

async function decorate(userId, edges) {
  const ids = [...new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]))];
  const entities = ids.length ? await prisma.entity.findMany({ where: { userId, id: { in: ids } } }) : [];
  const names = new Map(entities.map((entity) => [entity.id, entity.name]));
  return edges.map((edge) => ({
    ...presentEdge(edge),
    fromName: names.get(edge.fromId) || edge.fromKind,
    toName: names.get(edge.toId) || edge.toKind,
    fromJournal: edge.source === "journal",
  }));
}

async function markSeparate(entity, otherId) {
  const attributes = entity.attributes && typeof entity.attributes === "object" ? { ...entity.attributes } : {};
  const list = Array.isArray(attributes.notDuplicateOf) ? attributes.notDuplicateOf : [];
  if (!list.includes(otherId)) list.push(otherId);
  attributes.notDuplicateOf = list;
  await prisma.entity.update({ where: { id: entity.id }, data: { attributes } });
}

function presentNeighbor(row) {
  return {
    edgeId: row.edge.id,
    type: row.edge.type,
    category: row.edge.category,
    status: row.edge.status,
    displayType: row.displayType,
    direction: row.direction,
    validFrom: row.edge.validFrom,
    validTo: row.edge.validTo,
    label: row.edge.label,
    source: row.edge.source,
    node: row.node,
  };
}

function presentEdge(edge) {
  return {
    id: edge.id,
    type: edge.type,
    category: edge.category,
    status: edge.status,
    source: edge.source,
    label: edge.label,
    validFrom: edge.validFrom,
    validTo: edge.validTo,
    evidenceText: edge.evidenceText,
    attributes: edge.attributes || {},
    fromKind: edge.fromKind,
    fromId: edge.fromId,
    toKind: edge.toKind,
    toId: edge.toId,
  };
}

function present(entity) {
  return {
    id: entity.id,
    name: entity.name,
    entityType: entity.entityType,
    kind: entity.kind,
    isSelf: entity.isSelf,
    birthDate: entity.birthDate,
    deathDate: entity.deathDate,
    aliases: entity.aliases || [],
  };
}

async function ownEntity(userId, id) {
  if (!id) return null;
  return prisma.entity.findFirst({ where: { id, userId, status: { not: "archived" } } });
}

async function ownEdge(userId, id) {
  return prisma.relationship.findFirst({ where: { id, userId } });
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null;
}
