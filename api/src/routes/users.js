import { prisma } from "../prisma.js";
import { syncPendingEvents } from "../services/altimetrixBridge.js";

export default async function userRoutes(fastify) {
  fastify.get("/users/me", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUnique({ where: { id: request.userId } });
    if (!user) return reply.code(404).send({ error: "not found" });
    return presentUser(user);
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
  };
}
