import { prisma } from "../prisma.js";

// Follow-up messages that continue the save just made. After a save, a message that reads like more of the same
// ("also…", "we come back on…", or one that shares a word with the saved title) is offered to that event first:
// "Add to <title>?" or "Save as new". No model call decides this; the follow-up's own understanding (already made
// for the preview) supplies what gets merged.

const WINDOW_MS = 30 * 60 * 1000;
const lastSaved = new Map(); // userId → { eventId, title, at }

export function noteSaved(userId, event) {
  if (!userId || !event?.id) return;
  lastSaved.set(userId, { eventId: event.id, title: event.title || "", at: Date.now() });
}

export function lastSavedFor(userId, now = Date.now()) {
  const entry = lastSaved.get(userId);
  if (!entry || now - entry.at > WINDOW_MS) return null;
  return entry;
}

export function forgetSaved(userId) {
  lastSaved.delete(userId);
}

const OPENERS = /^(also|and|plus|then|after that|afterwards|later|it|it's|its|it is|we|we'll|we will|we're|we are|they|she|he|i'll|i will|coming back|back on|returning|return|until|till|from|for that|for it|same|the same|that|this|pia|na|halafu|kisha)\b/i;
const STOP = new Set([
  "about", "after", "again", "also", "back", "been", "before", "being", "coming", "could", "from", "have", "here", "into",
  "just", "last", "like", "more", "much", "next", "only", "other", "over", "said", "same", "some", "than", "that", "their",
  "them", "then", "there", "these", "they", "this", "those", "time", "today", "tomorrow", "until", "very", "want", "were",
  "what", "when", "where", "which", "while", "will", "with", "would", "your", "yours", "week", "month", "year", "days",
  "save", "saved", "note", "event",
]);

function words(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 4 && !STOP.has(word));
}

// True when the message reads like it adds to the saved event rather than starting something new.
export function looksLikeContinuation(message, title) {
  const text = String(message || "").trim();
  if (!text) return false;
  if (OPENERS.test(text)) return true;
  const titleWords = new Set(words(title));
  return words(text).some((word) => titleWords.has(word));
}

// Merges a follow-up's understanding into an existing event. Only fills what the event lacks (date, place, amount)
// and adds what is new (text, people); nothing the event already says is overwritten. Returns the event and a list
// of what was added, for the reply.
export async function attachToEvent(userId, eventId, understood, rawText, queueId) {
  const event = await prisma.event.findFirst({ where: { id: eventId, userId } });
  if (!event) {
    const error = new Error("The event to add to is gone");
    error.statusCode = 404;
    throw error;
  }
  const added = [];
  const data = {};
  const text = String(rawText || "").trim();
  if (text) data.rawInput = event.rawInput ? `${event.rawInput}\n\n${text}` : text;
  const summary = String(understood?.summary || "").trim();
  if (summary) data.understoodMeaning = event.understoodMeaning ? `${event.understoodMeaning} ${summary}` : summary;

  const people = Array.isArray(event.people) ? [...event.people] : [];
  const known = new Set(people.map((person) => String(person?.name || "").toLowerCase()).filter(Boolean));
  for (const name of understood?.people || []) {
    const key = String(name).trim().toLowerCase();
    if (!key || known.has(key)) continue;
    known.add(key);
    people.push({ name: String(name).trim(), role: "mentioned" });
    added.push(`with ${String(name).trim()}`);
  }
  if (people.length !== (Array.isArray(event.people) ? event.people.length : 0)) data.people = people;

  const places = Array.isArray(event.places) ? event.places : [];
  if (understood?.location && !places.length) {
    data.places = [{ name: understood.location, role: "mentioned" }];
    added.push(`at ${understood.location}`);
  }

  if (!event.occurredAt && understood?.occurredAt && /^\d{4}-\d{2}-\d{2}$/.test(understood.occurredAt)) {
    data.occurredAt = new Date(`${understood.occurredAt}T00:00:00.000Z`);
    added.push(`on ${understood.occurredAt}`);
  }

  const financial = understood?.financial;
  const hasAmount = Number(event.financials?.amount) > 0;
  if (!hasAmount && financial?.hasFinancials && Number(financial.totalAmount) > 0) {
    data.financials = {
      amount: Number(financial.totalAmount),
      currency: financial.currency || null,
      direction: financial.direction || null,
      parties: [],
      transfers: [],
      items: Array.isArray(financial.items) ? financial.items : [],
    };
    added.push(`${Number(financial.totalAmount).toLocaleString("en-US")} ${financial.currency || ""}`.trim());
  }

  const updated = await prisma.event.update({ where: { id: event.id }, data: { ...data, graphExtractedAt: null } });
  if (queueId) {
    await prisma.inputQueue.updateMany({
      where: { id: queueId, userId, processingStatus: "processing" },
      data: { processingStatus: "understood", resultEventId: event.id, processedAt: new Date(), error: null },
    });
  }
  return { event: updated, added };
}
