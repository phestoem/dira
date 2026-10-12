import { extname } from "path";
import OpenAI from "openai";
import { prisma } from "../prisma.js";
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
  summary: string,           // 2-3 sentence plain summary
  confidence: number,        // 0-1 how sure you are
  needsClarification: string | null  // ONE question if needed
}

Rules:
- If the file has a clear title or identifier, use it
- If financial data is in TSH, say TSH
- People are proper nouns that look like names
- Keep needsClarification null if you understand enough
- Only ask ONE thing if you must ask anything`;

export async function understandFile(filePath, mimeType, userId) {
  const extracted = await extractContent(filePath, mimeType);
  const understood = await interpretContent(extracted.rawText || "");
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
  };
}

export async function createEventFromUnderstanding(userId, understoodInput, entityId, confirmed, queueId) {
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
        source: "file",
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
        occurredAt,
        notes: understood.timeframe || null,
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
          understoodAs: understood.contentType,
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
