import { prisma } from "../prisma.js";
import { autoExtractOn } from "../services/graph/autoExtract.js";
import { normalizeName } from "../services/graph/entityResolver.js";
import { anchorEventEdges, scheduleExtraction } from "../services/graph/relationshipExtractor.js";
import { getNeighbors } from "../services/graph/graphQuery.js";
import { categoryOf, normalizeType } from "../services/graph/relationshipTypes.js";

const TYPES = new Set(["person", "place", "project", "organisation", "property", "asset", "vehicle", "document", "other"]);
const SPACES = new Set(["personal", "family", "professional", "vision"]);
const STATUSES = new Set(["active", "dormant", "archived"]);
const TARGETS = new Set(["event", "vision", "entity"]);

export default async function entityRoutes(fastify) {
  fastify.post("/entities", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      return await findOrCreateEntity(request.userId, request.body || {});
    } catch (err) {
      return sendError(reply, err, "Could not save this entity");
    }
  });

  fastify.get("/entities", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const entityType = typeof request.query?.entityType === "string" ? request.query.entityType : "";
    const space = typeof request.query?.space === "string" ? request.query.space : "";
    const search = typeof request.query?.search === "string" ? request.query.search.trim() : "";
    if (entityType && !TYPES.has(entityType)) {
      return reply.code(400).send({ error: "Unknown entity type" });
    }
    if (space && !SPACES.has(space)) {
      return reply.code(400).send({ error: "Unknown space" });
    }

    const entities = await prisma.entity.findMany({
      where: {
        userId: request.userId,
        status: { not: "archived" },
        ...(entityType ? { entityType } : {}),
        ...(space ? { space } : {}),
        ...(search ? { name: { contains: search.replace(/[%_]/g, ""), mode: "insensitive" } } : {}),
      },
      orderBy: { name: "asc" },
    });
    const index = await relatedIndex(request.userId);
    return {
      entities: entities.map((entity) => {
        const related = linksFor(entity.id, index);
        return presentEntity(entity, {
          eventCount: related.events.length,
          visionCount: related.visions.length,
        });
      }),
    };
  });

  fastify.get("/entities/:id/graph", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const entity = await ownEntity(request.userId, request.params.id);
    if (!entity) return reply.code(404).send({ error: "Entity not found" });
    const relationships = await graphFor(request.userId, entity);
    return { entity: presentEntity(entity), relationships };
  });

  fastify.get("/entities/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const entity = await ownEntity(request.userId, request.params.id);
    if (!entity) return reply.code(404).send({ error: "Entity not found" });
    const index = await relatedIndex(request.userId);
    const related = linksFor(entity.id, index);
    return presentEntity(entity, {
      eventCount: related.events.length,
      visionCount: related.visions.length,
      events: related.events.map((event) => ({ id: event.id, title: event.title })),
      visions: related.visions.map((vision) => ({ id: vision.id, title: vision.title })),
    });
  });

  fastify.patch("/entities/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const existing = await ownEntity(request.userId, request.params.id);
    if (!existing) return reply.code(404).send({ error: "Entity not found" });

    const body = request.body || {};
    const data = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        return reply.code(400).send({ error: "Name is required" });
      }
      data.name = body.name.trim();
      data.normalizedName = normalizeName(data.name);
    }
    if (body.description !== undefined) {
      data.description = textOrNull(body.description);
    }
    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !STATUSES.has(body.status)) {
        return reply.code(400).send({ error: "Unknown status" });
      }
      data.status = body.status;
    }
    if (body.attributes !== undefined) {
      if (!isPlainObject(body.attributes)) {
        return reply.code(400).send({ error: "Attributes must be an object" });
      }
      data.attributes = body.attributes;
    }
    if (body.aliases !== undefined) {
      if (!Array.isArray(body.aliases)) {
        return reply.code(400).send({ error: "Aliases must be a list" });
      }
      data.aliases = stringList(body.aliases);
    }

    const updated = await prisma.entity.update({ where: { id: existing.id }, data });
    return presentEntity(updated);
  });

  fastify.post("/entities/:id/link", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const body = request.body || {};
      if (!TARGETS.has(body.targetType)) {
        return reply.code(400).send({ error: "Unknown target type" });
      }
      if (!body.targetId || typeof body.targetId !== "string") {
        return reply.code(400).send({ error: "targetId is required" });
      }
      return await linkEntityToTarget(request.userId, request.params.id, body);
    } catch (err) {
      return sendError(reply, err, "Could not link this entity");
    }
  });
}

export async function findOrCreateEntity(userId, input) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw httpError("Name is required", 400);
  const entityType = TYPES.has(input.entityType) ? input.entityType : null;
  if (!entityType) throw httpError("Unknown entity type", 400);

  const existing = await prisma.entity.findFirst({
    where: {
      userId,
      status: { not: "archived" },
      name: { equals: name, mode: "insensitive" },
    },
  });
  if (existing) return { ...presentEntity(existing), merged: true };

  const created = await prisma.entity.create({
    data: {
      userId,
      name,
      entityType,
      normalizedName: normalizeName(name),
      description: textOrNull(input.description),
      space: SPACES.has(input.space) ? input.space : "personal",
      attributes: isPlainObject(input.attributes) ? input.attributes : {},
      aliases: stringList(input.aliases),
    },
  });
  return { ...presentEntity(created), merged: false };
}

export async function linkEntityToTarget(userId, entityId, input) {
  const entity = await ownEntity(userId, entityId);
  if (!entity) throw httpError("Entity not found", 404);
  const relationship = typeof input.relationship === "string" && input.relationship.trim()
    ? input.relationship.trim()
    : "related";
  const targetId = input.targetId;

  if (input.targetType === "entity") {
    if (targetId === entity.id) throw httpError("Cannot link an entity to itself", 400);
    const target = await ownEntity(userId, targetId);
    if (!target) throw httpError("Target not found", 404);
    const normalized = normalizeType(relationship) || normalizeType("related_to");
    const duplicate = await prisma.relationship.findFirst({
      where: {
        userId,
        fromKind: "entity",
        fromId: entity.id,
        toKind: "entity",
        toId: target.id,
        type: normalized.type,
      },
    });
    if (!duplicate) {
      await prisma.relationship.create({
        data: {
          userId,
          fromKind: "entity",
          fromId: entity.id,
          toKind: "entity",
          toId: target.id,
          type: normalized.type,
          category: categoryOf(normalized.type),
          status: "confirmed",
          source: "user",
          attributes: {},
        },
      });
    }
    return { success: true };
  }

  if (input.targetType === "event") {
    const event = await prisma.event.findFirst({
      where: { id: targetId, userId, status: { not: "archived" } },
    });
    if (!event) throw httpError("Target not found", 404);
    const field = entity.entityType === "place" || entity.entityType === "property" ? "places" : "people";
    const next = upsertRef(event[field], { entityId: entity.id, name: entity.name, role: relationship });
    await prisma.event.update({ where: { id: event.id }, data: { [field]: next } });
    return { success: true };
  }

  const vision = await prisma.vision.findFirst({
    where: { id: targetId, userId, status: { not: "archived" } },
  });
  if (!vision) throw httpError("Target not found", 404);
  const next = upsertRef(vision.connectedEntities, {
    entityId: entity.id,
    name: entity.name,
    relationship,
  });
  await prisma.vision.update({
    where: { id: vision.id },
    data: { connectedEntities: next, lastTouchedAt: new Date() },
  });
  return { success: true };
}

export async function extractAndLinkEntities(event, userId, understood) {
  // Entities, event anchors and triples are all graph; while auto-extract is off the event waits for a rebuild.
  if (!(await autoExtractOn(userId, `event ${event.id}`))) return [];
  const linked = [];
  const location =
    textOrNull(understood?.location) ||
    textOrNull((Array.isArray(event.places) ? event.places : []).find((place) => place?.name)?.name);
  if (location) {
    const entity = await findOrCreateEntity(userId, {
      name: location,
      entityType: "place",
      space: event.space,
    });
    await linkEntityToTarget(userId, entity.id, {
      targetId: event.id,
      targetType: "event",
      relationship: "location",
    });
    linked.push(entity);
  }

  const people = Array.isArray(event.people) ? event.people : [];
  for (const person of people) {
    const name = textOrNull(typeof person === "string" ? person : person?.name);
    if (!name || person?.entityId) continue;
    const entity = await findOrCreateEntity(userId, {
      name,
      entityType: "person",
      space: event.space,
    });
    await linkEntityToTarget(userId, entity.id, {
      targetId: event.id,
      targetType: "event",
      relationship: textOrNull(person?.role) || "mentioned",
    });
    linked.push(entity);
  }

  const project = textOrNull(understood?.project);
  if (project) {
    const entity = await findOrCreateEntity(userId, {
      name: project,
      entityType: "project",
      space: event.space,
    });
    await linkEntityToTarget(userId, entity.id, {
      targetId: event.id,
      targetType: "event",
      relationship: "project",
    });
    linked.push(entity);
  }

  console.log(`[entity-extract] created/found ${linked.length} entities for event: ${event.id}`);
  try {
    await anchorEventEdges(userId, event);
  } catch (err) {
    console.error("[graph] anchor failed:", err.message);
  }
  const text = [understood?.understoodMeaning, understood?.summary, event.title, String(event.fullText || "").slice(0, 3000)]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n");
  scheduleExtraction(userId, text, { source: "intake", evidenceEventId: event.id, title: event.title });
  return linked;
}

async function graphFor(userId, entity) {
  const [neighbors, index] = await Promise.all([
    getNeighbors(userId, "entity", entity.id, { includeSuggested: true }),
    relatedIndex(userId),
  ]);
  const related = linksFor(entity.id, index);
  return [
    ...neighbors.map((row) => ({
      type: row.node.kind,
      relationship: row.displayType,
      status: row.edge.status,
      category: row.edge.category,
      edgeId: row.edge.id,
      target: { id: row.node.id, name: row.node.name, entityType: row.node.entityType },
    })),
    ...related.events.map((event) => ({
      type: "event",
      relationship: "linked",
      target: { id: event.id, name: event.title },
    })),
    ...related.visions.map((vision) => ({
      type: "vision",
      relationship: "linked",
      target: { id: vision.id, name: vision.title },
    })),
  ];
}

async function relatedIndex(userId) {
  const [events, visions] = await Promise.all([
    prisma.event.findMany({
      where: { userId, status: { not: "archived" } },
      select: { id: true, title: true, people: true, places: true },
    }),
    prisma.vision.findMany({
      where: { userId, status: { not: "archived" } },
      select: { id: true, title: true, connectedEntities: true },
    }),
  ]);
  return { events, visions };
}

function linksFor(entityId, index) {
  return {
    events: index.events.filter(
      (event) => refsInclude(event.people, entityId) || refsInclude(event.places, entityId),
    ),
    visions: index.visions.filter((vision) => refsInclude(vision.connectedEntities, entityId)),
  };
}

function refsInclude(value, entityId) {
  return Array.isArray(value) && value.some((item) => item && item.entityId === entityId);
}

function upsertRef(value, ref) {
  const next = Array.isArray(value) ? [...value] : [];
  const index = next.findIndex((item) => {
    if (!item || typeof item !== "object") return false;
    if (ref.entityId && item.entityId === ref.entityId) return true;
    if (ref.name && item.name && String(item.name).toLowerCase() === String(ref.name).toLowerCase()) return true;
    return false;
  });
  if (index >= 0) next[index] = { ...next[index], ...ref };
  else next.push(ref);
  return next;
}

async function ownEntity(userId, id) {
  return prisma.entity.findFirst({
    where: { id, userId, status: { not: "archived" } },
  });
}

function presentEntity(entity, extra = {}) {
  return {
    id: entity.id,
    name: entity.name,
    entityType: entity.entityType,
    kind: entity.kind || null,
    isSelf: Boolean(entity.isSelf),
    birthDate: entity.birthDate || null,
    deathDate: entity.deathDate || null,
    normalizedName: entity.normalizedName || null,
    description: entity.description,
    space: entity.space,
    status: entity.status,
    attributes: isPlainObject(entity.attributes) ? entity.attributes : {},
    aliases: entity.aliases ?? [],
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    ...extra,
  };
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 20);
}

function textOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendError(reply, err, fallback) {
  const statusCode = err.statusCode || 500;
  return reply.code(statusCode).send({
    error: statusCode === 500 ? fallback : err.message,
  });
}
