import { prisma } from "../prisma.js";
import { detectVisionInJournalEntry } from "../services/contextEngine.js";
import { scheduleExtraction } from "../services/graph/relationshipExtractor.js";
import { sendJournalEntry } from "../services/altimetrixBridge.js";

// Entries are sealed by default; "Share with Altimetrix" is per entry and starts off.
function view(entry) {
  return {
    id: entry.id,
    content: entry.rawContent,
    occurredAt: entry.occurredAt,
    createdAt: entry.createdAt,
    sharedWithAltimetrix: entry.sharedWithAltimetrix,
    sentToAltimetrixAt: entry.sentToAltimetrixAt,
  };
}

export default async function journalRoutes(fastify) {
  fastify.get("/journal", { preHandler: [fastify.authenticate] }, async (request) => {
    const entries = await prisma.diaryEntry.findMany({
      where: { userId: request.userId },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
    return { entries: entries.map(view) };
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

    const userId = request.userId;
    const entry = await prisma.diaryEntry.create({
      data: {
        userId,
        rawContent: content,
        occurredAt,
        isPrivate: true,
        sharedWithAltimetrix: false,
      },
    });

    setImmediate(async () => {
      try {
        await detectVisionInJournalEntry(entry, userId);
      } catch (err) {
        console.error("[vision-detect] failed:", err.message);
      }
    });
    scheduleExtraction(userId, content, { source: "journal", forceStatus: "suggested", diaryEntryId: entry.id });

    return view(entry);
  });

  fastify.patch("/journal/:id", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const share = request.body?.sharedWithAltimetrix;
    if (typeof share !== "boolean") {
      return reply.code(400).send({ error: "sharedWithAltimetrix must be true or false" });
    }
    const userId = request.userId;
    const found = await prisma.diaryEntry.findFirst({ where: { id: request.params.id, userId } });
    if (!found) return reply.code(404).send({ error: "Entry not found" });
    const entry = await prisma.diaryEntry.update({ where: { id: found.id }, data: { sharedWithAltimetrix: share } });
    if (share && !entry.sentToAltimetrixAt) {
      // After the answer, like every bridge send; a failure stays unsent for the next sync.
      setImmediate(async () => {
        const user = await prisma.user.findUnique({ where: { id: userId } }).catch(() => null);
        if (user) await sendJournalEntry(entry, user);
      });
    }
    return view(entry);
  });
}
