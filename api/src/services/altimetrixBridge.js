import { prisma } from "../prisma.js";

const TSH_THRESHOLD = 100_000;
const LARGE_FINANCIAL = 500_000;

export function isSignificantEvent(event) {
  if (!event || event.sentToAltimetrix) return false;
  if (event.altimetrixEventType) return true;
  if (event.eventType === "milestone") return true;
  return isLargeTsh(event, TSH_THRESHOLD);
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

    const response = await fetch(`${base}/life-events/ingest`, {
      method: "POST",
      headers: {
        "X-Bridge-Secret": secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error("[bridge] error:", response.status, detail.slice(0, 300));
      return { sent: false };
    }

    await prisma.event.update({
      where: { id: event.id },
      data: { sentToAltimetrix: true },
    });
    console.log("[bridge] sent event:", event.title, "→ Altimetrix");
    return { sent: true };
  } catch (err) {
    console.error("[bridge] error:", err.message);
    return { sent: false };
  }
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
