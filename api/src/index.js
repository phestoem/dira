import "dotenv/config";
import Fastify from "fastify";
import corsPlugin from "./plugins/cors.js";
import authPlugin from "./plugins/auth.js";

const port = Number(process.env.PORT) || 4800;

const app = Fastify({ logger: true });

await app.register(corsPlugin);
await app.register(authPlugin);

app.get("/health", async () => ({
  status: "ok",
  service: "dira-api",
}));

try {
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`DIRA API listening on http://0.0.0.0:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
