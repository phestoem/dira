import cors from "@fastify/cors";
import fp from "fastify-plugin";

/**
 * Must use fastify-plugin so CORS hooks apply to all routes (sibling route plugins
 * do not inherit a bare register() context).
 */
export default fp(
  async function corsPlugin(fastify) {
    await fastify.register(cors, {
      origin: true,
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    });
  },
  { name: "dira-cors" },
);
