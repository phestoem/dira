import { prisma } from "../prisma.js";

export default async function journalRoutes(fastify) {
  fastify.get("/journal", { preHandler: [fastify.authenticate] }, async (request) => {
    const entries = await prisma.diaryEntry.findMany({
      where: { userId: request.userId },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        content: entry.rawContent,
        occurredAt: entry.occurredAt,
        createdAt: entry.createdAt,
      })),
    };
  });

  fastify.post("/journal", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    if (!content) {
      return reply.code(400).send({ error: "Write something first" });
    }

    let occurredAt = new Date();
    if (request.body?.occurredAt) {
      const parsed = new Date(request.body.occurredAt);
      if (Number.isNaN(parsed.getTime())) {
        return reply.code(400).send({ error: "Invalid date" });
      }
      occurredAt = parsed;
    }

    const entry = await prisma.diaryEntry.create({
      data: {
        userId: request.userId,
        rawContent: content,
        occurredAt,
        isPrivate: true,
        sharedWithAltimetrix: false,
      },
    });

    return {
      id: entry.id,
      content: entry.rawContent,
      occurredAt: entry.occurredAt,
      createdAt: entry.createdAt,
    };
  });
}
