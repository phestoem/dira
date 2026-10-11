import jwt from "@fastify/jwt";
import fp from "fastify-plugin";

async function authPlugin(fastify) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }
  await fastify.register(jwt, { secret });

  fastify.decorate("authenticate", async function authenticate(request, reply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const payload = request.user;
    if (payload?.type !== "access" || !payload?.userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    request.userId = payload.userId;
  });
}

export default fp(authPlugin, {
  name: "dira-auth",
});
