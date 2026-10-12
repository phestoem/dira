import { chat, detectSignificantFacts, suggest } from "../services/lifeAdvisor.js";

export default async function advisorRoutes(fastify) {
  fastify.post("/advisor/chat", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const messages = request.body?.messages;
      const [replyResult, detectedFacts] = await Promise.all([
        chat(messages, request.userId),
        detectSignificantFacts(lastUserMessage(messages), request.userId).catch((err) => {
          request.log.error({ err }, "[advisor] fact detection failed");
          return [];
        }),
      ]);
      return { ...replyResult, detectedFacts };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get("/advisor/suggest", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const suggestions = await suggest(request.userId);
      return { suggestions };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") return message.content;
  }
  return "";
}

function sendError(reply, err) {
  const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : err.statusCode === 503 || err.statusCode === 502 ? err.statusCode : 500;
  if (statusCode === 500) reply.log.error(err);
  return reply.code(statusCode).send({
    error: statusCode === 500 ? "Internal server error" : err.message,
  });
}
