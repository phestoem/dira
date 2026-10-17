// The one ingestion path: ingest(userId, text, { source, ref, history }). Chat is routed (question / statement /
// mixed); every other source is a statement. A statement is always saved as an event and then extracted into claims,
// one source at a time per user so that a correction lands after what it corrects.
import { prisma } from "../../prisma.js";
import { isReadonly } from "../../readonly.js";
import { classify } from "./router.js";
import { writeClaims } from "./store.js";

export const SOURCES = ["chat", "email", "journal", "file", "queue", "chip", "relationship"];

// The extractor is plugged in by phase 2: async (text, { userId, source, asOf }) → { claims, extractor, model }.
let extractor = null;
export function setExtractor(fn) {
  extractor = fn;
}

const queues = new Map();
function enqueue(userId, job) {
  const next = (queues.get(userId) || Promise.resolve()).then(job).catch((err) => console.error("[knowledge] extract failed:", err.message));
  queues.set(userId, next);
  next.finally(() => { if (queues.get(userId) === next) queues.delete(userId); });
  return next;
}

// Resolves when every queued extraction for the user has finished (tests and the golden harness wait on it).
export function settled(userId) {
  return queues.get(userId) || Promise.resolve();
}

function titleOf(text) {
  const line = String(text).split("\n").map((part) => part.trim()).find(Boolean) || "Note";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

export async function ingest(userId, text, { source = "chat", ref = null, history = [], asOf = null } = {}) {
  const body = String(text || "").trim();
  if (!body) return { kind: "empty", stored: false };
  if (!SOURCES.includes(source)) throw new Error(`unknown source ${source}`);
  const route = source === "chat" ? await classify(body, history) : { kind: "statement", question: "" };
  if (route.kind === "question" || isReadonly()) return { ...route, stored: false };
  const event = await prisma.event.create({
    data: { userId, title: titleOf(body), rawInput: body, fullText: body, eventType: "note", source, rawSourceRef: ref, occurredAt: new Date() },
  });
  const done = enqueue(userId, () => extractEvent(userId, event, { source, asOf }));
  return { ...route, stored: true, eventId: event.id, extraction: done };
}

export async function extractEvent(userId, event, { source, asOf } = {}) {
  if (!extractor) return { written: [], skipped: [] };
  const result = await extractor(event.fullText || event.rawInput || "", { userId, source, asOf, eventId: event.id });
  const stored = await writeClaims(userId, result.claims || [], { eventId: event.id, source, sourceRef: event.rawSourceRef, extractor: result.extractor, model: result.model });
  await prisma.event.update({ where: { id: event.id }, data: { graphExtractedAt: new Date() } });
  return stored;
}
