import { askCommand, confirmCommand, interpretCommand } from "../services/commandInterpreter.js";

export default async function commandRoutes(fastify) {
  fastify.post("/commands/interpret", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const input = request.body?.input;
    if (typeof input !== "string" || !input.trim()) {
      return reply.code(400).send({ error: "input is required" });
    }
    try {
      return await interpretCommand(input, request.userId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.post("/commands/confirm", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const commandId = request.body?.commandId;
    if (typeof commandId !== "string" || !commandId.trim()) {
      return reply.code(400).send({ error: "commandId is required" });
    }
    const affectedIds = Array.isArray(request.body?.affectedIds)
      ? request.body.affectedIds.filter((id) => typeof id === "string")
      : [];
    try {
      return await confirmCommand(commandId, request.body?.confirmed === true, affectedIds, request.userId);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get("/commands/ask", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const fromQuery = typeof request.query?.input === "string" ? request.query.input : "";
    const fromBody = typeof request.body?.input === "string" ? request.body.input : "";
    const input = fromQuery || fromBody;
    if (!input.trim()) return reply.code(400).send({ error: "input is required" });
    try {
      const answer = await askCommand(input, request.userId);
      return reply.type("text/plain").send(answer);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

function sendError(reply, err) {
  const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
  if (statusCode === 500) reply.log.error(err);
  return reply.code(statusCode).send({
    error: statusCode === 500 ? "Internal server error" : err.message,
  });
}
