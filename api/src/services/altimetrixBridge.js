import { prisma } from "../prisma.js";

const TSH_THRESHOLD = 100_000;
const LARGE_FINANCIAL = 500_000;

export function isSignificantEvent(event) {
  if (!event || event.sentToAltimetrix) return false;
  if (event.altimetrixEventType) return true;
  if (event.eventType === "milestone") return true;
  return isLargeTsh(event, TSH_THRESHOLD);
}

const shiftSent = new Map();

export async function notifyRelationshipShift(userId, edge, options = {}) {
  try {
    if (!edge || (edge.category !== "family" && edge.category !== "ownership")) return { sent: false };
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.altimetrixUserId) return { sent: false };
    const day = new Date().toISOString().slice(0, 10);
    const key = `${userId}:${edge.fromId}:${day}`;
    if (shiftSent.get(key)) return { sent: false };
    shiftSent.set(key, true);
    const [from, to] = await Promise.all([
      prisma.entity.findFirst({ where: { id: edge.fromId, userId }, select: { name: true } }),
      prisma.entity.findFirst({ where: { id: edge.toId, userId }, select: { name: true } }),
    ]);
    const verb = String(edge.type || "related").replace(/_/g, " ");
    const title = options.ended
      ? `${from?.name || "Someone"} no longer ${verb} ${to?.name || "someone"}`
      : `${from?.name || "Someone"} ${verb} ${to?.name || "someone"}`;
    return await postLifeEvent(user, {
      eventType: "relationship_shift",
      title,
      context: null,
      space: "personal",
      people: [from?.name, to?.name].filter(Boolean).map((name) => ({ name })),
      financials: null,
      occurredAt: new Date().toISOString(),
      reflectionHint: "A close relationship or something you own has changed.",
      sourceSystem: "dira",
      sourceEventId: edge.id,
    });
  } catch (err) {
    console.error("[bridge] error:", err.message);
    return { sent: false };
  }
}

export async function sendLifeEvent(event, userId, diraUser) {
  try {
    const linkedId = diraUser?.altimetrixUserId;
    if (!linkedId) {
      console.log("[bridge] skipping: no altimetrix user linked");
      return { sent: false };
    }

    const secret = process.env.ALTIMETRIX_BRIDGE_SECRET || process.env.ALTIMETRIX_WEBHOOK_SECRET;
    const base = (process.env.ALTIMETRIX_URL || process.env.ALTIMETRIX_API_URL || "http://localhost:4700").replace(
      /\/$/,
      "",
    );
    if (!secret) {
      console.error("[bridge] error: ALTIMETRIX_BRIDGE_SECRET is not set");
      return { sent: false };
    }

    const amount = amountOf(event);
    const payload = {
      userId: linkedId,
      eventType: event.altimetrixEventType || mapEventType(event.eventType, amount),
      title: event.title,
      context: typeof event.understoodMeaning === "string" ? event.understoodMeaning.slice(0, 200) : null,
      space: event.space,
      people: Array.isArray(event.people) ? event.people : [],
      financials: amount > 0 ? { amount, currency: currencyOf(event) } : null,
      occurredAt: event.occurredAt || event.createdAt,
      reflectionHint: generateReflectionHint(event),
      sourceSystem: "dira",
      sourceEventId: event.id,
    };

    return postLifeEvent(diraUser, payload, event.id);
  } catch (err) {
    console.error("[bridge] error:", err.message);
    return { sent: false };
  }
}

async function postLifeEvent(diraUser, payload, markEventId) {
  try {
    const secret = process.env.ALTIMETRIX_BRIDGE_SECRET || process.env.ALTIMETRIX_WEBHOOK_SECRET;
    const base = (process.env.ALTIMETRIX_URL || process.env.ALTIMETRIX_API_URL || "http://localhost:4700").replace(/\/$/, "");
    if (!secret || !diraUser?.altimetrixUserId) return { sent: false };
    const response = await fetch(`${base}/life-events/ingest`, {
      method: "POST",
      headers: {
        "X-Bridge-Secret": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...payload, userId: diraUser.altimetrixUserId }),
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error("[bridge] error:", response.status, detail.slice(0, 300));
      return { sent: false };
    }

    if (markEventId) {
      await prisma.event.update({
        where: { id: markEventId },
        data: { sentToAltimetrix: true },
      });
    }
    console.log("[bridge] sent event:", payload.title, "→ Altimetrix");
    return { sent: true };
  } catch (err) {
    console.error("[bridge] error:", err.message);
    return { sent: false };
  }
}

export async function getAltimetrixContext(topics, entityNames, eventType, diraUser, queryText) {
  try {
    if (!diraUser?.altimetrixUserId) return null;
    const topicList = cleanList(topics);
    const names = cleanList(entityNames);
    if (topicList.length === 0 && names.length === 0) return null;

    const secret = process.env.ALTIMETRIX_BRIDGE_SECRET || process.env.ALTIMETRIX_WEBHOOK_SECRET;
    const base = bridgeBase();
    if (!secret) return null;

    const subject = [...topicList, ...names].join(", ");
    const query = typeof queryText === "string" && queryText.trim()
      ? queryText.trim().slice(0, 700)
      : `What does this person think/feel about: ${subject}?`;

    const response = await fetch(`${base}/bridge/context`, {
      method: "POST",
      headers: {
        "X-Bridge-Secret": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: diraUser.altimetrixUserId,
        query,
        topics: topicList,
        entityNames: names,
        eventType: eventType || "personal",
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    console.log(
      "[bridge] got context from Altimetrix:",
      data.memoriesFound,
      "memories,",
      data.threadsFound,
      "threads",
    );
    return data;
  } catch (err) {
    console.error("[bridge] context failed:", err.message);
    return null;
  }
}

export async function fetchAltimetrixNudge(diraUser) {
  try {
    if (!diraUser?.altimetrixUserId) return null;
    const secret = process.env.ALTIMETRIX_BRIDGE_SECRET || process.env.ALTIMETRIX_WEBHOOK_SECRET;
    if (!secret) return null;
    const url = new URL("/bridge/pending-nudges", bridgeBase());
    url.searchParams.set("userId", diraUser.altimetrixUserId);
    const response = await fetch(url, {
      headers: { "X-Bridge-Secret": secret },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.nudge?.message) return null;
    return {
      message: String(data.nudge.message),
      href: process.env.ALTIMETRIX_WEB_URL || "http://localhost:3000",
    };
  } catch (err) {
    console.error("[bridge] nudge failed:", err.message);
    return null;
  }
}

function bridgeBase() {
  return (process.env.ALTIMETRIX_URL || process.env.ALTIMETRIX_API_URL || "http://localhost:4700").replace(/\/$/, "");
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter((item) => item.length >= 2))].slice(0, 8);
}

export async function syncPendingEvents(userId, diraUser) {
  const events = await prisma.event.findMany({
    where: { userId, sentToAltimetrix: false, status: { not: "archived" } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  let sent = 0;
  for (const event of events) {
    if (!isSignificantEvent(event)) continue;
    const result = await sendLifeEvent(event, userId, diraUser);
    if (result.sent) sent += 1;
  }
  return { sent };
}

function mapEventType(eventType, amount) {
  if (eventType === "financial") return amount > LARGE_FINANCIAL ? "milestone" : "achievement";
  if (eventType === "project_update") return "milestone";
  if (eventType === "personal") return "pattern";
  return "achievement";
}

function generateReflectionHint(event) {
  const title = event.title || "this";
  const amount = amountOf(event);
  const currency = currencyOf(event) || "TSH";
  if (event.eventType === "financial" && amount > 0) {
    return `Managed ${currency} ${formatAmount(amount)} on ${title}`;
  }
  if (event.eventType === "personal") return `Personal event: ${title}`;
  if (event.eventType === "project_update" || event.eventType === "milestone") {
    return `Project activity: ${title}`;
  }
  if (amount > 0) return `Managed ${currency} ${formatAmount(amount)} on ${title}`;
  return `Life event: ${title}`;
}

function isLargeTsh(event, threshold) {
  const currency = currencyOf(event);
  if (currency && currency !== "TSH" && currency !== "TZS") return false;
  return amountOf(event) > threshold;
}

function amountOf(event) {
  const financials = event?.financials;
  if (!financials || typeof financials !== "object") return 0;
  const amount = Number(financials.amount);
  return Number.isFinite(amount) ? amount : 0;
}

function currencyOf(event) {
  const currency = event?.financials?.currency;
  if (typeof currency !== "string" || !currency.trim()) return null;
  const code = currency.trim().toUpperCase();
  return code === "TZS" ? "TSH" : code;
}

function formatAmount(amount) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(amount);
}
