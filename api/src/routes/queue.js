import { prisma } from "../prisma.js";
import { isSignificantEvent, sendLifeEvent } from "../services/altimetrixBridge.js";
import { applyCorrections, createEventFromUnderstanding } from "../services/contextEngine.js";
import { extractAndLinkEntities } from "./entities.js";

const EVENT_TYPES = new Set([
  "project_update",
  "financial",
  "personal",
  "family",
  "commitment",
  "milestone",
  "setback",
  "social",
  "health",
]);
const INVALID_DATE = Symbol("invalid-date");

export default async function queueRoutes(fastify) {
  fastify.get("/queue", { preHandler: [fastify.authenticate] }, async (request) => {
    const rows = await prisma.inputQueue.findMany({
      where: {
        userId: request.userId,
        OR: [
          { processingStatus: "pending" },
          { processingStatus: "processing" },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        source: true,
        processingStatus: true,
        understoodAs: true,
        createdAt: true,
      },
    });
    return { items: rows.map(presentQueueItem) };
  });

  fastify.post("/queue/:id/confirm", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const queue = await prisma.inputQueue.findFirst({
      where: { id: request.params.id, userId: request.userId },
    });
    if (!queue) return reply.code(404).send({ error: "Input not found" });
    if (queue.processingStatus === "understood") {
      return reply.code(409).send({ error: "Input is already confirmed" });
    }
    if (queue.processingStatus === "pending" || !queue.understoodAs) {
      return reply.code(409).send({ error: "Input is not ready to confirm" });
    }
    if (queue.processingStatus !== "processing") {
      return reply.code(409).send({ error: "Input is not ready to confirm" });
    }

    let stored;
    try {
      stored = JSON.parse(queue.understoodAs);
    } catch {
      return reply.code(422).send({ error: "Stored understanding is unreadable" });
    }

    const body = request.body || {};
    const understood = applyCorrections(stored.understood, body.corrections);
    if (body.space) understood.space = body.space;
    else understood.space = stored.suggestedSpace;
    const explicitType = body.corrections?.eventType;
    if (typeof explicitType === "string" && EVENT_TYPES.has(explicitType)) {
      understood.eventType = explicitType;
    } else {
      understood.eventType = stored.suggestedEventType;
    }

    const occurredAt = occurredAtFromConfirm(body, understood);
    if (occurredAt === INVALID_DATE) {
      return reply.code(400).send({ error: "occurredAt must be YYYY-MM-DD" });
    }

    try {
      const userId = request.userId;
      const event = await createEventFromUnderstanding(userId, understood, body.entityId || null, true, queue.id, {
        fullText: typeof stored.fullText === "string" ? stored.fullText : null,
        sourceFile: typeof stored.sourceFile === "string" ? stored.sourceFile : queue.filePath,
        occurredAt,
      });
      setImmediate(() => {
        extractAndLinkEntities(event, userId, understood).catch((err) => {
          console.error("[entity-extract] failed:", err.message);
        });
      });
      setImmediate(async () => {
        try {
          if (!isSignificantEvent(event)) return;
          const user = await prisma.user.findUnique({ where: { id: userId } });
          await sendLifeEvent(event, userId, user);
        } catch (err) {
          console.error("[bridge] error:", err.message);
        }
      });
      return event;
    } catch (error) {
      request.log.error(error);
      const statusCode = error.statusCode || 500;
      return reply.code(statusCode).send({
        error: statusCode === 500 ? "Could not save this understanding" : error.message,
      });
    }
  });

  fastify.post("/queue/:id/reopen", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const queue = await prisma.inputQueue.findFirst({
      where: { id: request.params.id, userId: request.userId },
    });
    if (!queue) return reply.code(404).send({ error: "Input not found" });
    if (queue.resultEventId) {
      const event = await prisma.event.findFirst({
        where: { id: queue.resultEventId, userId: request.userId },
        select: { status: true },
      });
      if (event && event.status !== "archived") {
        return reply.code(409).send({ error: "Undo the saved event first" });
      }
    }
    const understoodAs = restoredUnderstanding(queue, request.body?.understood);
    await prisma.inputQueue.update({
      where: { id: queue.id },
      data: {
        processingStatus: "processing",
        understoodAs,
        resultEventId: null,
        processedAt: null,
        error: null,
      },
    });
    return { success: true };
  });

  fastify.post("/queue/:id/dismiss", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const queue = await prisma.inputQueue.findFirst({
      where: { id: request.params.id, userId: request.userId },
    });
    if (!queue) return reply.code(404).send({ error: "Input not found" });
    if (queue.processingStatus === "understood") {
      return reply.code(409).send({ error: "Input is already confirmed" });
    }
    await prisma.inputQueue.update({
      where: { id: queue.id },
      data: { processingStatus: "dismissed", processedAt: new Date() },
    });
    return { success: true };
  });
}

function restoredUnderstanding(queue, snapshot) {
  if (snapshot && typeof snapshot === "object" && snapshot.understood && typeof snapshot.understood === "object") {
    let stored = null;
    try {
      stored = JSON.parse(queue.understoodAs || "");
    } catch {
      stored = null;
    }
    if (stored?.understood) return queue.understoodAs;
    return JSON.stringify({
      understood: snapshot.understood,
      suggestedSpace: snapshot.suggestedSpace || null,
      suggestedEventType: snapshot.suggestedEventType || null,
      fullText: null,
      sourceFile: queue.filePath || null,
    });
  }
  return queue.understoodAs;
}

function presentQueueItem(row) {
  let stored = null;
  if (row.understoodAs) {
    try {
      stored = JSON.parse(row.understoodAs);
    } catch {
      stored = null;
    }
  }
  const understood = stored && typeof stored === "object" ? stored.understood || null : null;
  const ready = row.processingStatus === "processing" && typeof understood?.title === "string" && understood.title.trim();
  return {
    id: row.id,
    source: row.source,
    processingStatus: row.processingStatus,
    understoodAs: row.understoodAs,
    createdAt: row.createdAt,
    ready,
    title: ready ? understood.title : null,
    summary: typeof understood?.summary === "string" ? understood.summary : null,
    altimetrixContext: typeof understood?.altimetrixContext === "string" ? understood.altimetrixContext : null,
    suggestedSpace: stored?.suggestedSpace || "personal",
    needsClarification: typeof understood?.needsClarification === "string" ? understood.needsClarification : null,
  };
}

function occurredAtFromConfirm(body, understood) {
  if (Object.prototype.hasOwnProperty.call(body, "occurredAt")) return dateFromIsoDay(body.occurredAt);
  return dateFromIsoDay(understood?.occurredAt);
}

function dateFromIsoDay(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return INVALID_DATE;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return INVALID_DATE;
  return date;
}
