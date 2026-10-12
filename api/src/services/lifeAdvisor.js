import { prisma } from "../prisma.js";

const MODEL = "qwen/qwen3.8-27b";
const DAY_MS = 24 * 60 * 60 * 1000;

const ADVISOR_ROLE = `You are DIRA's life advisor — an intelligent assistant
that knows this person's life operations deeply.

You have access to their:
- Recent events and activities
- Active visions and plans
- Journal entries (treated with discretion)
- Key people, places, and projects
- Financial activity

Your role:
- Answer questions about their life and data precisely
- Help them think through decisions and plans
- Surface connections they might not see
- Be direct and specific — you have real data, use it
- Recommend concrete next steps when asked
- Never make up data — only reference what you can see

Your responses:
- Match the format to the question
  (one line for simple facts, paragraphs for analysis,
   lists for options or action items)
- Be conversational but substantive
- Reference specific data points naturally
  ('your Ntabha land purchase in July',
   'the 2.4M TSH electrical project')
- Connect dots across different areas when relevant`;

export async function chat(messages, userId) {
  const history = normalizeMessages(messages);
  const context = await loadContext(userId);
  const system = buildSystemPrompt(context);
  const reply = await completeChat(history, system);
  console.log(
    "[advisor] chat",
    context.events.length,
    "events",
    context.visions.length,
    "visions",
    context.entities.length,
    "entities",
  );
  return {
    reply,
    contextUsed: {
      eventsCount: context.events.length,
      visionsCount: context.visions.length,
      entitiesCount: context.entities.length,
    },
  };
}

export async function suggest(userId) {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [events, visions] = await Promise.all([
    prisma.event.findMany({
      where: { userId, status: { not: "archived" }, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { title: true, places: true },
    }),
    prisma.vision.findMany({
      where: { userId, status: { in: ["seed", "forming", "active"] } },
      orderBy: { lastTouchedAt: "desc" },
      take: 3,
      select: { title: true, tags: true, connectedEntities: true },
    }),
  ]);

  const focus = visions[0]?.title || events[0]?.title || null;
  const place = firstLocation(events) || firstVisionLocation(visions);
  const pool = [
    "What should I focus on this week?",
    focus ? `Help me plan the next phase of ${focus}` : "Help me plan the next phase of what I'm building",
    place ? `How am I tracking against my ${place} timeline?` : "How am I tracking against my plans?",
    events[0] ? `What does ${events[0].title} change for the rest of this month?` : "What changed for me this month?",
    visions[1] ? `How does ${visions[1].title} connect to what I'm doing now?` : "What connections am I missing?",
  ];
  const unique = [...new Set(pool)];
  const start = dayIndex(unique.length);
  return [0, 1, 2].map((offset) => unique[(start + offset) % unique.length]);
}

async function loadContext(userId) {
  const now = Date.now();
  const [events, visions, journal, entities, user] = await Promise.all([
    prisma.event.findMany({
      where: {
        userId,
        status: { not: "archived" },
        createdAt: { gte: new Date(now - 30 * DAY_MS) },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        title: true,
        space: true,
        occurredAt: true,
        createdAt: true,
        financials: true,
        places: true,
      },
    }),
    prisma.vision.findMany({
      where: { userId, status: { in: ["seed", "forming", "active"] } },
      orderBy: { lastTouchedAt: "desc" },
      take: 5,
      select: { title: true, status: true, tags: true, connectedEntities: true },
    }),
    prisma.diaryEntry.findMany({
      where: { userId, createdAt: { gte: new Date(now - 7 * DAY_MS) } },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { understoodThemes: true },
    }),
    prisma.entity.findMany({
      where: { userId, status: "active" },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { id: true, name: true, entityType: true, description: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { altimetrixUserId: true },
    }),
  ]);

  const entityNames = new Map(entities.map((entity) => [entity.id, entity.name]));
  const missing = [];
  for (const vision of visions) {
    const ref = locationRef(vision);
    if (ref?.entityId && !ref.name && !entityNames.has(ref.entityId)) missing.push(ref.entityId);
  }
  if (missing.length) {
    const extra = await prisma.entity.findMany({
      where: { userId, id: { in: [...new Set(missing)] } },
      select: { id: true, name: true },
    });
    for (const entity of extra) entityNames.set(entity.id, entity.name);
  }

  return {
    events,
    visions,
    themes: [...new Set(journal.flatMap((entry) => entry.understoodThemes || []))],
    entities,
    entityNames,
    altimetrixLinked: Boolean(user?.altimetrixUserId),
  };
}

function buildSystemPrompt(context) {
  const lines = context.events.map(formatEvent);
  const visionLines = context.visions.map((vision) => formatVision(vision, context.entityNames));
  const entityLines = context.entities.map((entity) => {
    const description = clip(entity.description, 140);
    return [entity.name, entity.entityType, description].filter(Boolean).join(" | ");
  });
  const financials = financialPicture(context.events);
  const themes = context.themes.length ? context.themes.join(", ") : "none recorded";
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return `${ADVISOR_ROLE}

CURRENT DATE: ${today}

LIFE GRAPH CONTEXT:

RECENT EVENTS:
${lines.length ? lines.join("\n") : "none in the last 30 days"}

ACTIVE VISIONS:
${visionLines.length ? visionLines.join("\n") : "none"}

KEY ENTITIES:
${entityLines.length ? entityLines.join("\n") : "none"}

RECENT JOURNAL THEMES:
${themes}

FINANCIAL PICTURE (last 30 days):
${financials}
${context.altimetrixLinked ? "\nNote: This person also uses Altimetrix for personal reflection. Their emotional context is held there, not here." : ""}`;
}

function formatEvent(event) {
  const when = formatWhen(event.occurredAt || event.createdAt);
  const location = placeName(event.places);
  const money = moneySummary(event.financials);
  return [event.title, event.space, when, money, location].filter(Boolean).join(" | ");
}

function formatVision(vision, entityNames) {
  const tags = Array.isArray(vision.tags) && vision.tags.length ? vision.tags.join(", ") : null;
  return [vision.title, vision.status, tags, visionLocation(vision, entityNames)].filter(Boolean).join(" | ");
}

function financialPicture(events) {
  const rows = events
    .map((event) => ({ event, money: readMoney(event.financials) }))
    .filter((row) => row.money);
  if (!rows.length) return "No financial activity recorded.";
  const totals = {};
  for (const row of rows) {
    const currency = row.money.currency || "TSH";
    totals[currency] = (totals[currency] || 0) + row.money.amount;
  }
  const largest = rows.reduce((best, row) => (row.money.amount > best.money.amount ? row : best));
  const summary = Object.entries(totals)
    .map(([currency, amount]) => `${formatNumber(amount)} ${currency} across ${rows.filter((row) => (row.money.currency || "TSH") === currency).length} events`)
    .join("; ");
  return `Total activity: ${summary}\nLargest: ${largest.event.title} — ${formatNumber(largest.money.amount)} ${largest.money.currency || "TSH"}`;
}

async function completeChat(messages, systemPrompt) {
  const key = process.env.GROQ_API_KEY;
  if (!key || key.startsWith("your_")) {
    throw httpError("GROQ_API_KEY is not set", 503);
  }
  const body = JSON.stringify({
    model: MODEL,
    temperature: 0.7,
    max_tokens: 800,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  });
  let response = await callGroq(key, body);
  if (response.status === 429) {
    await sleep(3000);
    response = await callGroq(key, body);
  }
  if (!response.ok) {
    console.error("[advisor] groq status", response.status);
    throw httpError(
      response.status === 429 ? "Taking a moment..." : "The advisor could not answer just now",
      response.status === 429 ? 429 : 502,
    );
  }
  const data = await response.json();
  const text = stripThink(data.choices?.[0]?.message?.content || "");
  return text || "I don't have a clear answer from what's in the life graph.";
}

function callGroq(key, body) {
  return fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw httpError("messages is required", 400);
  }
  const cleaned = messages
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content.trim().slice(0, 4000) : "",
    }))
    .filter((message) => message.content);
  if (!cleaned.length || cleaned[cleaned.length - 1].role !== "user") {
    throw httpError("The latest message must be from you", 400);
  }
  return cleaned.slice(-12);
}

function readMoney(financials) {
  if (!financials || typeof financials !== "object" || Array.isArray(financials)) return null;
  let amount = numberOrNull(financials.amount);
  if (amount == null) amount = numberOrNull(financials.totalAmount);
  if ((amount == null || amount === 0) && Array.isArray(financials.items)) {
    amount = financials.items.reduce((sum, item) => {
      const value = numberOrNull(item?.amount);
      return value == null ? sum : sum + value;
    }, 0);
  }
  if (amount == null || amount === 0) return null;
  const raw = textOr(financials.currency, "TSH").toUpperCase();
  return { amount, currency: raw === "TZS" ? "TSH" : raw };
}

function moneySummary(financials) {
  const money = readMoney(financials);
  if (!money) return null;
  return `${formatNumber(money.amount)} ${money.currency}`;
}

function placeName(places) {
  const list = Array.isArray(places) ? places : [];
  const named = list.find((place) => place && typeof place.name === "string" && place.name.trim());
  return named ? named.name.trim() : null;
}

function locationRef(vision) {
  const list = Array.isArray(vision.connectedEntities) ? vision.connectedEntities : [];
  return list.find((item) => item && (item.role === "location" || item.relationship === "location")) || null;
}

function visionLocation(vision, entityNames = new Map()) {
  const place = locationRef(vision);
  if (!place) return null;
  if (typeof place.name === "string" && place.name.trim()) return place.name.trim();
  return entityNames.get(place.entityId) || null;
}

function firstLocation(events) {
  for (const event of events) {
    const name = placeName(event.places);
    if (name) return name;
  }
  return null;
}

function firstVisionLocation(visions) {
  for (const vision of visions) {
    const name = visionLocation(vision);
    if (name) return name;
  }
  return null;
}

function formatWhen(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatNumber(amount) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(amount);
}

function dayIndex(length) {
  const day = new Date().toISOString().slice(0, 10);
  let hash = 0;
  for (const char of day) hash = (hash * 31 + char.charCodeAt(0)) % Math.max(length, 1);
  return hash;
}

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function stripThink(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function numberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function textOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
