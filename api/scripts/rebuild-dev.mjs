// Backs up one dira_dev account's graph to logs/backups/, then force-rebuilds it with the current extractor.
// dira_dev only. Usage, from api/: node scripts/rebuild-dev.mjs <user-id>
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";

if (!/\/dira_dev(\?|$)/.test(process.env.DATABASE_URL || "")) throw new Error("not dira_dev");
const { prisma } = await import("../src/prisma.js");
const { rebuildGraph } = await import("../src/services/graph/rebuild.js");
const userId = process.argv[2];
if (!userId) throw new Error("usage: node scripts/rebuild-dev.mjs <user-id>");
const backups = new URL("../../logs/backups/", import.meta.url);
mkdirSync(backups, { recursive: true });

const entities = await prisma.entity.findMany({ where: { userId } });
const relationships = await prisma.relationship.findMany({ where: { userId } });
const user = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
const file = new URL(`dira-dev-graph-${new Date().toISOString().replace(/[:.]/g, "")}.json`, backups);
writeFileSync(file, JSON.stringify({ entities, relationships, settings: user.settings }, null, 1));
console.log("backup", file.pathname, entities.length, "entities", relationships.length, "edges");

const started = Date.now();
const report = await rebuildGraph(userId, { force: true });
console.log("rebuild report", JSON.stringify({ counts: report.counts, edges: report.edges, skipped: report.skipped, conflicts: report.conflicts?.length, reviewQuestions: report.reviewQuestions }));
const [e, r] = await Promise.all([prisma.entity.count({ where: { userId, status: { not: "archived" } } }), prisma.relationship.count({ where: { userId } })]);
console.log(`rebuild done in ${Math.round((Date.now() - started) / 1000)}s: ${e} live entities, ${r} edges`);
await prisma.$disconnect();
process.exit(0);
