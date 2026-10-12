import { randomUUID } from "crypto";
import { extname } from "path";
import { writeFile } from "fs/promises";
import { prisma } from "../prisma.js";
import { isSignificantEvent, sendLifeEvent } from "../services/altimetrixBridge.js";
import { confirmCommand, interpretCommand } from "../services/commandInterpreter.js";
import {
  applyCorrections,
  createEventFromUnderstanding,
  detectVisionInJournalEntry,
  understandFile,
  understandText,
} from "../services/contextEngine.js";
import { routeIntent } from "../services/intentRouter.js";
import { chat } from "../services/lifeAdvisor.js";
import { extractAndLinkEntities } from "./entities.js";

const UPLOAD_DIR = "/tmp/dira-uploads";
const PENDING_TTL_MS = 5 * 60 * 1000;
const pending = new Map();
const EVENT_TYPES = new Set([
  "project_update",
  "financial",
  "personal",
  "family",
  "commitment",
  "milestone",
  "setback",
  "social",
  "health",
]);
const SPACES = new Set(["personal", "family", "professional", "vision"]);
const INVALID_DATE = Symbol("invalid-date");

const INTENT_LABEL = {
  intake_file: "Read the file",
  intake_text: "Save as an event",
  question: "Answer a question",
  command: "Change something",
  journal: "Journal entry",
  correction: "Correct the last thing",
};

export default async function homeRoutes(fastify) {
  fastify.post("/home/input", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const payload = await readPayload(request);
      const message = payload.message.trim();
      if (!message && !payload.file) {
        return reply.code(400).send({ error: "Say something, or attach a file." });
      }
      const routing = await routeIntent(message, request.userId, payload.file);
      console.log("[home]", routing.intent, routing.action, routing.confidence.toFixed(2));
      if (routing.action === "clarify") {
        return await clarifyResponse(request.userId, routing, payload);
      }
      return await executeIntent(request.userId, routing, payload);
    } catch (err) {
      return sendError(reply, err, "DIRA couldn't take that in just now");
    }
  });

  fastify.post("/home/confirm", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const body = request.body || {};
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      const entry = takePending(sessionId, request.userId);
      if (!entry) return reply.code(404).send({ error: "That confirmation expired. Say it again." });
      if (body.confirmed !== true) {
        await cancelPending(entry, request.userId);
        return doneResponse(entry.routing, "dismissed", { message: "Left it as it was." }, null);
      }
      if (entry.kind === "clarify") {
        const intent = typeof body.selectedOption === "string" ? body.selectedOption : "";
        if (!INTENT_LABEL[intent]) return reply.code(400).send({ error: "Choose one of the options." });
        const routing = {
          intent,
          confidence: 0.9,
          interpretation: INTENT_LABEL[intent],
          alternatives: [],
          action: "proceed",
        };
        return await executeIntent(request.userId, routing, entry.payload);
      }
      if (entry.kind === "intake") return await confirmIntake(request, entry, body);
      if (entry.kind === "journal") return await confirmJournal(request.userId, entry);
      if (entry.kind === "command") return await confirmStoredCommand(entry);
      if (entry.kind === "dismiss") return await confirmDismiss(request.userId, entry);
      return reply.code(400).send({ error: "Nothing to confirm." });
    } catch (err) {
      return sendError(reply, err, "Couldn't finish that");
    }
  });
}

async function executeIntent(userId, routing, payload) {
  if (routing.intent === "intake_file") return runIntakeFile(userId, routing, payload);
  if (routing.intent === "intake_text") return runIntakeText(userId, routing, payload);
  if (routing.intent === "question") return runQuestion(userId, routing, payload);
  if (routing.intent === "command") return runCommand(userId, routing, payload);
  if (routing.intent === "journal") return runJournal(userId, routing, payload);
  if (routing.intent === "correction") return runCorrection(userId, routing, payload);
  return clarifyResponse(userId, { ...routing, action: "clarify" }, payload);
}

async function runIntakeFile(userId, routing, payload) {
  const stored = payload.storedFile || (payload.file ? await storeUpload(payload.file) : null);
  if (!stored) {
    return answerResponse(routing, "Attach the file and I'll read it.", false);
  }
  const queue = await prisma.inputQueue.create({
    data: {
      userId,
      rawContent: stored.filename,
      contentType: stored.mimeType.startsWith("image/") ? "image" : "file",
      source: "upload",
      mimeType: stored.mimeType,
      filePath: stored.filePath,
      processingStatus: "processing",
    },
  });
  try {
    const result = await understandFile(stored.filePath, stored.mimeType, userId);
    return intakeResponse(userId, routing, queue.id, result);
  } catch (err) {
    await markQueueFailed(queue.id, err);
    throw err;
  }
}

async function runIntakeText(userId, routing, payload) {
  const content = payload.message.trim();
  if (content.length < 10) {
    return answerResponse(routing, "Say a little more about what happened and I'll save it.", false);
  }
  const queue = await prisma.inputQueue.create({
    data: {
      userId,
      rawContent: content,
      contentType: "text",
      source: "manual",
      processingStatus: "processing",
    },
  });
  try {
    const result = await understandText(content, userId);
    return intakeResponse(userId, routing, queue.id, result);
  } catch (err) {
    await markQueueFailed(queue.id, err);
    throw err;
  }
}

async function intakeResponse(userId, routing, queueId, result) {
  await prisma.inputQueue.update({
    where: { id: queueId },
    data: {
      understoodAs: JSON.stringify({
        understood: result.understood,
        suggestedSpace: result.suggestedSpace,
        suggestedEventType: result.suggestedEventType,
        fullText: typeof result.fullText === "string" && result.fullText.trim() ? result.fullText : null,
        sourceFile: typeof result.sourceFile === "string" && result.sourceFile.trim() ? result.sourceFile : null,
      }),
    },
  });
  const understood = publicUnderstanding(result);
  const sessionId = remember(userId, { kind: "intake", queueId, routing });
  const line = routing.action === "confirm"
    ? "I think you want to save this as an event. Confirm?"
    : intakeLine(understood);
  return {
    sessionId,
    routing: publicRouting(routing),
    action: routing.action,
    result: {
      type: "understanding",
      content: understood,
      confirmationRequired: true,
      confirmationText: line,
    },
    clarificationOptions: null,
  };
}

async function runQuestion(userId, routing, payload) {
  const messages = advisorMessages(payload.history, payload.message);
  const reply = await chat(messages, userId);
  return {
    sessionId: null,
    routing: publicRouting(routing),
    action: routing.action,
    result: {
      type: "answer",
      content: { reply: reply.reply, contextUsed: reply.contextUsed },
      confirmationRequired: false,
      confirmationText: null,
    },
    clarificationOptions: null,
  };
}

async function runCommand(userId, routing, payload) {
  const command = await interpretCommand(payload.message, userId);
  if (command.confirmationRequired && command.commandId && command.preview?.length) {
    const sessionId = remember(userId, {
      kind: "command",
      commandId: command.commandId,
      affectedIds: command.preview.map((item) => item.id),
      routing,
    });
    const type = command.intentType === "correction" ? "correction_preview" : "command_preview";
    return {
      sessionId,
      routing: publicRouting(routing),
      action: routing.action,
      result: {
        type,
        content: command,
        confirmationRequired: true,
        confirmationText: commandConfirmation(command),
      },
      clarificationOptions: null,
    };
  }
  const reply = command.answer || command.needsClarification || "I couldn't see what to change.";
  return answerResponse(routing, reply, false, { results: command.results || [] });
}

async function runJournal(userId, routing, payload) {
  const content = payload.message.trim();
  if (!content) return answerResponse(routing, "Write the reflection and I'll keep it.", false);
  if (routing.action === "confirm") {
    const sessionId = remember(userId, { kind: "journal", content, routing });
    return {
      sessionId,
      routing: publicRouting(routing),
      action: routing.action,
      result: {
        type: "journal_saved",
        content: { pending: true, excerpt: content },
        confirmationRequired: true,
        confirmationText: "This reads like a reflection. Save it to your journal?",
      },
      clarificationOptions: null,
    };
  }
  const entry = await saveJournal(userId, content);
  return {
    sessionId: null,
    routing: publicRouting(routing),
    action: routing.action,
    result: {
      type: "journal_saved",
      content: { id: entry.id, message: "Saved to your journal." },
      confirmationRequired: false,
      confirmationText: null,
    },
    clarificationOptions: null,
  };
}

async function runCorrection(userId, routing, payload) {
  const command = await interpretCommand(payload.message, userId).catch((err) => {
    console.error("[home] correction command failed:", err.message);
    return null;
  });
  if (command?.confirmationRequired && command.commandId && command.preview?.length) {
    const sessionId = remember(userId, {
      kind: "command",
      commandId: command.commandId,
      affectedIds: command.preview.map((item) => item.id),
      routing,
    });
    return {
      sessionId,
      routing: publicRouting(routing),
      action: routing.action,
      result: {
        type: "correction_preview",
        content: command,
        confirmationRequired: true,
        confirmationText: commandConfirmation(command),
      },
      clarificationOptions: null,
    };
  }
  const previous = peekPending(payload.lastAction?.sessionId, userId);
  if (previous?.kind === "intake") {
    const sessionId = remember(userId, {
      kind: "dismiss",
      queueId: previous.queueId,
      routing,
    });
    const title = payload.lastAction?.summary || "that";
    return {
      sessionId,
      routing: publicRouting(routing),
      action: "confirm",
      result: {
        type: "correction_preview",
        content: { preview: [{ id: previous.queueId, title, change: "Don't save" }] },
        confirmationRequired: true,
        confirmationText: `Drop “${title}” without saving?`,
      },
      clarificationOptions: null,
    };
  }
  return answerResponse(routing, "Tell me the old wording and what it should be.", false);
}

async function clarifyResponse(userId, routing, payload) {
  const storedFile = payload.storedFile || (payload.file ? await storeUpload(payload.file) : null);
  const sessionId = remember(userId, {
    kind: "clarify",
    routing,
    payload: {
      message: payload.message,
      history: payload.history,
      lastAction: payload.lastAction,
      storedFile,
    },
  });
  return {
    sessionId,
    routing: publicRouting(routing),
    action: "clarify",
    result: {
      type: "clarification",
      content: null,
      confirmationRequired: false,
      confirmationText: "I want to make sure I understand. Did you mean:",
    },
    clarificationOptions: optionsFrom(routing),
  };
}

async function confirmIntake(request, entry, body) {
  const queue = await prisma.inputQueue.findFirst({
    where: { id: entry.queueId, userId: request.userId },
  });
  if (!queue) {
    const error = new Error("Input not found");
    error.statusCode = 404;
    throw error;
  }
  if (queue.processingStatus === "understood") {
    const error = new Error("That's already saved");
    error.statusCode = 409;
    throw error;
  }
  let stored;
  try {
    stored = JSON.parse(queue.understoodAs || "");
  } catch {
    const error = new Error("Stored understanding is unreadable");
    error.statusCode = 422;
    throw error;
  }
  const understood = applyCorrections(stored.understood, body.corrections);
  const space = SPACES.has(body.space) ? body.space : stored.suggestedSpace;
  if (space) understood.space = space;
  const explicitType = body.corrections?.eventType;
  if (typeof explicitType === "string" && EVENT_TYPES.has(explicitType)) {
    understood.eventType = explicitType;
  } else {
    understood.eventType = stored.suggestedEventType;
  }
  const occurredAt = occurredAtFromConfirm(body, understood);
  if (occurredAt === INVALID_DATE) {
    const error = new Error("occurredAt must be YYYY-MM-DD");
    error.statusCode = 400;
    throw error;
  }
  const userId = request.userId;
  const event = await createEventFromUnderstanding(userId, understood, body.entityId || null, true, queue.id, {
    fullText: typeof stored.fullText === "string" ? stored.fullText : null,
    sourceFile: typeof stored.sourceFile === "string" ? stored.sourceFile : queue.filePath,
    occurredAt,
  });
  setImmediate(async () => {
    try {
      await extractAndLinkEntities(event, userId, understood);
    } catch (err) {
      console.error("[entity-extract] failed:", err.message);
    }
  });
  setImmediate(async () => {
    try {
      if (!isSignificantEvent(event)) return;
      const user = await prisma.user.findUnique({ where: { id: userId } });
      await sendLifeEvent(event, userId, user);
    } catch (err) {
      console.error("[bridge] error:", err.message);
    }
  });
  return doneResponse(entry.routing, "saved", { message: `Saved as ${event.title}.`, eventId: event.id }, null);
}

async function confirmJournal(userId, entry) {
  const saved = await saveJournal(userId, entry.content);
  return doneResponse(entry.routing, "journal_saved", { id: saved.id, message: "Saved to your journal." }, null);
}

async function confirmStoredCommand(entry) {
  const result = await confirmCommand(entry.commandId, true, entry.affectedIds, entry.userId || undefined);
  const lines = result.changes?.length ? result.changes : ["Done."];
  return doneResponse(entry.routing, "saved", { message: lines.join("\n"), changes: result.changes || [] }, null);
}

async function confirmDismiss(userId, entry) {
  await prisma.inputQueue.updateMany({
    where: { id: entry.queueId, userId },
    data: { processingStatus: "dismissed", processedAt: new Date() },
  });
  return doneResponse(entry.routing, "dismissed", { message: "Dropped it." }, null);
}

async function cancelPending(entry, userId) {
  if (entry.kind === "intake" || entry.kind === "dismiss") {
    await prisma.inputQueue.updateMany({
      where: { id: entry.queueId, userId, processingStatus: "processing" },
      data: { processingStatus: "dismissed", processedAt: new Date() },
    });
  }
  if (entry.kind === "command" && entry.commandId) {
    await confirmCommand(entry.commandId, false, [], userId).catch(() => {});
  }
}

async function saveJournal(userId, content) {
  const entry = await prisma.diaryEntry.create({
    data: {
      userId,
      rawContent: content,
      occurredAt: new Date(),
      isPrivate: true,
      sharedWithAltimetrix: false,
    },
  });
  setImmediate(async () => {
    try {
      await detectVisionInJournalEntry(entry, userId);
    } catch (err) {
      console.error("[vision-detect] failed:", err.message);
    }
  });
  return entry;
}

async function readPayload(request) {
  const contentType = String(request.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    let message = "";
    let history = [];
    let lastAction = null;
    let file = null;
    const parts = request.parts();
    for await (const part of parts) {
      if (part.type === "file" || part.file) {
        const buffer = await part.toBuffer();
        file = {
          filename: part.filename || "upload",
          mimeType: part.mimetype || "application/octet-stream",
          buffer,
        };
      } else if (part.fieldname === "message") {
        message = String(part.value || "");
      } else if (part.fieldname === "conversationHistory") {
        history = parseJsonArray(part.value);
      } else if (part.fieldname === "lastAction") {
        lastAction = parseJsonObject(part.value);
      }
    }
    if (file && !file.buffer.length) {
      const error = new Error("File is empty");
      error.statusCode = 400;
      throw error;
    }
    return { message, history, lastAction, file };
  }
  const body = request.body || {};
  return {
    message: typeof body.message === "string" ? body.message : "",
    history: Array.isArray(body.conversationHistory) ? body.conversationHistory : [],
    lastAction: body.lastAction && typeof body.lastAction === "object" ? body.lastAction : null,
    file: null,
  };
}

async function storeUpload(file) {
  const extension = safeExtension(file.filename);
  const filePath = `${UPLOAD_DIR}/${randomUUID()}${extension}`;
  await writeFile(filePath, file.buffer);
  return { filePath, filename: file.filename, mimeType: file.mimeType };
}

function publicUnderstanding(result) {
  return {
    queueId: undefined,
    suggestedSpace: result.suggestedSpace || null,
    understood: {
      title: result.understood.title,
      summary: result.understood.summary,
      contentType: result.understood.contentType,
      project: result.understood.project,
      location: result.understood.location,
      occurredAt: result.understood.occurredAt || null,
      people: result.understood.people,
      financial: result.understood.financial,
      confidence: result.understood.confidence,
    },
    matchingEntities: (result.matchingEntities || []).map((entity) => ({
      id: entity.id,
      name: entity.name,
      entityType: entity.entityType,
    })),
    needsClarification: result.understood.needsClarification,
    duplicate: result.duplicate
      ? {
          existingEventId: result.duplicate.existingEventId,
          existingTitle: result.duplicate.existingTitle,
          similarityScore: result.duplicate.similarityScore,
          message: result.duplicate.message,
        }
      : null,
  };
}

function commandConfirmation(command) {
  const count = command.preview?.length || 0;
  if (command.intentType === "system_fix" && count) {
    return `I found dates in ${count} ${count === 1 ? "event" : "events"} that need updating. Shall I update them all?`;
  }
  if (count) return "Here's what I'd change.";
  return command.answer || command.needsClarification || "Here's what I'd change.";
}

function intakeLine(understood) {
  const title = understood.understood?.title || "this";
  const financial = understood.understood?.financial;
  const money = financial?.hasFinancials && financial.totalAmount != null
    ? `${Number(financial.totalAmount).toLocaleString("en-US")} ${financial.currency || ""}`.trim()
    : "";
  const when = monthPhrase(understood.understood?.occurredAt);
  const detail = [money, when].filter(Boolean).join(" in ");
  return detail
    ? `This looks like ${title} — ${detail}. Save it?`
    : `This looks like ${title}. Save it?`;
}

function monthPhrase(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function optionsFrom(routing) {
  const seeds = [
    { intent: routing.intent, interpretation: routing.interpretation },
    ...(routing.alternatives || []),
  ];
  const seen = new Set();
  const options = [];
  for (const item of seeds) {
    if (!item?.intent || item.intent === "unclear" || seen.has(item.intent) || !INTENT_LABEL[item.intent]) continue;
    seen.add(item.intent);
    options.push({
      label: INTENT_LABEL[item.intent],
      intent: item.intent,
      description: item.interpretation || INTENT_LABEL[item.intent],
    });
  }
  for (const intent of ["intake_text", "question", "journal"]) {
    if (options.length >= 3 || seen.has(intent)) continue;
    seen.add(intent);
    options.push({ label: INTENT_LABEL[intent], intent, description: INTENT_LABEL[intent] });
  }
  return options.slice(0, 3);
}

function answerResponse(routing, reply, confirmationRequired, extra = {}) {
  return {
    sessionId: null,
    routing: publicRouting(routing),
    action: routing.action,
    result: {
      type: "answer",
      content: { reply, ...extra },
      confirmationRequired,
      confirmationText: null,
    },
    clarificationOptions: null,
  };
}

function doneResponse(routing, type, content, confirmationText) {
  return {
    sessionId: null,
    routing: publicRouting(routing || { intent: "unclear", confidence: 1, interpretation: "" }),
    action: "proceed",
    result: {
      type,
      content,
      confirmationRequired: false,
      confirmationText,
    },
    clarificationOptions: null,
  };
}

function publicRouting(routing) {
  return {
    intent: routing?.intent || "unclear",
    confidence: typeof routing?.confidence === "number" ? routing.confidence : 1,
    interpretation: routing?.interpretation || "",
  };
}

function advisorMessages(history, message) {
  const prior = (Array.isArray(history) ? history : [])
    .filter((item) => item && (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .slice(-8)
    .map((item) => ({ role: item.role, content: item.content.slice(0, 2000) }));
  prior.push({ role: "user", content: message });
  return prior;
}

function remember(userId, payload) {
  sweep();
  const sessionId = randomUUID();
  pending.set(sessionId, { userId, expiresAt: Date.now() + PENDING_TTL_MS, ...payload });
  return sessionId;
}

function takePending(sessionId, userId) {
  sweep();
  const entry = pending.get(sessionId);
  if (!entry || entry.userId !== userId) return null;
  pending.delete(sessionId);
  return entry;
}

function peekPending(sessionId, userId) {
  sweep();
  const entry = pending.get(sessionId);
  if (!entry || entry.userId !== userId) return null;
  return entry;
}

function sweep() {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
}

function occurredAtFromConfirm(body, understood) {
  if (Object.prototype.hasOwnProperty.call(body, "occurredAt")) return dateFromIsoDay(body.occurredAt);
  return dateFromIsoDay(understood?.occurredAt);
}

function dateFromIsoDay(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return INVALID_DATE;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return INVALID_DATE;
  return date;
}

async function markQueueFailed(queueId, error) {
  await prisma.inputQueue.update({
    where: { id: queueId },
    data: {
      processingStatus: "failed",
      error: error.message?.slice(0, 500) || "Understanding failed",
      processedAt: new Date(),
    },
  });
}

function safeExtension(filename) {
  const extension = extname(filename || "").toLowerCase();
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) return "";
  return extension;
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "null"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function sendError(reply, err, fallback) {
  const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  if (statusCode === 500) reply.log.error(err);
  return reply.code(statusCode).send({
    error: statusCode === 500 ? fallback : err.message,
  });
}
