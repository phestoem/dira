import { prisma } from "../prisma.js";
import { flagOn } from "./flags.js";
import { normalizeName } from "./graph/entityResolver.js";

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

    if (!bridgeConfig()) {
      console.log("[bridge] skipping: not configured");
      return { sent: false };
    }

    const amount = amountOf(event);
    const known = await knownPeople(userId);
    const { shared, withheld } = splitPeople(Array.isArray(event.people) ? event.people : [], known);
    const hide = [...withheld, ...known.unconfirmed];
    const payload = {
      userId: linkedId,
      eventType: event.altimetrixEventType || mapEventType(event.eventType, amount),
      title: maskNames(event.title, hide),
      context: typeof event.understoodMeaning === "string" ? maskNames(event.understoodMeaning, hide).slice(0, 200) : null,
      space: event.space,
      people: shared,
      financials: amount > 0 ? { amount, currency: currencyOf(event) } : null,
      occurredAt: event.occurredAt || event.createdAt,
      reflectionHint: maskNames(generateReflectionHint(event), hide),
      sourceSystem: "dira",
      sourceEventId: event.id,
    };

    return postLifeEvent(diraUser, payload, event.id);
  } catch (err) {
    console.error("[bridge] error:", err.message);
    return { sent: false };
  }
}

// Journal entries are sealed: one leaves DIRA only when the user turned on "Share with Altimetrix" for it, and only
// while DIRA_BRIDGE and DIRA_BRIDGE_JOURNAL are on. Names of unconfirmed people are replaced by "someone". Altimetrix
// keeps what it received (it has no delete), so turning sharing off later only stops sends that have not happened.
export async function sendJournalEntry(entry, diraUser) {
  try {
    if (!entry?.sharedWithAltimetrix || entry.sentToAltimetrixAt) return { sent: false };
    if (!flagOn("DIRA_BRIDGE_JOURNAL") || !bridgeConfig() || !diraUser?.altimetrixUserId) return { sent: false };
    const known = await knownPeople(entry.userId);
    const { withheld } = splitPeople(Array.isArray(entry.people) ? entry.people : [], known);
    const hide = [...withheld, ...known.unconfirmed];
    const text = maskNames(String(entry.rawContent || "").trim(), hide);
    if (!text) return { sent: false };
    const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || text;
    const result = await postLifeEvent(diraUser, {
      eventType: "journal",
      title: firstLine.trim().slice(0, 80),
      context: text.slice(0, 2000),
      space: "personal",
      people: [],
      financials: null,
      occurredAt: entry.occurredAt || entry.createdAt,
      reflectionHint: "A journal entry the user chose to share.",
      sourceSystem: "dira",
      sourceEventId: `journal:${entry.id}`,
    });
    if (!result.sent) return result;
    // Only mark it if sharing is still on; the user may have turned it off while the send was in flight.
    await prisma.diaryEntry.updateMany({
      where: { id: entry.id, userId: entry.userId, sharedWithAltimetrix: true },
      data: { sentToAltimetrixAt: new Date() },
    });
    return result;
  } catch (err) {
    console.error("[bridge] journal send failed:", err.message);
    return { sent: false };
  }
}

async function postLifeEvent(diraUser, payload, markEventId) {
  try {
    const config = bridgeConfig();
    if (!config) {
      console.log("[bridge] skipping: not configured");
      return { sent: false };
    }
    if (!diraUser?.altimetrixUserId) return { sent: false };
    const { base, secret } = config;
    const response = await fetchWithRetry(`${base}/life-events/ingest`, {
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

// Read-only: what comes back is attached to the answer or save as context and never written into people records.
export async function getAltimetrixContext(topics, entityNames, eventType, diraUser, queryText) {
  try {
    if (!diraUser?.altimetrixUserId) return null;
    const config = bridgeConfig();
    if (!config) {
      console.log("[bridge] skipping: not configured");
      return null;
    }
    const { base, secret } = config;

    const known = await knownPeople(diraUser.id);
    const askedNames = cleanList(entityNames);
    const names = askedNames.filter((name) => known.shareable.has(normalizeName(name)));
    const hide = [...askedNames.filter((name) => !names.includes(name)), ...known.unconfirmed];
    const topicList = cleanList(topics).filter((topic) => !hide.some((name) => normalizeName(name) === normalizeName(topic)));
    if (topicList.length === 0 && names.length === 0) return null;

    const subject = [...topicList, ...names].join(", ");
    const query = typeof queryText === "string" && queryText.trim()
      ? maskNames(queryText.trim(), hide).slice(0, 700)
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
      // A save waits for this, so a slow Altimetrix only costs a few seconds and then the save goes on without it.
      signal: AbortSignal.timeout(3000),
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
    const config = bridgeConfig();
    if (!config) {
      console.log("[bridge] skipping: not configured");
      return null;
    }
    const url = new URL("/bridge/pending-nudges", config.base);
    url.searchParams.set("userId", diraUser.altimetrixUserId);
    const response = await fetch(url, {
      headers: { "X-Bridge-Secret": config.secret },
      signal: AbortSignal.timeout(3000),
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

// Null when DIRA_BRIDGE is off or no bridge secret is set; every outbound call to Altimetrix checks this first.
export function bridgeConfig() {
  if (!flagOn("DIRA_BRIDGE")) return null;
  const secret = process.env.ALTIMETRIX_BRIDGE_SECRET || process.env.ALTIMETRIX_WEBHOOK_SECRET;
  if (!secret) return null;
  const base = (process.env.ALTIMETRIX_URL || process.env.ALTIMETRIX_API_URL || "http://localhost:4700").replace(/\/$/, "");
  return { base, secret };
}

// Only people the user confirmed leave DIRA. A person record counts as confirmed when it is the self or has a confirmed
// relationship to another record; extracted names without one stay home. Names of places, projects and other
// non-person records may be shared.
async function knownPeople(userId) {
  const entities = await prisma.entity.findMany({
    where: { userId, status: { not: "archived" }, mergedIntoId: null },
    select: { id: true, name: true, aliases: true, entityType: true, isSelf: true },
    take: 1000,
  });
  const personIds = entities.filter((entity) => entity.entityType === "person").map((entity) => entity.id);
  const edges = personIds.length
    ? await prisma.relationship.findMany({
        where: { userId, status: "confirmed", fromKind: "entity", toKind: "entity", OR: [{ fromId: { in: personIds } }, { toId: { in: personIds } }] },
        select: { fromId: true, toId: true },
      })
    : [];
  const linked = new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]));
  const shareable = new Map();
  const unconfirmed = [];
  for (const entity of entities) {
    const names = [entity.name, ...(entity.aliases || [])].filter(Boolean);
    const ok = entity.entityType !== "person" || entity.isSelf || linked.has(entity.id);
    for (const name of names) {
      if (ok) shareable.set(normalizeName(name), entity.name);
      else unconfirmed.push(name);
    }
    if (ok) shareable.set(entity.id, entity.name);
  }
  return { shareable, unconfirmed: unconfirmed.filter((name) => !shareable.has(normalizeName(name))) };
}

// Event people are [{ name | entityId, role }] (or plain names); unknown or unconfirmed ones are withheld.
function splitPeople(people, known) {
  const shared = [];
  const withheld = [];
  for (const person of people) {
    const name = typeof person === "string" ? person : person?.name;
    const key = typeof person === "object" && person?.entityId ? person.entityId : normalizeName(name);
    if (key && known.shareable.has(key)) shared.push(typeof person === "string" ? { name: known.shareable.get(key) } : person);
    else if (name) withheld.push(name);
  }
  return { shared, withheld };
}

function maskNames(text, names) {
  if (typeof text !== "string" || !names.length) return text;
  const list = [...new Set(names.map((name) => String(name).trim()).filter((name) => name.length >= 2))].sort((a, b) => b.length - a.length);
  if (!list.length) return text;
  const pattern = new RegExp(`(?<![\\p{L}\\d])(${list.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\d])`, "giu");
  return text.replace(pattern, "someone");
}

// Sending runs after the save has answered; network errors, 429 and 5xx are retried, then the event stays unsent
// (sentToAltimetrix = false) for the next sync.
async function fetchWithRetry(url, init, attempts = 3) {
  const delay = Number(process.env.ALTIMETRIX_RETRY_MS ?? 2000);
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
      if (response.ok || (response.status < 500 && response.status !== 429) || attempt === attempts) return response;
      last = new Error(`status ${response.status}`);
    } catch (err) {
      last = err;
      if (attempt === attempts) throw err;
    }
    console.log(`[bridge] attempt ${attempt} failed (${last.message}); retrying`);
    await new Promise((resolve) => setTimeout(resolve, delay * attempt));
  }
  throw last;
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
  if (flagOn("DIRA_BRIDGE_JOURNAL")) {
    const entries = await prisma.diaryEntry.findMany({
      where: { userId, sharedWithAltimetrix: true, sentToAltimetrixAt: null },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const entry of entries) {
      const result = await sendJournalEntry(entry, diraUser);
      if (result.sent) sent += 1;
    }
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
