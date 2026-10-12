import { prisma } from "../prisma.js";

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

    return { visions: visions.map(presentVision) };
  });

  fastify.get("/visions/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const vision = await prisma.vision.findFirst({
      where: { id: request.params.id, userId: request.userId },
    });
    if (!vision || vision.status === "archived") {
      return reply.code(404).send({ error: "Vision not found" });
    }
    return presentVision(vision);
  });

  fastify.patch("/visions/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const existing = await prisma.vision.findFirst({
      where: { id: request.params.id, userId: request.userId, status: { not: "archived" } },
    });
    if (!existing) {
      return reply.code(404).send({ error: "Vision not found" });
    }

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

    if (Object.keys(data).length === 0) {
      return presentVision(existing);
    }

    const updated = await prisma.vision.update({
      where: { id: existing.id },
      data: { ...data, lastTouchedAt: new Date() },
    });
    return presentVision(updated);
  });
}

function presentVision(vision) {
  const entities = Array.isArray(vision.connectedEntities) ? vision.connectedEntities : [];
  const place = entities.find(
    (item) => item && typeof item === "object" && (item.role === "location" || item.relationship === "location"),
  );
  return {
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
}
