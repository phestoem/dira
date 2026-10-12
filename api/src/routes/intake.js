import { randomUUID } from "crypto";
import { extname } from "path";
import { writeFile } from "fs/promises";
import { prisma } from "../prisma.js";
import {
  applyCorrections,
  createEventFromUnderstanding,
  understandFile,
} from "../services/contextEngine.js";

const UPLOAD_DIR = "/tmp/dira-uploads";

export default async function intakeRoutes(fastify) {
  fastify.get("/intake/test", async () => ({
    status: "context engine ready",
  }));

  fastify.post(
    "/intake/file",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const upload = await request.file();
      if (!upload) {
        return reply.code(400).send({ error: "File is required" });
      }

      const filename = upload.filename || "upload";
      console.log("[intake] file received:", filename);

      const buffer = await upload.toBuffer();
      if (!buffer.length) {
        return reply.code(400).send({ error: "File is empty" });
      }

      const mimeType = upload.mimetype || "application/octet-stream";
      const extension = safeExtension(filename);
      const filePath = `${UPLOAD_DIR}/${randomUUID()}${extension}`;
      await writeFile(filePath, buffer);

      const contentType = mimeType.startsWith("image/") ? "image" : "file";
      const queue = await prisma.inputQueue.create({
        data: {
          userId: request.userId,
          rawContent: filename,
          contentType,
          source: "upload",
          mimeType,
          filePath,
          processingStatus: "processing",
        },
      });

      try {
        const result = await understandFile(filePath, mimeType, request.userId);
        await prisma.inputQueue.update({
          where: { id: queue.id },
          data: {
            understoodAs: JSON.stringify({
              understood: result.understood,
              suggestedSpace: result.suggestedSpace,
              suggestedEventType: result.suggestedEventType,
            }),
          },
        });

        return {
          queueId: queue.id,
          understood: {
            title: result.understood.title,
            summary: result.understood.summary,
            contentType: result.understood.contentType,
            project: result.understood.project,
            location: result.understood.location,
            people: result.understood.people,
            financial: result.understood.financial,
            confidence: result.understood.confidence,
          },
          matchingEntities: result.matchingEntities.map((entity) => ({
            id: entity.id,
            name: entity.name,
            entityType: entity.entityType,
          })),
          needsClarification: result.understood.needsClarification,
        };
      } catch (error) {
        request.log.error(error);
        await prisma.inputQueue.update({
          where: { id: queue.id },
          data: {
            processingStatus: "failed",
            error: error.message?.slice(0, 500) || "Understanding failed",
            processedAt: new Date(),
          },
        });
        const statusCode = error.statusCode || 502;
        return reply.code(statusCode).send({
          error: statusCode === 415 ? error.message : "Could not understand this file",
          queueId: queue.id,
        });
      }
    },
  );

  fastify.post(
    "/intake/confirm",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      if (!body.queueId) {
        return reply.code(400).send({ error: "queueId is required" });
      }
      if (body.confirmed !== true) {
        return reply.code(400).send({ error: "confirmed must be true" });
      }

      const queue = await prisma.inputQueue.findFirst({
        where: { id: body.queueId, userId: request.userId },
      });
      if (!queue) {
        return reply.code(404).send({ error: "Input not found" });
      }
      if (queue.processingStatus === "understood") {
        return reply.code(409).send({ error: "Input is already confirmed" });
      }
      if (queue.processingStatus !== "processing" || !queue.understoodAs) {
        return reply.code(409).send({ error: "Input is not ready to confirm" });
      }

      let stored;
      try {
        stored = JSON.parse(queue.understoodAs);
      } catch {
        return reply.code(422).send({ error: "Stored understanding is unreadable" });
      }

      const understood = applyCorrections(stored.understood, body.corrections);
      const contentChanged =
        body.corrections?.contentType &&
        body.corrections.contentType !== stored.understood?.contentType;
      if (body.space) understood.space = body.space;
      else if (!contentChanged) understood.space = stored.suggestedSpace;
      if (!(contentChanged && !body.corrections?.eventType)) {
        understood.eventType = stored.suggestedEventType;
      }

      try {
        const event = await createEventFromUnderstanding(
          request.userId,
          understood,
          body.entityId || null,
          true,
          queue.id,
        );
        return event;
      } catch (error) {
        request.log.error(error);
        const statusCode = error.statusCode || 500;
        return reply.code(statusCode).send({
          error: statusCode === 500 ? "Could not save this understanding" : error.message,
        });
      }
    },
  );

  fastify.post(
    "/intake/dismiss",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const body = request.body || {};
      if (!body.queueId) {
        return reply.code(400).send({ error: "queueId is required" });
      }

      const queue = await prisma.inputQueue.findFirst({
        where: { id: body.queueId, userId: request.userId },
      });
      if (!queue) {
        return reply.code(404).send({ error: "Input not found" });
      }

      await prisma.inputQueue.update({
        where: { id: queue.id },
        data: {
          processingStatus: "dismissed",
          error: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null,
          processedAt: new Date(),
        },
      });

      return { success: true };
    },
  );
}

function safeExtension(filename) {
  const extension = extname(filename).toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) return "";
  return extension;
}
