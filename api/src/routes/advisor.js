import { chat, suggest } from "../services/lifeAdvisor.js";

export default async function advisorRoutes(fastify) {
  fastify.post("/advisor/chat", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      return await chat(request.body?.messages, request.userId);
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

function sendError(reply, err) {
  const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : err.statusCode === 503 || err.statusCode === 502 ? err.statusCode : 500;
  if (statusCode === 500) reply.log.error(err);
  return reply.code(statusCode).send({
    error: statusCode === 500 ? "Internal server error" : err.message,
  });
}
