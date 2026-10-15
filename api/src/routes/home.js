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
import { extractConversationalFacts, previousExchangeFrom, routeIntent } from "../services/intentRouter.js";
import { chat } from "../services/lifeAdvisor.js";
import { extractAndLinkEntities } from "./entities.js";
import { describeRelationshipLine, parseFamilyStatement } from "../services/graph/familyStatement.js";
import { isPeopleQuestion } from "../services/graph/peopleGrounding.js";
import { commitTriples, extractTriples, scheduleExtraction } from "../services/graph/relationshipExtractor.js";
import { getOrCreateSelf } from "../services/graph/entityResolver.js";
import { findPaths, getFamilyTree, getMoneyFlows, getNeighbors, serializeForPrompt, getSubgraph } from "../services/graph/graphQuery.js";
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
  relationship_add: "Save a connection",
  relationship_change: "Update a connection",
  graph_query: "Answer from the graph",
};

export default async function homeRoutes(fastify) {
  fastify.post("/home/input", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const payload = await readPayload(request);
      const message = payload.message.trim();
      if (!message && !payload.file) {
        return reply.code(400).send({ error: "Say something, or attach a file." });
      }
      const routing = await routeIntent(message, request.userId, payload.file, payload.history, payload.lastAction);
      console.log("[home]", routing.intent, routing.action, routing.confidence.toFixed(2), routing.followUp?.action || "none");
      if (message && !payload.file && routing.followUp?.action === "decline") {
        return answerResponse(
          { intent: "question", confidence: 0.95, interpretation: "Leave that unsaved.", action: "proceed" },
          "Okay. I won't save that.",
          false,
        );
      }
      if (message && !payload.file && routing.followUp?.action === "accept" && routing.followUp.fact) {
        return await saveOfferedFact(request.userId, routing.followUp.fact);
      }
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
      if (entry.kind === "relationships") return await confirmRelationships(request.userId, entry, body);
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
  if (routing.intent === "relationship_add") return runRelationshipAdd(userId, routing, payload);
  if (routing.intent === "relationship_change") return runRelationshipChange(userId, routing, payload);
  if (routing.intent === "graph_query") return runGraphQuery(userId, routing, payload);
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

async function saveOfferedFact(userId, content) {
  const queue = await prisma.inputQueue.create({
    data: {
      userId,
      rawContent: content,
      contentType: "text",
      source: "manual",
      processingStatus: "processing",
    },
  });
  let result;
  try {
    result = await understandText(content, userId);
  } catch (err) {
    await markQueueFailed(queue.id, err);
    throw err;
  }
  if (result.duplicate?.existingTitle) {
    await prisma.inputQueue.update({
      where: { id: queue.id },
      data: { processingStatus: "dismissed", processedAt: new Date(), error: null },
    });
    return answerResponse(
      { intent: "question", confidence: 0.95, interpretation: "Already saved.", action: "proceed" },
      `That's already saved as ${result.duplicate.existingTitle}.`,
      false,
    );
  }
  await prisma.inputQueue.update({
    where: { id: queue.id },
    data: {
      understoodAs: JSON.stringify({
        understood: result.understood,
        suggestedSpace: result.suggestedSpace,
        suggestedEventType: result.suggestedEventType,
        fullText: content,
        sourceFile: null,
      }),
    },
  });
  const understood = applyCorrections(result.understood, null);
  understood.space = SPACES.has(result.suggestedSpace) ? result.suggestedSpace : "personal";
  if (EVENT_TYPES.has(result.suggestedEventType)) understood.eventType = result.suggestedEventType;
  const occurredAt = dateFromIsoDay(understood.occurredAt);
  const event = await createEventFromUnderstanding(userId, understood, null, true, queue.id, {
    fullText: content,
    sourceFile: null,
    ...(occurredAt && occurredAt !== INVALID_DATE ? { occurredAt } : {}),
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
  return doneResponse(
    { intent: "intake_text", confidence: 0.95, interpretation: `Saved ${event.title}.`, action: "proceed" },
    "saved",
    { message: `Saved as ${event.title}.`, eventId: event.id, queueId: queue.id },
    null,
  );
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
      content: { ...understood, queueId },
      confirmationRequired: true,
      confirmationText: line,
    },
    clarificationOptions: null,
  };
}

async function runQuestion(userId, routing, payload) {
  const messages = advisorMessages(payload.history, payload.message);
  const factsPromise = extractConversationalFacts(payload.message).catch((err) => {
    console.error("[home] fact extract failed:", err.message);
    return [];
  });
  if (looksRelational(payload.message) && !isPeopleQuestion(payload.message)) {
    scheduleExtraction(userId, payload.message, { source: "conversation", forceStatus: "suggested", title: "conversation" });
  }
  const [reply, facts] = await Promise.all([chat(messages, userId), factsPromise]);
  return {
    sessionId: null,
    routing: publicRouting(routing),
    action: routing.action,
    result: {
      type: "answer",
      content: { reply: reply.reply, contextUsed: reply.contextUsed },
      extractedFacts: facts,
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
  const prior = previousExchangeFrom(payload.history);
  console.log("[home] correction about:", prior.about || "(none)");
  if (previousWasQuestion(payload.lastAction, prior)) {
    const message = prior.about
      ? `About the previous reply (${prior.about}): ${payload.message}`
      : payload.message;
    return runQuestion(userId, routing, { ...payload, message });
  }
  if (openIntake(payload.lastAction, prior) && prior.priorUser && !isBareDismissal(payload.message)) {
    const revised = [
      prior.priorUser,
      prior.about ? `The previous reading was: ${prior.about}.` : "",
      `Correction: ${payload.message}`,
    ].filter(Boolean).join("\n\n");
    return runIntakeText(userId, { ...routing, intent: "intake_text" }, { ...payload, message: revised });
  }
  const previous = peekPending(payload.lastAction?.sessionId, userId);
  if (previous?.kind === "intake" && isBareDismissal(payload.message)) {
    const sessionId = remember(userId, {
      kind: "dismiss",
      queueId: previous.queueId,
      routing,
    });
    const title = payload.lastAction?.summary || prior.about || "that";
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
  const contextualMessage = prior.about
    ? `Regarding "${prior.about}": ${payload.message}`
    : payload.message;
  const command = await interpretCommand(contextualMessage, userId).catch((err) => {
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
  if (command?.answer || command?.needsClarification) {
    return answerResponse(routing, command.answer || command.needsClarification, false, { results: command.results || [] });
  }
  if (prior.lastResponse) {
    const message = prior.about
      ? `About the previous reply (${prior.about}): ${payload.message}`
      : payload.message;
    return runQuestion(userId, routing, { ...payload, message });
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
  return doneResponse(entry.routing, "saved", { message: `Saved as ${event.title}.`, eventId: event.id, queueId: queue.id }, null);
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
  scheduleExtraction(userId, content, { source: "journal", forceStatus: "suggested", diaryEntryId: entry.id });
  return entry;
}

async function runRelationshipAdd(userId, routing, payload) {
  const self = await getOrCreateSelf(userId);
  const parsed = parseFamilyStatement(payload.message);
  let triples = parsed.triples;
  let entityFacts = parsed.entityFacts;
  if (!triples.length) {
    try {
      const extracted = await extractTriples(payload.message, {
        selfName: self.name,
        today: new Date().toISOString().slice(0, 10),
      });
      triples = extracted.triples;
      entityFacts = extracted.entityFacts;
    } catch (err) {
      console.error("[graph] relationship extract failed:", err.message);
      return answerResponse(routing, err.status === 429 ? "DIRA is busy right now. Send that again." : "I couldn't read that connection just now.", false);
    }
  }
  const committed = await commitTriples(userId, triples, {
    source: "conversation",
    forceStatus: "suggested",
    entityFacts,
    message: payload.message,
  });
  const edges = await recentSuggested(userId, committed.created + committed.updated);
  return relationshipCard(userId, routing, edges, "add");
}

async function runRelationshipChange(userId, routing, payload) {
  const self = await getOrCreateSelf(userId);
  let extracted;
  try {
    extracted = await extractTriples(payload.message, { selfName: self.name, today: new Date().toISOString().slice(0, 10) });
  } catch (err) {
    console.error("[graph] relationship extract failed:", err.message);
    return answerResponse(routing, err.status === 429 ? "DIRA is busy right now. Send that again." : "I couldn't read that connection just now.", false);
  }
  const proposals = [];
  for (const triple of extracted.triples) {
    const saved = await commitTriples(userId, [triple], { source: "conversation", forceStatus: "suggested" });
    void saved;
  }
  const edges = await prisma.relationship.findMany({
    where: { userId, status: "confirmed", validTo: null },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  const today = new Date().toISOString().slice(0, 10);
  for (const edge of edges) {
    if (!messageMentions(payload.message, edge)) continue;
    proposals.push({ ...edge, proposedValidTo: today });
  }
  if (!proposals.length) {
    return answerResponse(routing, "I couldn't find a confirmed connection to end. It may still be a suggestion in Review.", false);
  }
  const sessionId = remember(userId, { kind: "relationships", mode: "change", edgeIds: proposals.map((edge) => edge.id), validTo: today, routing });
  return {
    sessionId,
    routing: publicRouting(routing),
    action: "confirm",
    result: {
      type: "relationship_preview",
      content: { edges: await labelEdges(userId, proposals), mode: "change" },
      confirmationRequired: true,
      confirmationText: "End these connections? They stay in the history.",
    },
    clarificationOptions: null,
  };
}

async function runGraphQuery(userId, routing, payload) {
  const text = payload.message;
  if (isPeopleQuestion(text)) {
    const reply = await chat(advisorMessages(payload.history, text), userId);
    return answerResponse(routing, reply.reply, false);
  }
  const self = await getOrCreateSelf(userId);
  let data = "";
  if (/\bfamily tree|familia|ndugu|parents|siblings|children\b/i.test(text)) {
    const tree = await getFamilyTree(userId);
    data = JSON.stringify(tree);
  } else if (/\bmoney|sent|paid|funded\b/i.test(text)) {
    data = JSON.stringify(await getMoneyFlows(userId, {}));
  } else if (/\bhow am i connected|how are we connected|path\b/i.test(text)) {
    const names = text.match(/\b[A-Z][\p{L}'-]{2,}\b/gu) || [];
    const target = names.length
      ? await prisma.entity.findFirst({ where: { userId, name: { equals: names[0], mode: "insensitive" }, status: { not: "archived" } } })
      : null;
    data = target
      ? JSON.stringify(await findPaths(userId, { kind: "entity", id: self.id }, { kind: "entity", id: target.id }))
      : "No matching person.";
  } else {
    const names = text.match(/\b[A-Z][\p{L}'-]{2,}\b/gu) || [];
    const target = names.length
      ? await prisma.entity.findFirst({ where: { userId, name: { contains: names[0], mode: "insensitive" }, status: { not: "archived" } } })
      : self;
    const neighbors = await getNeighbors(userId, "entity", (target || self).id, {});
    const subgraph = await getSubgraph(userId, [{ kind: "entity", id: (target || self).id }], { depth: 2 });
    data = [serializeForPrompt(subgraph).join("\n"), ...neighbors.map((row) => `${row.displayType} ${row.node.name}`)].join("\n");
  }
  const messages = advisorMessages(payload.history, `${text}\n\nGRAPH DATA:\n${data || "No confirmed connections."}`);
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

async function confirmRelationships(userId, entry, body) {
  const selected = Array.isArray(body.selectedEdgeIds) && body.selectedEdgeIds.length
    ? body.selectedEdgeIds
    : entry.edgeIds;
  const chosen = new Set(selected);
  for (const id of entry.edgeIds || []) {
    if (entry.mode === "change") {
      if (!chosen.has(id)) continue;
      await prisma.relationship.updateMany({
        where: { id, userId, status: "confirmed" },
        data: { validTo: entry.validTo ? new Date(entry.validTo) : new Date() },
      });
      continue;
    }
    await prisma.relationship.updateMany({
      where: { id, userId },
      data: chosen.has(id) ? { status: "confirmed", source: "user" } : { status: "rejected" },
    });
  }
  return doneResponse(entry.routing, "saved", { message: entry.mode === "change" ? "Updated the history." : "Connections saved." }, null);
}

async function relationshipCard(userId, routing, edges, mode) {
  if (!edges.length) {
    return answerResponse(routing, "I didn't find a connection to save in that.", false);
  }
  const sessionId = remember(userId, { kind: "relationships", mode, edgeIds: edges.map((edge) => edge.id), routing });
  return {
    sessionId,
    routing: publicRouting(routing),
    action: "confirm",
    result: {
      type: "relationship_preview",
      content: { edges: await labelEdges(userId, edges), mode },
      confirmationRequired: true,
      confirmationText: "Save these connections?",
    },
    clarificationOptions: null,
  };
}

async function recentSuggested(userId, count) {
  return prisma.relationship.findMany({
    where: { userId, status: "suggested", label: { not: "conflict" } },
    orderBy: { createdAt: "desc" },
    take: Math.max(count, 1),
  });
}

async function labelEdges(userId, edges) {
  const ids = [...new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]))];
  const entities = ids.length ? await prisma.entity.findMany({ where: { userId, id: { in: ids } } }) : [];
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const self = entities.find((entity) => entity.isSelf) || await prisma.entity.findFirst({ where: { userId, isSelf: true } });
  const ordered = edges.slice().sort((left, right) => edgeOrder(left, self?.id) - edgeOrder(right, self?.id) || String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
  return ordered.map((edge) => ({
    id: edge.id,
    line: describeRelationshipLine({
      type: edge.type,
      from: byId.get(edge.fromId) || { id: edge.fromId, name: "Someone" },
      to: byId.get(edge.toId) || { id: edge.toId, name: "someone" },
      selfId: self?.id,
      attributes: edge.attributes,
    }),
    category: edge.category,
  }));
}

function edgeOrder(edge, selfId) {
  if (edge.type === "parent_of" && edge.toId === selfId) return 0;
  if (edge.type === "lives_at") return 1;
  if (edge.type === "sibling_of") return 2;
  if (edge.type === "spouse_of") return 3;
  if (edge.type === "parent_of" && edge.fromId === selfId) return 4;
  return 5;
}

function looksRelational(text) {
  return /\b(mother|father|sister|brother|wife|husband|son|daughter|mama|baba|dada|mke|mume|mtoto|supervises|owns|caretaker|fundi|sibling|spouse)\b/i.test(String(text || ""));
}

function messageMentions(text, edge) {
  const blob = String(text || "").toLowerCase();
  const ending = /\b(no longer|sold|ended|moved|not my|amehama|si tena)\b/i.test(blob);
  if (!ending) return false;
  const phrase = String(edge.type || "").replace(/_/g, " ");
  return blob.includes(phrase) || blob.includes(phrase.split(" ")[0]);
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
    altimetrixContext: result.understood.altimetrixContext || null,
    emotionalSignificance: result.understood.emotionalSignificance || null,
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
      needsClarification: result.understood.needsClarification || null,
      altimetrixContext: result.understood.altimetrixContext || null,
      emotionalSignificance: result.understood.emotionalSignificance || null,
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

function previousWasQuestion(lastAction, prior) {
  if (lastAction?.intent === "question") return true;
  if (lastAction?.intent === "correction" && prior.lastResponse && !/title:|save it\?|confirm\?|shall i /i.test(prior.lastResponse)) {
    return true;
  }
  if (lastAction?.intent) return false;
  if (!prior.lastResponse) return false;
  return !/title:|save it\?|confirm\?/i.test(prior.lastResponse);
}

function openIntake(lastAction, prior) {
  if (lastAction?.saved) return false;
  if (lastAction?.intent === "intake_text" || lastAction?.intent === "intake_file") return true;
  if (lastAction?.intent) return false;
  return /title:/i.test(prior.lastResponse || "") && /save it\?/i.test(prior.lastResponse || "");
}

function isBareDismissal(message) {
  return /^(no|nope|not that|that'?s wrong|wrong|never mind|cancel)\.?$/i.test(String(message || "").trim());
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
