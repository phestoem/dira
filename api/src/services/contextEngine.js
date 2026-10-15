import { extname } from "path";
import OpenAI from "openai";
import { prisma } from "../prisma.js";
import { getAltimetrixContext } from "./altimetrixBridge.js";
import {
  extractFromCsv,
  extractFromExcel,
  extractFromImage,
  extractFromPdf,
} from "./fileProcessor.js";

const MODEL = "gpt-4o-mini";
const PROMPT_CHAR_LIMIT = 60_000;
const TSH_SIGNIFICANCE = 100_000;

const SPACES = new Set(["personal", "family", "professional", "vision"]);
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
const CONTENT_TYPES = new Set([
  "cost_tracking",
  "budget",
  "inventory",
  "schedule",
  "contact_list",
  "notes",
  "other",
]);

const SYSTEM_PROMPT = `You are the context engine for DIRA — a personal intelligence system. You receive content extracted from a file and must understand what it means in the context of someone's life.

Extract the following and return as JSON:

{
  title: string,           // best title for this content
  contentType: string,     // cost_tracking | budget | inventory | schedule | contact_list | notes | other
  project: string | null,  // project name if identifiable
  location: string | null, // place mentioned
  people: string[],        // names mentioned
  financial: {
    hasFinancials: boolean,
    totalAmount: number | null,
    currency: string | null,  // TSH | EUR | USD | KES etc
    direction: string | null, // expense | income | mixed
    items: [{ description, amount, currency }]
  },
  timeframe: string | null,  // when this relates to
  occurredAt: string | null,
  // The actual date the event occurred,
  // NOT today's date.
  // For a vehicle registration: the registration date
  // For a land purchase: the sale date
  // For a certificate: the issue date
  // For a CV: null (it's a profile, not a dated event)
  // Format: YYYY-MM-DD if found, null if not clear
  summary: string,           // 2-3 sentence plain summary
  confidence: number,        // 0-1 how sure you are
  needsClarification: string | null  // ONE question if needed
}

Rules:
- If the file has a clear title or identifier, use it
- If financial data is in TSH, say TSH
- People are proper nouns that look like names
- occurredAt is the date the event happened, never the date the file was read
- Use YYYY-MM-DD only when the document states that date. If only a month or year is clear, or the document is a profile, return null
- Keep needsClarification null if you understand enough
- Only ask ONE thing if you must ask anything`;

export async function understandFile(filePath, mimeType, userId) {
  const extracted = await extractContent(filePath, mimeType);
  const understood = await understandWithContext(extracted.rawText || "", userId, "financial");
  const matchingEntities = await findMatchingEntities(userId, understood);
  const suggestedSpace = suggestSpace(understood);
  const suggestedEventType = suggestEventType(understood);

  const fullText = typeof extracted.rawText === "string" ? extracted.rawText : "";
  console.log("[intake] understood as:", understood.contentType);
  console.log("[intake] confidence:", understood.confidence);
  console.log("[intake] matched entity:", matchingEntities[0]?.name ?? "none");
  console.log("[intake] full text:", fullText.length, "characters");

  return {
    understood,
    fullText,
    sourceFile: filePath,
    matchingEntities,
    suggestedSpace,
    suggestedEventType,
    duplicate: await duplicateOf(understood, userId),
  };
}

export async function understandText(content, userId) {
  const understood = await understandWithContext(content, userId, "personal");
  const matchingEntities = await findMatchingEntities(userId, understood);
  const suggestedSpace = suggestSpace(understood);
  const suggestedEventType = suggestEventType(understood);

  console.log("[intake] understood as:", understood.contentType);
  console.log("[intake] confidence:", understood.confidence);
  console.log("[intake] matched entity:", matchingEntities[0]?.name ?? "none");

  return {
    understood,
    matchingEntities,
    suggestedSpace,
    suggestedEventType,
    duplicate: await duplicateOf(understood, userId),
  };
}

export async function checkForDuplicate(understood, userId) {
  const title = typeof understood?.title === "string" ? understood.title.trim() : "";
  const titleNeedle = title.split(/\s+/).filter(Boolean).slice(0, 3).join(" ").replace(/[%_]/g, "");
  const amount = numberOrNull(understood?.financial?.totalAmount);
  const location = typeof understood?.location === "string" ? understood.location.trim() : "";
  const or = [];
  if (titleNeedle.length >= 3 && titleNeedle.toLowerCase() !== "untitled") {
    or.push({ title: { contains: titleNeedle, mode: "insensitive" } });
  }
  if (location && amount != null && amount !== 0) {
    const locationForms = [...new Set([location, location.toLowerCase(), location.toUpperCase()])];
    or.push({
      AND: [
        { OR: locationForms.map((form) => ({ places: { string_contains: form } })) },
        { financials: { path: ["amount"], equals: amount } },
      ],
    });
  }
  if (!or.length) return { understood, duplicate: null };

  const similar = await prisma.event.findMany({
    where: {
      userId,
      status: { not: "archived" },
      OR: or,
    },
    select: { id: true, title: true, financials: true, places: true, tags: true },
    orderBy: { createdAt: "desc" },
    take: 3,
  });

  let best = null;
  for (const event of similar) {
    const score = similarityScore(event, understood);
    if (!best || score > best.score) best = { event, score };
  }
  if (!best || best.score < 60) return { understood, duplicate: null };

  const duplicate = {
    existingEventId: best.event.id,
    existingTitle: best.event.title,
    similarityScore: Math.round(best.score),
    message: "This looks similar to an existing event",
  };
  console.log("[intake] duplicate", duplicate.existingEventId, duplicate.similarityScore);
  return { understood, duplicate };
}

async function duplicateOf(understood, userId) {
  try {
    return (await checkForDuplicate(understood, userId)).duplicate;
  } catch (err) {
    console.error("[intake] duplicate check failed:", err.message);
    return null;
  }
}

function similarityScore(existing, incoming) {
  let score = 0;
  const aWords = String(existing?.title || "").toLowerCase().split(/\s+/).filter(Boolean);
  const bWords = String(incoming?.title || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (aWords.length && bWords.length) {
    const shared = aWords.filter((word) => bWords.includes(word));
    score += (shared.length / aWords.length) * 40;
  }

  const existingAmount = numberOrNull(existing?.financials?.amount);
  const incomingAmount = numberOrNull(incoming?.financial?.totalAmount);
  if (existingAmount != null && existingAmount !== 0 && existingAmount === incomingAmount) {
    score += 30;
  }

  const existingLocation = placeName(existing);
  const incomingLocation = typeof incoming?.location === "string" ? incoming.location.trim() : "";
  if (
    existingLocation &&
    incomingLocation &&
    existingLocation.toLowerCase() === incomingLocation.toLowerCase()
  ) {
    score += 20;
  }

  const existingType = contentTypeOf(existing);
  if (existingType && incoming?.contentType && existingType === incoming.contentType) {
    score += 10;
  }

  return score;
}

function placeName(event) {
  const places = Array.isArray(event?.places) ? event.places : [];
  const named = places.find((place) => place && typeof place.name === "string" && place.name.trim());
  return named ? named.name.trim() : "";
}

function contentTypeOf(event) {
  const tags = Array.isArray(event?.tags) ? event.tags : [];
  return tags.find((tag) => CONTENT_TYPES.has(tag)) || null;
}

export async function createEventFromUnderstanding(userId, understoodInput, entityId, confirmed, queueId, document = {}) {
  if (confirmed !== true) {
    throw intakeError("Understanding was not confirmed", 400);
  }

  const understood = normalizeUnderstood(understoodInput);
  const space = SPACES.has(understood.space) ? understood.space : suggestSpace(understood);
  const eventType = EVENT_TYPES.has(understood.eventType)
    ? understood.eventType
    : suggestEventType(understood);

  const queue = queueId ? await loadOwnQueue(userId, queueId) : null;
  const entity = entityId ? await loadOwnEntity(userId, entityId) : null;

  const people = (understood.people || []).map((name) => ({
    name,
    role: "mentioned",
  }));
  const places = [];
  if (entity?.entityType === "place") {
    places.push({ entityId: entity.id, role: "location" });
  } else if (entity) {
    people.push({ entityId: entity.id, role: entity.entityType });
  }
  if (understood.location && entity?.entityType !== "place") {
    places.push({ name: understood.location, role: "mentioned" });
  }

  const financials = buildFinancials(understood.financial);
  const significant = isSignificant(understood.financial, Boolean(entity));
  const occurredAt = parseTimeframe(understood.timeframe);

  const event = await prisma.$transaction(async (tx) => {
    const created = await tx.event.create({
      data: {
        userId,
        title: understood.title,
        rawInput: queue?.rawContent || null,
        understoodMeaning: understood.summary,
        eventType,
        space,
        source: queue?.source === "email" ? "email" : queue?.contentType === "text" ? "manual" : "file",
        rawSourceRef: queue?.filePath || null,
        financials,
        people,
        places,
        tags: [understood.contentType, understood.project].filter((tag) => tag && tag !== "other"),
        attachments: queue?.filePath
          ? [
              {
                type: queue.mimeType || "file",
                path: queue.filePath,
                understoodContent: understood.summary,
              },
            ]
          : [],
        occurredAt: document.occurredAt !== undefined ? document.occurredAt : parseTimeframe(understood.occurredAt) || parseTimeframe(understood.timeframe),
        notes: understood.timeframe || null,
        fullText: textOrNull(document.fullText),
        sourceFile: textOrNull(document.sourceFile) || queue?.filePath || null,
        sentToAltimetrix: false,
        altimetrixEventType: significant ? altimetrixTypeFor(eventType) : null,
      },
    });

    if (queue) {
      const saved = await tx.inputQueue.updateMany({
        where: { id: queue.id, userId, processingStatus: "processing" },
        data: {
          processingStatus: "understood",
          resultEventId: created.id,
          resultEntityId: entity?.id || null,
          processedAt: new Date(),
          error: null,
        },
      });
      if (saved.count !== 1) {
        throw intakeError("Input is not ready to confirm", 409);
      }
    }

    return created;
  });

  if (significant) {
    console.log("[intake] flagged for Altimetrix:", event.id);
  }

  return event;
}

async function extractContent(filePath, mimeType) {
  const kind = fileKind(filePath, mimeType);
  if (kind === "csv") return extractFromCsv(filePath);
  if (kind === "excel") return extractFromExcel(filePath);
  if (kind === "image") return extractFromImage(filePath);
  if (kind === "pdf") return extractFromPdf(filePath);
  throw intakeError("Unsupported file type", 415);
}

async function interpretContent(rawText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const content = clip(rawText);
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ],
  });

  const text = response.choices?.[0]?.message?.content || "";
  const parsed = parseJsonContent(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("The model did not return an understanding");
  }
  return normalizeUnderstood(parsed);
}

async function findMatchingEntities(userId, understood) {
  const needles = uniqueNeedles([
    understood.project,
    understood.location,
    ...(understood.people || []),
  ]);
  if (needles.length === 0) return [];

  return prisma.entity.findMany({
    where: {
      userId,
      OR: needles.map((value) => ({
        name: { contains: value, mode: "insensitive" },
      })),
    },
    orderBy: { updatedAt: "desc" },
    take: 3,
  });
}

function suggestSpace(understood) {
  if (SPACES.has(understood.space)) return understood.space;
  const text = `${understood.title || ""} ${understood.project || ""} ${understood.summary || ""}`.toLowerCase();
  if (/\b(family|wife|husband|child|children|mama|baba|home)\b/.test(text)) return "family";
  if (/\b(vision|someday|dream)\b/.test(text) && !understood.financial?.hasFinancials) return "vision";
  if (
    understood.project ||
    understood.contentType === "cost_tracking" ||
    understood.contentType === "budget" ||
    understood.contentType === "inventory"
  ) {
    return "professional";
  }
  return "personal";
}

function suggestEventType(understood) {
  if (EVENT_TYPES.has(understood.eventType)) return understood.eventType;
  if (
    understood.financial?.hasFinancials ||
    understood.contentType === "cost_tracking" ||
    understood.contentType === "budget"
  ) {
    return "financial";
  }
  if (understood.contentType === "schedule") return "commitment";
  if (understood.contentType === "contact_list") return "social";
  if (understood.contentType === "inventory" || understood.project) return "project_update";
  return "personal";
}

function buildFinancials(financial) {
  if (!financial?.hasFinancials) return {};
  return {
    amount: financial.totalAmount,
    currency: financial.currency,
    direction: financial.direction,
    parties: [],
    transfers: [],
    items: financial.items,
  };
}

function isSignificant(financial, hasKnownEntity) {
  if (hasKnownEntity) return true;
  if (!financial?.hasFinancials) return false;
  if (financial.currency !== "TSH") return false;
  const total = financial.totalAmount ?? sumItems(financial.items, "TSH");
  return typeof total === "number" && total > TSH_SIGNIFICANCE;
}

function sumItems(items, currency) {
  return (items || []).reduce((sum, item) => {
    if (item.currency && item.currency !== currency) return sum;
    const amount = Number(item.amount);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
}

function altimetrixTypeFor(eventType) {
  if (eventType === "financial") return "commitment";
  if (eventType === "project_update" || eventType === "milestone") return "milestone";
  if (eventType === "setback") return "setback";
  return "pattern";
}

function normalizeUnderstood(value) {
  const source = value && typeof value === "object" ? value : {};
  const financial = source.financial && typeof source.financial === "object" ? source.financial : {};
  const contentType = CONTENT_TYPES.has(source.contentType) ? source.contentType : "other";
  const currency = normalizeCurrency(financial.currency);
  const items = Array.isArray(financial.items)
    ? financial.items
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          description: item.description == null ? "" : String(item.description),
          amount: numberOrNull(item.amount),
          currency: normalizeCurrency(item.currency) || currency,
        }))
    : [];

  const clarification =
    typeof source.needsClarification === "string" && source.needsClarification.trim()
      ? source.needsClarification.trim()
      : null;

  return {
    title: textOr(source.title, "Untitled"),
    contentType,
    project: textOrNull(source.project),
    location: textOrNull(source.location),
    people: Array.isArray(source.people)
      ? source.people.map((person) => String(person).trim()).filter(Boolean)
      : [],
    financial: {
      hasFinancials: Boolean(financial.hasFinancials) || items.length > 0,
      totalAmount: numberOrNull(financial.totalAmount),
      currency,
      direction: ["expense", "income", "mixed"].includes(financial.direction) ? financial.direction : null,
      items,
    },
    timeframe: textOrNull(source.timeframe),
    occurredAt: isoDay(source.occurredAt),
    summary: textOr(source.summary, ""),
    confidence: clampConfidence(source.confidence),
    needsClarification: clarification,
    space: textOrNull(source.space),
    eventType: textOrNull(source.eventType),
  };
}

export function applyCorrections(understood, corrections) {
  if (!corrections || typeof corrections !== "object") return normalizeUnderstood(understood);
  const financial =
    corrections.financial && typeof corrections.financial === "object"
      ? { ...(understood.financial || {}), ...corrections.financial }
      : understood.financial;
  return normalizeUnderstood({
    ...understood,
    ...corrections,
    financial,
  });
}

function fileKind(filePath, mimeType) {
  const ext = extname(filePath || "").toLowerCase();
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("csv") || ext === ".csv") return "csv";
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    ext === ".xlsx" ||
    ext === ".xls"
  ) {
    return "excel";
  }
  if (mime.startsWith("image/") || [".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return "image";
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  return "unknown";
}

async function loadOwnQueue(userId, queueId) {
  const queue = await prisma.inputQueue.findFirst({ where: { id: queueId, userId } });
  if (!queue) throw intakeError("Input not found", 404);
  return queue;
}

async function loadOwnEntity(userId, entityId) {
  const entity = await prisma.entity.findFirst({ where: { id: entityId, userId } });
  if (!entity) throw intakeError("Entity not found", 404);
  return entity;
}

function uniqueNeedles(values) {
  const seen = new Set();
  const needles = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const cleaned = value.replace(/[%_]/g, "").trim();
    if (cleaned.length < 2) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    needles.push(cleaned);
    if (needles.length === 8) break;
  }
  return needles;
}

function normalizeCurrency(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const code = value.trim().toUpperCase();
  if (code === "TZS" || code === "TSH") return "TSH";
  return code;
}

function isoDay(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function parseTimeframe(timeframe) {
  if (!timeframe || timeframe.length > 40) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(timeframe) && !/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(timeframe)) {
    return null;
  }
  const date = new Date(timeframe);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clip(text) {
  const source = text || "";
  if (source.length <= PROMPT_CHAR_LIMIT) return source || "(empty file)";
  return `${source.slice(0, PROMPT_CHAR_LIMIT)}\n\n[truncated]`;
}

function parseJsonContent(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : String(text);
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

function textOr(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function textOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampConfidence(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function intakeError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const VISION_PROMPT = `You are analysing a personal journal entry to detect whether it contains a vision, plan, or idea worth capturing separately.

A vision is: future-oriented, describes something the person wants to create, build, achieve, or experience. It may be specific (location, size, cost, requirements) or general (a feeling, a way of life).

A plan is: a vision with some concrete steps, requirements, or constraints already defined.

Return JSON:
{
  isVision: boolean,
  confidence: number (0-1),
  title: string | null,
  summary: string | null,
  tags: string[],
  location: string | null,
  reasoning: string
}

If isVision is false, return isVision: false and null for everything else. Keep reasoning brief.`;

const VISION_CONFIDENCE = 0.65;

function decrypt(rawContent) {
  return typeof rawContent === "string" ? rawContent : "";
}

export async function detectVisionInJournalEntry(entry, userId) {
  const content = decrypt(entry?.rawContent);
  if (!content.trim()) {
    return emptyVisionResult("empty entry");
  }

  const result = await classifyJournalVision(content);
  console.log(
    "[vision-detect] entry:",
    entry.id,
    "isVision:",
    result.isVision,
    "confidence:",
    result.confidence,
    "title:",
    result.title,
  );

  if (!result.isVision || result.confidence < VISION_CONFIDENCE || !result.title) {
    return result;
  }

  const token = result.title
    .split(/\s+/)
    .map((word) => word.replace(/[%_]/g, "").trim())
    .find((word) => word.length >= 3);

  const existing = token
    ? await prisma.vision.findFirst({
        where: {
          userId,
          status: { not: "archived" },
          title: { contains: token, mode: "insensitive" },
        },
      })
    : null;

  if (existing) {
    await prisma.vision.update({
      where: { id: existing.id },
      data: { lastTouchedAt: new Date() },
    });
    console.log("[vision-detect] updated existing vision:", existing.title);
    return result;
  }

  const vision = await prisma.vision.create({
    data: {
      userId,
      title: result.title,
      summary: result.summary,
      status: "seed",
      tags: result.tags,
      space: "personal",
      rawContent: content,
      connectedEntities: result.location ? [{ name: result.location, role: "location" }] : [],
      lastTouchedAt: new Date(),
      nudgeAfter: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  });
  console.log("[vision-detect] created vision:", result.title, "from journal entry:", entry.id);
  setImmediate(() => {
    enrichVision(vision, userId, result.location).catch((err) => {
      console.error("[bridge] vision enrichment failed:", err.message);
    });
  });
  return result;
}

async function understandWithContext(rawText, userId, eventType) {
  const understood = await interpretContent(rawText);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const topics = contextTopics(rawText, understood);
  const entityNames = contextNames(rawText, understood);
  console.log(
    "[intake] altimetrix query:",
    topics.join(", ") || "(none)",
    "|",
    entityNames.join(", ") || "(none)",
  );
  const altimetrixContext = await getAltimetrixContext(
    topics,
    entityNames,
    eventType,
    user,
    contextQuery(rawText, understood),
  );
  if (!user?.altimetrixUserId) {
    console.log("[intake] altimetrix skipped: account not linked");
  } else if (altimetrixContext?.context) {
    console.log("[intake] altimetrix context attached");
  } else {
    console.log("[intake] altimetrix returned no context");
  }
  return applyAltimetrix(understood, altimetrixContext);
}

function applyAltimetrix(understood, altimetrixContext) {
  if (!altimetrixContext?.context) return understood;
  return {
    ...understood,
    altimetrixContext: altimetrixContext.context,
    emotionalSignificance: altimetrixContext.hasSignificantHistory ? "high" : "normal",
  };
}

async function enrichVision(vision, userId, location) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.altimetrixUserId) return;
  const context = await getAltimetrixContext(
    vision.tags || [],
    location ? [location] : [],
    "vision",
    user,
  );
  if (!context?.context) return;
  const current = vision.attributes && typeof vision.attributes === "object" && !Array.isArray(vision.attributes)
    ? vision.attributes
    : {};
  await prisma.vision.update({
    where: { id: vision.id },
    data: {
      attributes: {
        ...current,
        altimetrixContext: context.context,
        altimetrixEnrichedAt: new Date().toISOString(),
      },
    },
  });
  console.log("[bridge] vision enriched from Altimetrix:", vision.title);
}

const NEEDLE_SKIP = new Set([
  "the", "this", "that", "from", "with", "and", "for", "your", "what", "when", "where",
  "have", "been", "they", "them", "their", "some", "more", "also", "just", "like",
  "want", "would", "could", "should", "about", "into", "over", "after", "before",
  "plan", "plans", "planning", "notes", "other", "event", "looks",
]);

function contextQuery(rawText, understood) {
  const bits = [understood?.title, understood?.location, understood?.summary].filter(
    (bit) => typeof bit === "string" && bit.trim(),
  );
  const note = String(rawText || "").replace(/\s+/g, " ").trim().slice(0, 400);
  return [bits.join(". "), note].filter(Boolean).join(" — ").slice(0, 700);
}

function contextTopics(rawText, understood) {
  const people = Array.isArray(understood?.people) ? understood.people : [];
  return uniqueNeedles([
    ...phraseParts(understood?.location),
    ...phraseParts(understood?.project),
    ...people.flatMap((person) => phraseParts(person)),
    ...extractQuickTopics(rawText),
    ...phraseParts(understood?.title),
  ]).slice(0, 8);
}

function contextNames(rawText, understood) {
  const people = Array.isArray(understood?.people) ? understood.people : [];
  return uniqueNeedles([
    ...extractEntityNames(rawText),
    ...people,
    understood?.location,
  ]).slice(0, 8);
}

function phraseParts(value) {
  const text = String(value || "").trim();
  if (text.length < 3) return [];
  const words = text
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 3 && !NEEDLE_SKIP.has(word));
  if (words.length === 0) return [];
  if (words.length === 1) return words;
  return [words.join(" "), ...words];
}

function extractQuickTopics(text) {
  const source = String(text || "");
  const locationWords = source.match(
    /\b(Tanzania|Zanzibar|Mbeya|Dar|Helsinki|Finland|Jambiani|Arusha|Nairobi)\b/gi,
  ) || [];
  const activityWords = source.match(
    /\b(farming|electrical|construction|fence|property|house|land|investment|business|family|health|travel|retirement|project|camp(?:ing)?|tent|visitors?|stays?|guesthouse|lodge|hotel)\b/gi,
  ) || [];
  return [...new Set([
    ...locationWords.map((word) => word.toLowerCase()),
    ...activityWords.map((word) => word.toLowerCase()),
  ])].slice(0, 8);
}

function extractEntityNames(text) {
  const source = String(text || "");
  const phrases = source.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || [];
  const words = source.match(/\b[A-Z][a-z]{2,}\b/g) || [];
  const skip = new Set([
    "The", "This", "That", "From", "With", "And", "For", "Your", "What", "When", "Where",
    "Have", "Been", "They", "Them", "Their", "Some", "More", "Also", "Just", "Like",
    "Want", "Would", "Could", "Should", "About", "Into", "Over", "After", "Before",
    "Planning", "Plan", "Plans",
  ]);
  return [...new Set([...phrases, ...words.filter((word) => !skip.has(word))])].slice(0, 8);
}

async function classifyJournalVision(content) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: VISION_PROMPT },
      { role: "user", content: clip(content) },
    ],
  });

  const text = response.choices?.[0]?.message?.content || "";
  const parsed = parseJsonContent(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("The model did not return a vision classification");
  }
  return normalizeVisionResult(parsed);
}

function normalizeVisionResult(source) {
  const isVision = source.isVision === true;
  if (!isVision) {
    return emptyVisionResult(textOr(source.reasoning, ""));
  }
  const tags = Array.isArray(source.tags)
    ? source.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    isVision: true,
    confidence: clampConfidence(source.confidence),
    title: textOrNull(source.title),
    summary: textOrNull(source.summary),
    tags,
    location: textOrNull(source.location),
    reasoning: textOr(source.reasoning, ""),
  };
}

function emptyVisionResult(reasoning) {
  return {
    isVision: false,
    confidence: 0,
    title: null,
    summary: null,
    tags: [],
    location: null,
    reasoning: reasoning || "",
  };
}
