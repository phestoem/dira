import { prisma } from "../prisma.js";

export default async function statsRoutes(fastify) {
  fastify.get("/stats", { preHandler: [fastify.authenticate] }, async (request) => {
    const userId = request.userId;
    const where = { userId, status: { not: "archived" } };
    const [events, visions, entities] = await Promise.all([
      prisma.event.count({ where }),
      prisma.vision.count({ where }),
      prisma.entity.count({ where }),
    ]);
    return { events, visions, entities };
  });
}
