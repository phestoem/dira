import { prisma } from "../prisma.js";
import { fetchAltimetrixNudge, syncPendingEvents } from "../services/altimetrixBridge.js";
import { digestSettings } from "../services/digestService.js";

export default async function userRoutes(fastify) {
  fastify.get("/users/me", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) return reply.code(404).send({ error: "not found" });
    return presentUser(user);
  });

  fastify.patch("/users/me", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) return reply.code(404).send({ error: "not found" });
    const incoming = request.body?.settings;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return reply.code(400).send({ error: "settings is required" });
    }
    const current = user.settings && typeof user.settings === "object" && !Array.isArray(user.settings) ? user.settings : {};
    const next = { ...current };
    if (typeof incoming.digestEnabled === "boolean") next.digestEnabled = incoming.digestEnabled;
    if (typeof incoming.digestTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(incoming.digestTime)) {
      next.digestTime = incoming.digestTime;
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { settings: next },
    });
    return presentUser(updated);
  });

  fastify.patch("/users/me/altimetrix", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const altimetrixUserId =
      typeof request.body?.altimetrixUserId === "string" ? request.body.altimetrixUserId.trim() : "";
    if (!altimetrixUserId) {
      return reply.code(400).send({ error: "altimetrixUserId is required" });
    }

    try {
      const user = await prisma.user.update({
        where: { id: request.userId },
        data: { altimetrixUserId },
      });
      setImmediate(() => {
        syncPendingEvents(user.id, user).catch((err) => {
          console.error("[bridge] error:", err.message);
        });
      });
      return presentUser(user);
    } catch (err) {
      if (err.code === "P2002") {
        return reply.code(409).send({ error: "That Altimetrix user is already linked" });
      }
      request.log.error(err);
      return reply.code(500).send({ error: "Could not link Altimetrix" });
    }
  });

  fastify.get("/users/me/altimetrix-nudge", { preHandler: [fastify.authenticate] }, async (request) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user?.altimetrixUserId) return { nudge: null };
    const nudge = await fetchAltimetrixNudge(user);
    return { nudge };
  });

  fastify.post("/users/me/altimetrix/sync", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) return reply.code(404).send({ error: "not found" });
    if (!user.altimetrixUserId) {
      return reply.code(400).send({ error: "Altimetrix is not linked" });
    }
    const result = await syncPendingEvents(user.id, user);
    return result;
  });
}

function presentUser(user) {
  return {
    id: user.id,
    handle: user.handle,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    altimetrixUserId: user.altimetrixUserId,
    settings: digestSettings(user.settings),
  };
}
