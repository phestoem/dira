import "dotenv/config";
import { finishRequest, startRequest, tokenTotals } from "./metrics.js";
import { mkdirSync } from "fs";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import cron from "node-cron";
import corsPlugin from "./plugins/cors.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import intakeRoutes from "./routes/intake.js";
import eventRoutes from "./routes/events.js";
import journalRoutes from "./routes/journal.js";
import visionRoutes from "./routes/visions.js";
import entityRoutes from "./routes/entities.js";
import statsRoutes from "./routes/stats.js";
import userRoutes from "./routes/users.js";
import commandRoutes from "./routes/commands.js";
import advisorRoutes from "./routes/advisor.js";
import homeRoutes from "./routes/home.js";
import emailRoutes from "./routes/email.js";
import queueRoutes from "./routes/queue.js";
import digestRoutes from "./routes/digest.js";
import graphRoutes from "./routes/graph.js";
import { bridgeConfig } from "./services/altimetrixBridge.js";
import { graphAutoExtractEnabled } from "./services/graph/autoExtract.js";
import { runScheduledDigests } from "./services/digestService.js";
import { catchUpGraphExtractions } from "./services/graph/rebuild.js";
import { flagStatus } from "./services/flags.js";
import { modelStatus } from "./services/modelStatus.js";
import { ensureUploadDir } from "./services/uploadStore.js";
import { prisma } from "./prisma.js";

// Fails at start when the folder is unusable, instead of losing an upload later.
console.log("[uploads]", ensureUploadDir());

const port = Number(process.env.PORT) || 4800;

const app = Fastify({ logger: true });
// Token and latency logging per request (src/metrics.js).
app.addHook("onRequest", (request, reply, done) => startRequest(request, done));
app.addHook("onResponse", async (request, reply) => finishRequest(request, reply));

await app.register(corsPlugin);
await app.register(authPlugin);
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024 },
});
await app.register(authRoutes);
await app.register(intakeRoutes);
await app.register(eventRoutes);
await app.register(journalRoutes);
await app.register(visionRoutes);
await app.register(entityRoutes);
await app.register(statsRoutes);
await app.register(userRoutes);
await app.register(commandRoutes);
await app.register(advisorRoutes);
await app.register(homeRoutes);
await app.register(emailRoutes);
await app.register(queueRoutes);
await app.register(digestRoutes);
await app.register(graphRoutes);

if (process.env.DIRA_DISABLE_CRON === "true") {
  console.log("[cron] disabled by DIRA_DISABLE_CRON: no digest, no graph catch-up");
} else {
  cron.schedule("0 * * * *", () => {
    console.log("[digest] running daily digest...");
    runScheduledDigests().catch((err) => {
      console.error("[digest] run failed:", err.message);
    });
    catchUpGraphExtractions().catch((err) => {
      console.error("[graph-rebuild] catch-up failed:", err.message);
    });
  }, { timezone: "Europe/Helsinki" });
}
console.log(`[flags] ${Object.entries(flagStatus()).map(([name, value]) => `${name}=${value}`).join(" ")}`);
console.log(bridgeConfig() ? "[bridge] configured" : "[bridge] skipping: off or not configured");
console.log(`[graph] auto-extract for users without a setting: ${graphAutoExtractEnabled({}) ? "on" : "off"} (GRAPH_AUTO_EXTRACT)`);

app.get("/health", async () => ({
  status: "ok",
  service: "dira-api",
  // The golden runner refuses a live run against a server that doesn't list this.
  capabilities: ["readonly-header"],
  // Last success and failure per model provider (no secrets), so a dead key or empty credit shows here first.
  models: modelStatus(),
  flags: flagStatus(),
  // Model calls and tokens today and yesterday, since this process started (no content).
  tokens: tokenTotals(),
}));

app.setErrorHandler((error, request, reply) => {
  if (error.code === "FST_REQ_FILE_TOO_LARGE") {
    return reply.code(413).send({ error: "File is too large" });
  }
  request.log.error(error);
  const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  return reply.code(statusCode).send({
    error: statusCode === 500 ? "Internal server error" : error.message,
  });
});

try {
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`DIRA API listening on http://0.0.0.0:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// On stop, finish open requests and close the database pool, so no connection outlives the process.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${signal}: shutting down`);
    const timer = setTimeout(() => process.exit(1), 10000);
    try {
      await app.close();
      await prisma.$disconnect();
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  });
}
