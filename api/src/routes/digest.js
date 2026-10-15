import { generateDigest, sendDigestEmail } from "../services/digestService.js";

export default async function digestRoutes(fastify) {
  fastify.get("/digest/preview", { preHandler: [fastify.authenticate] }, async (request) => {
    const digest = await generateDigest(request.userId);
    delete digest.mentions;
    return digest;
  });

  fastify.post("/digest/send", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      return await sendDigestEmail(request.userId);
    } catch (err) {
      const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 502;
      return reply.code(statusCode).send({ error: err.message || "Could not send the digest" });
    }
  });
}
