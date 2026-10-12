import { prisma } from "../prisma.js";

const SPACES = new Set(["personal", "family", "professional", "vision"]);
const STATUSES = new Set(["active", "completed", "cancelled", "dormant", "archived"]);
const PAGE_SIZE = 50;

export default async function eventRoutes(fastify) {
  fastify.get("/events", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const space = typeof request.query?.space === "string" ? request.query.space : "";
    if (space && !SPACES.has(space)) {
      return reply.code(400).send({ error: "Unknown space" });
    }

    const cursor = typeof request.query?.cursor === "string" ? request.query.cursor : "";
    const cursorEvent = cursor
      ? await prisma.event.findFirst({
          where: { id: cursor, userId: request.userId },
          select: { id: true, createdAt: true },
        })
      : null;

    const events = await prisma.event.findMany({
      where: {
        userId: request.userId,
        status: { not: "archived" },
        ...(space ? { space } : {}),
        ...(cursorEvent
          ? {
              OR: [
                { createdAt: { lt: cursorEvent.createdAt } },
                { createdAt: cursorEvent.createdAt, id: { lt: cursorEvent.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
    });

    const page = events.slice(0, PAGE_SIZE);
    const next = events.length > PAGE_SIZE ? page[page.length - 1] : null;
    return {
      events: page.map(presentEvent),
      nextCursor: next ? next.id : null,
    };
  });

  fastify.get("/events/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const event = await prisma.event.findFirst({
      where: { id: request.params.id, userId: request.userId },
    });
    if (!event || event.status === "archived") {
      return reply.code(404).send({ error: "Event not found" });
    }
    return presentEvent(event);
  });

  fastify.patch("/events/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const existing = await prisma.event.findFirst({
      where: { id: request.params.id, userId: request.userId, status: { not: "archived" } },
    });
    if (!existing) {
      return reply.code(404).send({ error: "Event not found" });
    }

    const body = request.body || {};
    const data = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim()) {
        return reply.code(400).send({ error: "Title is required" });
      }
      data.title = body.title.trim();
    }
    if (body.notes !== undefined) {
      data.notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    }
    if (body.space !== undefined) {
      if (typeof body.space !== "string" || !SPACES.has(body.space)) {
        return reply.code(400).send({ error: "Unknown space" });
      }
      data.space = body.space;
    }
    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !STATUSES.has(body.status)) {
        return reply.code(400).send({ error: "Unknown status" });
      }
      data.status = body.status;
    }

    const updated = await prisma.event.update({
      where: { id: existing.id },
      data,
    });
    return presentEvent(updated);
  });

  fastify.delete("/events/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const existing = await prisma.event.findFirst({
      where: { id: request.params.id, userId: request.userId, status: { not: "archived" } },
    });
    if (!existing) {
      return reply.code(404).send({ error: "Event not found" });
    }
    await prisma.event.update({
      where: { id: existing.id },
      data: { status: "archived" },
    });
    return { success: true };
  });
}

function presentEvent(event) {
  const places = Array.isArray(event.places) ? event.places : [];
  const named = places.find((place) => place && typeof place.name === "string" && place.name.trim());
  return {
    ...event,
    location: named ? named.name : null,
  };
}
