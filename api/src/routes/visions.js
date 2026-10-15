import { prisma } from "../prisma.js";
import { checkAndSendNudges } from "../services/nudgeService.js";
import { getSubgraph } from "../services/graph/graphQuery.js";

const STATUSES = new Set(["seed", "forming", "held", "active", "released", "archived"]);
const FILTERABLE = new Set(["seed", "forming", "held", "active"]);
const PAGE_SIZE = 30;

export default async function visionRoutes(fastify) {
  fastify.get("/visions", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const status = typeof request.query?.status === "string" ? request.query.status : "";
    if (status && !FILTERABLE.has(status)) {
      return reply.code(400).send({ error: "Unknown status" });
    }

    const visions = await prisma.vision.findMany({
      where: {
        userId: request.userId,
        ...(status ? { status } : { status: { not: "archived" } }),
      },
      orderBy: [{ lastTouchedAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE,
    });

    return { visions: visions.map((vision) => presentVision(vision)) };
  });

  fastify.get("/visions/pending-nudges", { preHandler: [fastify.authenticate] }, async (request) => {
    const nudges = await checkAndSendNudges(request.userId);
    return { nudges };
  });

  fastify.get("/visions/:id/suggestions", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const vision = await ownVision(request.userId, request.params.id);
    if (!vision) return reply.code(404).send({ error: "Vision not found" });

    const location = locationOf(vision);
    const tags = (vision.tags || []).map((tag) => tag.toLowerCase());
    const linked = new Set(
      (Array.isArray(vision.connectedEvents) ? vision.connectedEvents : [])
        .map((item) => item?.eventId)
        .filter(Boolean),
    );
    const events = await prisma.event.findMany({
      where: { userId: request.userId, status: { not: "archived" } },
      orderBy: { createdAt: "desc" },
      take: 200,
    });

    const suggestions = events
      .filter((event) => !linked.has(event.id))
      .map((event) => ({ event, score: scoreEvent(event, location, tags) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ event }) => ({
        id: event.id,
        title: event.title,
        location: locationOfEvent(event),
        tags: event.tags ?? [],
      }));

    const seeds = (Array.isArray(vision.connectedEntities) ? vision.connectedEntities : [])
      .filter((item) => item?.entityId)
      .map((item) => ({ kind: "entity", id: item.entityId }));
    let nearby = [];
    if (seeds.length) {
      const subgraph = await getSubgraph(request.userId, seeds, { depth: 2, maxNodes: 40 }).catch(() => ({ nodes: [], edges: [] }));
      nearby = (subgraph.nodes || [])
        .filter((node) => node.kind === "entity" || node.kind === "event")
        .slice(0, 8)
        .map((node) => ({ id: node.id, title: node.name, kind: node.kind }));
    }

    return { suggestions, nearby };
  });

  fastify.post("/visions/:id/link-event", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const vision = await ownVision(request.userId, request.params.id);
    if (!vision) return reply.code(404).send({ error: "Vision not found" });
    const eventId = request.body?.eventId;
    if (!eventId || typeof eventId !== "string") {
      return reply.code(400).send({ error: "eventId is required" });
    }
    const event = await prisma.event.findFirst({
      where: { id: eventId, userId: request.userId, status: { not: "archived" } },
    });
    if (!event) return reply.code(404).send({ error: "Event not found" });

    const current = Array.isArray(vision.connectedEvents) ? vision.connectedEvents : [];
    const next = current.some((item) => item?.eventId === event.id)
      ? current
      : [...current, { eventId: event.id, relationship: "related" }];
    const updated = await prisma.vision.update({
      where: { id: vision.id },
      data: { connectedEvents: next, lastTouchedAt: new Date() },
    });
    return presentVisionDetail(updated, request.userId);
  });

  fastify.get("/visions/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const vision = await ownVision(request.userId, request.params.id);
    if (!vision) return reply.code(404).send({ error: "Vision not found" });
    return presentVisionDetail(vision, request.userId);
  });

  fastify.patch("/visions/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const existing = await ownVision(request.userId, request.params.id);
    if (!existing) return reply.code(404).send({ error: "Vision not found" });

    const body = request.body || {};
    const data = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim()) {
        return reply.code(400).send({ error: "Title is required" });
      }
      data.title = body.title.trim();
    }
    if (body.summary !== undefined) {
      data.summary = typeof body.summary === "string" && body.summary.trim() ? body.summary.trim() : null;
    }
    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !STATUSES.has(body.status)) {
        return reply.code(400).send({ error: "Unknown status" });
      }
      data.status = body.status;
    }
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string")) {
        return reply.code(400).send({ error: "Tags must be a list of strings" });
      }
      data.tags = body.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
    }
    if (body.notes !== undefined) {
      data.notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    }
    if (body.nudgeAfter !== undefined) {
      const when = new Date(body.nudgeAfter);
      if (Number.isNaN(when.getTime())) {
        return reply.code(400).send({ error: "Invalid date" });
      }
      data.nudgeAfter = when;
    }

    if (Object.keys(data).length === 0) {
      return presentVisionDetail(existing, request.userId);
    }

    const updated = await prisma.vision.update({
      where: { id: existing.id },
      data: { ...data, lastTouchedAt: new Date() },
    });
    return presentVisionDetail(updated, request.userId);
  });
}

async function ownVision(userId, id) {
  const vision = await prisma.vision.findFirst({ where: { id, userId } });
  if (!vision || vision.status === "archived") return null;
  return vision;
}

async function presentVisionDetail(vision, userId) {
  const base = presentVision(vision, { detail: true });
  const links = Array.isArray(vision.connectedEvents) ? vision.connectedEvents : [];
  const ids = links.map((item) => item?.eventId).filter(Boolean);
  const events = ids.length
    ? await prisma.event.findMany({
        where: { userId, id: { in: ids } },
        select: { id: true, title: true },
      })
    : [];
  const titles = new Map(events.map((event) => [event.id, event.title]));
  base.connectedEvents = links
    .filter((item) => item?.eventId)
    .map((item) => ({
      eventId: item.eventId,
      relationship: item.relationship || "related",
      title: titles.get(item.eventId) || "Event",
    }));
  base.connectedEntities = (Array.isArray(vision.connectedEntities) ? vision.connectedEntities : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      entityId: item.entityId || null,
      name: item.name || null,
      relationship: item.relationship || item.role || null,
    }));
  return base;
}

function presentVision(vision, { detail = false } = {}) {
  const entities = Array.isArray(vision.connectedEntities) ? vision.connectedEntities : [];
  const place = entities.find(
    (item) => item && typeof item === "object" && (item.role === "location" || item.relationship === "location"),
  );
  const payload = {
    id: vision.id,
    title: vision.title,
    summary: vision.summary,
    status: vision.status,
    tags: vision.tags ?? [],
    location: place?.name ? String(place.name) : null,
    notes: vision.notes ?? null,
    space: vision.space,
    detectedFromJournal: Boolean(vision.rawContent && String(vision.rawContent).trim()),
    lastTouchedAt: vision.lastTouchedAt,
    createdAt: vision.createdAt,
  };
  if (detail) {
    payload.rawContent = vision.rawContent || null;
    payload.nudgeAfter = vision.nudgeAfter;
    const attributes = vision.attributes && typeof vision.attributes === "object" ? vision.attributes : {};
    payload.altimetrixContext = typeof attributes.altimetrixContext === "string" ? attributes.altimetrixContext : null;
  }
  return payload;
}

function locationOf(vision) {
  return presentVision(vision).location;
}

function locationOfEvent(event) {
  const places = Array.isArray(event.places) ? event.places : [];
  const named = places.find((place) => place && typeof place.name === "string" && place.name.trim());
  return named ? named.name : null;
}

function scoreEvent(event, location, tags) {
  let score = 0;
  const eventLocation = locationOfEvent(event);
  if (location && eventLocation) {
    const left = location.toLowerCase();
    const right = eventLocation.toLowerCase();
    if (left === right || right.includes(left) || left.includes(right)) score += 2;
  }
  const eventTags = (event.tags || []).map((tag) => tag.toLowerCase());
  score += eventTags.filter((tag) => tags.includes(tag)).length;
  if (location) {
    const haystack = `${event.title} ${event.understoodMeaning || ""}`.toLowerCase();
    if (haystack.includes(location.toLowerCase())) score += 1;
  }
  return score;
}
