import { prisma } from "../prisma.js";
import { dateRange, formatDay, summaryLine } from "./savedSummary.js";

// "What should I focus on?" is answered from dates: what is coming up, what is under way, what is overdue and what
// is waiting for confirmation, built by code into a short context for one model call. Without a model the same
// items are listed as next actions by code.

const DAY_MS = 24 * 60 * 60 * 1000;
const AHEAD_DAYS = 60;
const RECENT_DAYS = 14;
const OPEN = ["active", "dormant"];

export const FOCUS_QUESTION = /\b(focus (?:on|this|today|now|first)|should i focus|to focus|prioriti[sz]e|priorit(?:y|ies)|what should i (?:do|work on|tackle|start)|what(?:'s| is) (?:next|coming up|ahead)|coming up|upcoming|next (?:actions?|steps?)|plan (?:my|the) (?:week|day|month)|nifanye nini|kipaumbele)\b/i;

export function isFocusQuestion(text) {
  return FOCUS_QUESTION.test(String(text || ""));
}

function dayStart(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// "today", "tomorrow", "in 5 days", "3 days ago"
export function relativeDay(value, today) {
  const days = Math.round((dayStart(value) - dayStart(today)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

// A date known only to the month ("Dec 2026") has no day to count down to.
export function whenText(value, today, precision = null) {
  if (precision !== "month") return relativeDay(value, today);
  const date = new Date(value);
  const month = (d) => d.getUTCFullYear() * 12 + d.getUTCMonth();
  if (month(date) === month(today)) return "this month (no day recorded)";
  return month(date) > month(today) ? `in ${formatDay(date, "month")} (no day recorded)` : `${formatDay(date, "month")} (no day recorded)`;
}

function peopleNames(event) {
  return (Array.isArray(event.people) ? event.people : []).map((person) => person?.name).filter(Boolean);
}

function item(event, when) {
  const fields = summaryLine({ title: event.title, start: event.occurredAt, end: event.endsAt, people: peopleNames(event), financials: event.financials, precision: event.datePrecision });
  const meaning = event.understoodMeaning ? `. ${String(event.understoodMeaning).slice(0, 160)}` : "";
  return { event, when, text: `${fields} — ${when}${meaning}` };
}

export async function focusContext(userId, now = new Date()) {
  const today = new Date(dayStart(now));
  const ahead = new Date(today.getTime() + AHEAD_DAYS * DAY_MS);
  const recent = new Date(today.getTime() - RECENT_DAYS * DAY_MS);
  const select = { id: true, title: true, occurredAt: true, datePrecision: true, endsAt: true, dueAt: true, understoodMeaning: true, people: true, financials: true, status: true };
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const [upcoming, ongoing, due, latest, waiting, visions] = await Promise.all([
    // A month-only date in this month still counts as coming up.
    prisma.event.findMany({ where: { userId, status: { in: OPEN }, OR: [{ occurredAt: { gte: today, lte: ahead } }, { datePrecision: "month", occurredAt: { gte: monthStart, lt: today } }] }, orderBy: { occurredAt: "asc" }, take: 12, select }),
    prisma.event.findMany({ where: { userId, status: { in: OPEN }, occurredAt: { lt: today }, endsAt: { gte: today } }, orderBy: { endsAt: "asc" }, take: 6, select }),
    prisma.event.findMany({ where: { userId, status: { in: OPEN }, completedAt: null, dueAt: { not: null, lte: ahead } }, orderBy: { dueAt: "asc" }, take: 8, select }),
    prisma.event.findMany({ where: { userId, status: { in: OPEN }, occurredAt: { gte: recent, lt: today } }, orderBy: { occurredAt: "desc" }, take: 8, select }),
    prisma.inputQueue.count({ where: { userId, processingStatus: { in: ["processing", "pending"] } } }),
    prisma.vision.findMany({ where: { userId, status: { in: ["forming", "active"] } }, orderBy: { lastTouchedAt: "desc" }, take: 3, select: { title: true, status: true, nudgeAfter: true } }),
  ]);
  // Each record once, in its most urgent section: due, under way, coming up, recent.
  const shown = new Set();
  const once = (events) => events.filter((event) => !shown.has(event.id) && shown.add(event.id));
  const dueItems = once(due).map((event) => item(event, dayStart(event.dueAt) < today.getTime() ? `overdue, was due ${relativeDay(event.dueAt, today)}` : `due ${relativeDay(event.dueAt, today)}`));
  const ongoingItems = once(ongoing).map((event) => item(event, `under way, ends ${relativeDay(event.endsAt, today)}`));
  const upcomingItems = once(upcoming).map((event) => item(event, `starts ${whenText(event.occurredAt, today, event.datePrecision)}`));
  const recentItems = once(latest).map((event) => item(event, whenText(event.occurredAt, today, event.datePrecision)));
  return {
    today,
    upcoming: upcomingItems,
    ongoing: ongoingItems,
    due: dueItems,
    recent: recentItems,
    waiting,
    visions: visions.map((vision) => `${vision.title} (${vision.status})`),
  };
}

export function focusCount(context) {
  return context.upcoming.length + context.ongoing.length + context.due.length + context.recent.length;
}

const list = (items) => (items.length ? items.map((entry) => `- ${entry.text}`).join("\n") : "none");

export function focusPrompt(context) {
  const today = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(context.today);
  return `You are DIRA. The user asks what to focus on. Answer only from the dated records below.

TODAY: ${today}

OVERDUE OR DUE SOON:
${list(context.due)}

UNDER WAY NOW:
${list(context.ongoing)}

COMING UP (next ${AHEAD_DAYS} days):
${list(context.upcoming)}

LAST ${RECENT_DAYS} DAYS:
${list(context.recent)}

WAITING FOR THE USER TO CONFIRM: ${context.waiting} saved input${context.waiting === 1 ? "" : "s"}

ACTIVE VISIONS: ${context.visions.length ? context.visions.join("; ") : "none"}

How to answer:
- 3 to 5 numbered next actions, most urgent first: overdue, then by date.
- Each action names the record it comes from and its date with the days left ("on 3 Mar, in 12 days").
- Make each one concrete: what to do (book, pay, confirm, prepare, call). For a trip or event, what has to be ready
  before it starts.
- Never invent a date or deadline: use only the dates above.
- If inputs are waiting for confirmation, one action is to confirm them.
- No generic advice: nothing about rest, balance, goals, mindset or staying organised, and nothing not in the records.
- If nothing is dated ahead, say so in one line, then give actions from the last ${RECENT_DAYS} days.
- Under 130 words. Plain sentences, no headings, no closing or summary sentence.`;
}

// Without a model: the same items as actions, most urgent first.
export function focusFallback(context, reason) {
  const actions = [
    ...context.due.map((entry) => `${entry.event.title}: ${entry.when}.`),
    ...context.ongoing.map((entry) => `${entry.event.title}: ${entry.when}.`),
    ...context.upcoming.map((entry) => `Get ready for ${entry.event.title}: ${dateRange(entry.event.occurredAt, entry.event.endsAt, entry.event.datePrecision)} (${whenText(entry.event.occurredAt, context.today, entry.event.datePrecision)}).`),
  ];
  if (context.waiting) actions.push(`Confirm the ${context.waiting} saved input${context.waiting === 1 ? "" : "s"} waiting in the queue.`);
  const head = reason ? `${reason} From your records:` : "From your records:";
  if (!actions.length) {
    const recent = context.recent.slice(0, 3).map((entry) => `- ${entry.event.title} (${entry.when})`);
    return `${head} nothing dated is coming up in the next ${AHEAD_DAYS} days.${recent.length ? `\nRecent:\n${recent.join("\n")}` : ""}`;
  }
  return `${head}\n${actions.slice(0, 5).map((action, index) => `${index + 1}. ${action}`).join("\n")}`;
}
