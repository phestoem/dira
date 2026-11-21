import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import Fastify from "fastify";

// Uploaded originals are only ever deleted by their owner, by hand: no code path removes a file. Dismissing an upload
// changes the queue row's status and keeps both the file and its path.

const SRC = resolve(import.meta.dirname, "../src");
const REMOVES = /\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|truncate|truncateSync)\s*\(|\.(unlink|rm|rmdir)\s*\(/;

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(js|mjs)$/.test(name) ? [path] : [];
  });
}

test("no code in api/src removes files", () => {
  const found = [];
  for (const path of files(SRC)) {
    readFileSync(path, "utf8").split("\n").forEach((line, index) => {
      if (!/^\s*\/\//.test(line) && REMOVES.test(line)) found.push(`${path.slice(SRC.length + 1)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});

test("dismissing a queued upload keeps the file and its path", async (t) => {
  const base = mkdtempSync(resolve(process.cwd(), "../logs/upload-keep-"));
  const saved = process.env.DIRA_UPLOAD_DIR;
  process.env.DIRA_UPLOAD_DIR = `${base}/uploads`;
  const { prisma } = await import("../src/prisma.js");
  const { saveUpload } = await import("../src/services/uploadStore.js");
  const queueRoutes = (await import("../src/routes/queue.js")).default;
  const stamp = Date.now();
  const user = await prisma.user.create({ data: { email: `keep-${stamp}@example.com`, handle: `keep${stamp}`, name: "Ilse Varga" } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
    rmSync(base, { recursive: true, force: true });
    saved === undefined ? delete process.env.DIRA_UPLOAD_DIR : (process.env.DIRA_UPLOAD_DIR = saved);
  });
  const app = Fastify();
  app.decorate("authenticate", async (request) => { request.userId = user.id; });
  await app.register(queueRoutes);
  const filePath = await saveUpload(`deed-${stamp}.pdf`, Buffer.from("%PDF synthetic deed"));
  const queue = await prisma.inputQueue.create({ data: { userId: user.id, rawContent: "deed.pdf", contentType: "file", source: "upload", processingStatus: "pending", filePath } });
  const res = await app.inject({ method: "POST", url: `/queue/${queue.id}/dismiss` });
  assert.equal(res.statusCode, 200);
  const after = await prisma.inputQueue.findUnique({ where: { id: queue.id } });
  assert.equal(after.processingStatus, "dismissed");
  assert.equal(after.filePath, filePath, "the row keeps the file's path");
  assert.ok(existsSync(filePath), "the file is still there");
  assert.equal(readFileSync(filePath, "utf8"), "%PDF synthetic deed");
});
