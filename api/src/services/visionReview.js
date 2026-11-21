import { prisma } from "../prisma.js";
import { amountText, formatDay } from "./savedSummary.js";
import { missing } from "./timeline.js";

// Vision questions ("revisit the X vision") are answered by code: the vision itself plus the events that belong to
// it, by explicit link (connectedEvents) or by its name (the part of the title that names a place or project, e.g.
// "Quiet Harbour" in "Quiet Harbour Garden Vision"). The answer says what is done, spent and planned, and what is not
// recorded. It offers nothing the records don't hold (no funding, partners, next steps).

// Words that describe a vision rather than name it; a name needs at least one word outside this list.
const GENERIC = new Set(["vision", "visions", "plan", "plans", "project", "projects", "dream", "idea", "eco", "living", "life", "lifestyle", "home", "house", "houses", "place", "the", "of", "a", "an", "my", "our", "for", "and", "in", "at", "on", "to", "new", "big", "future", "wa", "ya", "la", "na", "za", "cha"]);
const CONNECTOR = new Set(["the", "of", "a", "an", "for", "and", "in", "at", "on", "to", "wa", "ya", "la", "na", "za", "cha"]);
const REVIEW = /\b(revisit|review|recap|go (?:over|through)|look (?:back )?at|remind me (?:of|about)|tell me about|what about|what(?:'s| is) (?:the )?(?:status|state)|where (?:am i|are we|do i stand|do we stand) with|status (?:of|on)|update on|progress (?:of|on)|how (?:is|'s|are) .{0,60}(?:going|coming along|doing))\b/i;

const words = (text) => String(text || "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phraseIn = (phrase, text) => new RegExp(`(?<![\\p{L}\\p{N}])${phrase.split(" ").map(escape).join("[\\s_-]+")}(?![\\p{L}\\p{N}])`, "iu").test(String(text || ""));

// Contiguous runs of the title's words that could name it: no connector at either end, one word outside GENERIC.
export function nameRuns(title) {
  const list = words(title);
  const runs = [];
  for (let size = list.length; size >= 1; size -= 1) {
    for (let start = 0; start + size <= list.length; start += 1) {
      const run = list.slice(start, start + size);
      if (CONNECTOR.has(run[0]) || CONNECTOR.has(run.at(-1))) continue;
      const named = run.filter((word) => !GENERIC.has(word));
      if (!named.length || (run.length === 1 && run[0].length < 4)) continue;
      runs.push({ phrase: run.join(" "), named: named.length });
    }
  }
  return runs;
}

// How well a text names a vision: the named words of the longest title run it contains (0 = not named).
export function nameScore(vision, text) {
  let best = { score: 0, phrase: null };
  for (const run of nameRuns(vision.title)) {
    if (run.named > best.score && phraseIn(run.phrase, text)) best = { score: run.named, phrase: run.phrase };
  }
  return best;
}

// The vision a text names: the one with the best score, or { ask } when two name it equally well.
export function namedVision(text, visions) {
  const scored = visions.map((vision) => ({ vision, ...nameScore(vision, text) })).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  let tied = scored.filter((item) => item.score === scored[0].score);
  // Equal names: the vision whose title starts with the phrase is the one named ("X Garden" over "Wall for X").
  const leading = tied.filter((item) => words(item.vision.title).join(" ").startsWith(item.phrase));
  if (tied.length > 1 && leading.length === 1) tied = leading;
  if (tied.length > 1) return { ask: `Which vision do you mean: ${tied.map((item) => `“${item.vision.title}”`).join(" or ")}?` };
  return tied[0];
}

// "Revisit / review / how is … going" with a vision named: a question to answer, never a change to make.
export function isVisionReview(text, visions) {
  const named = namedVision(String(text || ""), visions);
  return Boolean(named && !named.ask && REVIEW.test(String(text || "")));
}

export function isVisionQuestion(text, visions) {
  const question = String(text || "");
  if (!visions.length) return false;
  const named = namedVision(question, visions);
  if (!named) return /\b(my|our|the) visions?\b/i.test(question) && REVIEW.test(question) && visions.length === 1;
  return /\bvisions?\b/i.test(question) || REVIEW.test(question);
}

// The phrases that tie an event to a vision: the longest name runs (the one the question used first) that the records
// contain, never a part of one already found. A single word counts only when the title names it with one word.
export function nameKeys(vision, question, events) {
  const asked = nameScore(vision, question).phrase;
  const runs = nameRuns(vision.title);
  const most = Math.max(0, ...runs.map((run) => run.named));
  const candidates = [asked, ...runs.filter((run) => run.named >= Math.min(2, most)).map((run) => run.phrase)].filter(Boolean);
  const found = [];
  for (const phrase of candidates) {
    if (found.some((key) => phraseIn(phrase, key))) continue;
    if (events.some((event) => phraseIn(phrase, eventText(event)))) found.push(phrase);
  }
  return found.length ? found : asked ? [asked] : [];
}

export function eventText(event) {
  const refs = [...(Array.isArray(event.places) ? event.places : []), ...(Array.isArray(event.people) ? event.people : [])].map((ref) => ref?.name).filter(Boolean);
  return [event.title, event.rawInput, event.understoodMeaning, ...(event.tags || []), ...refs].filter(Boolean).join(" \n ");
}

export function visionEvents(vision, keys, events) {
  const linked = new Set((Array.isArray(vision.connectedEvents) ? vision.connectedEvents : []).map((link) => link?.eventId).filter(Boolean));
  // Records linked to the vision (a project, a place) bring their events: those whose people/places refs carry them.
  const records = new Set((Array.isArray(vision.connectedEntities) ? vision.connectedEntities : []).map((link) => link?.entityId).filter(Boolean));
  const viaRecord = (event) => [...(Array.isArray(event.people) ? event.people : []), ...(Array.isArray(event.places) ? event.places : [])].some((ref) => ref?.entityId && records.has(ref.entityId));
  return events.filter((event) => linked.has(event.id) || viaRecord(event) || keys.some((key) => phraseIn(key, eventText(event))));
}

const PLANNED = /\b(plan(?:s|ning|ned)?|will|intend(?:s|ing)?|going to|next (?:month|year|week)|to be (?:done|built|finished))\b/i;
const DONE = /\b(complete[ds]?|completion|finished|done|started|began|broke ground|built|installed|signed|paid|bought|purchased|delivered|planted|fixed|\d{1,3}\s*%)/i;

// { done, planned, other, spent } for a vision's events, by recorded dates and wording only.
export function sortRecords(records, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const ahead = (event) => [event.occurredAt && [event.occurredAt, event.datePrecision], event.dueAt && [event.dueAt, null], event.endsAt && [event.endsAt, null]]
    .filter(Boolean)
    .some(([at, precision]) => new Date(at) >= (precision === "month" ? monthStart : today));
  const spent = records.filter((event) => amountText(event.financials) && event.financials?.direction !== "income");
  const done = [];
  const planned = [];
  const other = [];
  for (const event of records) {
    // A payment is listed under Spent, unless it is still ahead.
    if (spent.includes(event) && !ahead(event)) continue;
    const text = [event.title, event.rawInput, event.understoodMeaning].filter(Boolean).join(" ");
    if (ahead(event) || (!event.occurredAt && PLANNED.test(text) && !DONE.test(text))) planned.push(event);
    else if (DONE.test(text) || (event.occurredAt && new Date(event.occurredAt) < today)) done.push(event);
    else other.push(event);
  }
  return { done, planned, other, spent, today };
}

function totals(events) {
  const sums = new Map();
  for (const event of events) {
    const amount = Number(event.financials?.amount);
    const currency = event.financials?.currency || "";
    sums.set(currency, (sums.get(currency) || 0) + amount);
  }
  return [...sums].map(([currency, amount]) => `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`.trim()).join(" + ");
}

function when(event) {
  if (event.occurredAt) return formatDay(event.occurredAt, event.datePrecision);
  if (event.dueAt) return `due ${formatDay(event.dueAt)}`;
  return null;
}

function line(event) {
  const facts = progressFacts(event.rawInput || event.understoodMeaning);
  const detail = facts.length ? facts.join("; ") : when(event);
  return detail ? `${event.title} (${detail})` : event.title;
}

const STAGE = { seed: "seed (an idea)", forming: "forming", held: "held", active: "active (under way)", released: "released", archived: "archived" };

export function visionAnswer(vision, records, related = [], now = new Date()) {
  const { done, planned, other, spent, today } = sortRecords(records, now);
  const lines = [`${vision.title}`];
  lines.push(`- Stage: ${STAGE[vision.status] || vision.status}; saved ${formatDay(vision.createdAt)}${vision.lastTouchedAt && formatDay(vision.lastTouchedAt) !== formatDay(vision.createdAt) ? `, last touched ${formatDay(vision.lastTouchedAt)}` : ""}.`);
  if (vision.summary) lines.push(`- Vision: ${vision.summary}`);
  if (!records.length) {
    lines.push("- No events recorded for it yet.");
  } else {
    lines.push(done.length ? `- Done: ${done.map(line).join("; ")}.` : "- Done: nothing recorded.");
    // Only what the records hold, so the total is labelled as such and every record behind it is named.
    lines.push(spent.length
      ? `- Recorded spending: ${totals(spent)}, from ${spent.length} record${spent.length === 1 ? "" : "s"}: ${spent.map((event) => `${event.title} (${amountText(event.financials)}${event.occurredAt ? `, ${formatDay(event.occurredAt, event.datePrecision)}` : ""})`).join("; ")}.`
      : "- Recorded spending: none recorded.");
    lines.push(planned.length ? `- Planned: ${planned.map(line).join("; ")}.` : "- Planned: nothing recorded.");
    if (other.length) lines.push(`- Also recorded: ${other.map(line).join("; ")}.`);
  }
  if (related.length) lines.push(`- Related vision${related.length === 1 ? "" : "s"}: ${related.map((item) => `${item.title} (${item.status})`).join("; ")}.`);
  const gaps = missing("work", records, today);
  if (gaps.length) lines.push(`- Not recorded: ${gaps.join(", ")}.`);
  return lines.join("\n");
}

const VISION_SELECT = { id: true, title: true, summary: true, status: true, connectedEvents: true, connectedEntities: true, createdAt: true, lastTouchedAt: true };
const EVENT_SELECT = { id: true, title: true, rawInput: true, understoodMeaning: true, occurredAt: true, datePrecision: true, endsAt: true, dueAt: true, financials: true, places: true, people: true, tags: true };

export async function loadVisions(userId) {
  return prisma.vision.findMany({ where: { userId, status: { not: "archived" } }, select: VISION_SELECT, orderBy: { createdAt: "asc" } });
}

// The vision a question or statement is about, its events and its related visions; null when none is named.
export async function visionContext(userId, text, visions = null) {
  const list = visions || (await loadVisions(userId));
  const named = namedVision(text, list) || (list.length === 1 && /\b(my|our|the) visions?\b/i.test(text) ? { vision: list[0] } : null);
  if (!named || named.ask) return named;
  const events = await prisma.event.findMany({ where: { userId, status: { not: "archived" } }, select: EVENT_SELECT, orderBy: [{ occurredAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }], take: 1000 });
  const keys = nameKeys(named.vision, text, events);
  const records = visionEvents(named.vision, keys, events);
  // Another vision that carries the same name in its title or place ("a fence for Quiet Harbour").
  const related = list.filter((other) => other.id !== named.vision.id && keys.some((key) => phraseIn(key, [other.title, ...(other.connectedEntities || []).map((ref) => ref?.name)].join(" "))));
  return { vision: named.vision, keys, records, related };
}

export async function answerVision(userId, question) {
  const visions = await loadVisions(userId);
  if (!isVisionQuestion(question, visions)) return null;
  const found = await visionContext(userId, question, visions);
  if (!found) return null;
  if (found.ask) return { reply: found.ask, count: 0 };
  return { reply: visionAnswer(found.vision, found.records, found.related), count: found.records.length };
}

// ---- progress statements ("the first cabin is finished and the second is about 40% done") ----

const NUMBER = { one: 1, first: 1, "1st": 1, two: 2, second: 2, "2nd": 2, three: 3, third: 3, "3rd": 3, four: 4, fourth: 4, "4th": 4, five: 5, fifth: 5, "5th": 5 };
const ORDINAL = new Set(["first", "1st", "second", "2nd", "third", "3rd", "fourth", "4th", "fifth", "5th"]);
const NOT_NOUN = new Set(["is", "are", "was", "were", "has", "have", "had", "of", "the", "and", "about", "around", "almost", "nearly", "done", "complete", "completed", "finished", "percent", "phase", "stage", "part"]);

// Short facts, in order: "house 1 complete", "house 2 ~70%", "fence started". Empty when the text states no progress.
export function progressFacts(text) {
  const facts = [];
  let lastNoun = null;
  const clauses = String(text || "").split(/[;,.]\s+|\s+\band\b\s+|\s+\bbut\b\s+|\s+\bwhile\b\s+/i);
  for (const clause of clauses) {
    const pct = clause.match(/(?:\b(about|around|approximately|roughly|nearly|almost|over|~)\s*)?(\d{1,3})\s*(?:%|percent\b)/i);
    const complete = /\b(completed?|finished|done|built|ready)\b/i.test(clause);
    const started = /\b(started|began|broke ground|under way|underway)\b/i.test(clause);
    if (!pct && !complete && !started) continue;
    let subject = null;
    for (const counted of clause.matchAll(/\b(one|first|1st|two|second|2nd|three|third|3rd|four|fourth|4th|five|fifth|5th|\d{1,2})\b(?!\s*(?:%|percent\b))(?:\s+of\s+the)?(?:\s+([\p{L}]+))?/giu)) {
      const word = counted[1].toLowerCase();
      const n = NUMBER[word] ?? Number(word);
      let noun = counted[2] && !NOT_NOUN.has(counted[2].toLowerCase()) ? counted[2].toLowerCase() : null;
      if (noun) lastNoun = noun.replace(/s$/, "");
      noun = noun || lastNoun;
      if (!noun || !n) continue;
      const plural = /s$/.test(noun) && !ORDINAL.has(word) && n > 1;
      subject = plural ? `${n} ${noun}` : `${noun.replace(/s$/, "")} ${n}`;
      break;
    }
    if (!subject) {
      const thing = clause.match(/\b(?:the|our|my)\s+([\p{L}]+(?:\s+[\p{L}]+)?)/iu);
      subject = thing && !NOT_NOUN.has(thing[1].split(" ")[0].toLowerCase()) ? thing[1].toLowerCase().replace(/\s+(is|are|was|has|have)$/, "") : null;
    }
    const state = pct ? `~${pct[2]}%` : complete ? "complete" : "started";
    facts.push(subject ? `${subject} ${state}` : state);
  }
  // "house started" says less than "house 2 started": keep the numbered one.
  return facts.filter((fact, index) => facts.indexOf(fact) === index && fact !== "complete" && fact !== "started"
    && !facts.some((other) => other !== fact && new RegExp(`^${escape(fact.split(" ")[0])} \\d+ ${escape(fact.split(" ").slice(1).join(" "))}$`).test(other)));
}

const BEFORE_ACTIVE = new Set(["seed", "forming", "held"]);

// A progress statement about a vision: named in the statement, or in the question just before it.
// Returns { vision, facts, toStage } for a card, or null. Nothing is written here.
export async function visionProgress(userId, statement, previousQuestion) {
  if (/\?\s*$/.test(statement) || /^\s*(how|what|when|where|why|which|who|is|are|do|does|did|can|could|should|will)\b/i.test(statement)) return null;
  const facts = progressFacts(statement);
  if (!facts.length) return null;
  const visions = await loadVisions(userId);
  if (!visions.length) return null;
  let named = namedVision(statement, visions);
  if ((!named || named.ask) && previousQuestion && isVisionQuestion(previousQuestion, visions)) named = namedVision(previousQuestion, visions) || (visions.length === 1 ? { vision: visions[0] } : null);
  // Not about one vision: the statement is saved the usual way.
  if (!named || named.ask) return null;
  const toStage = BEFORE_ACTIVE.has(named.vision.status) ? "active" : null;
  return { vision: named.vision, phrase: named.phrase || null, facts, toStage };
}

const titleCase = (text) => String(text || "").replace(/(^|\s)(\p{L})/gu, (match, space, letter) => `${space}${letter.toUpperCase()}`);

// Writes what the confirm card chose: "save" saves the statement as an event linked to the vision; "stage" moves it.
export async function applyVisionProgress(userId, proposal, chosen) {
  const vision = await prisma.vision.findFirst({ where: { id: proposal.visionId, userId }, select: { id: true, title: true, status: true, connectedEvents: true, connectedEntities: true } });
  if (!vision) return { written: [] };
  const written = [];
  const data = { lastTouchedAt: new Date() };
  let eventId = null;
  if (chosen.has("save")) {
    const name = proposal.phrase ? titleCase(proposal.phrase) : vision.title;
    const location = (Array.isArray(vision.connectedEntities) ? vision.connectedEntities : []).find((ref) => ref?.role === "location" && ref?.name);
    const event = await prisma.event.create({
      data: {
        userId,
        title: `${name} progress`,
        rawInput: proposal.statement,
        understoodMeaning: `Progress on ${vision.title}: ${proposal.facts.join("; ")}.`,
        eventType: "project_update",
        space: "personal",
        source: "manual",
        people: [{ name, role: "project" }],
        places: location ? [{ name: location.name, role: "location" }] : [],
        tags: ["progress"],
      },
    });
    await prisma.inputQueue.create({ data: { userId, rawContent: proposal.statement, contentType: "text", source: "manual", processingStatus: "understood", processedAt: new Date(), resultEventId: event.id, resultVisionId: vision.id } });
    eventId = event.id;
    const links = Array.isArray(vision.connectedEvents) ? vision.connectedEvents : [];
    data.connectedEvents = [...links.filter((link) => link?.eventId !== event.id), { eventId: event.id, relationship: "progress" }];
    written.push(`saved “${event.title}” and linked it to ${vision.title}`);
  }
  if (chosen.has("stage") && proposal.toStage && vision.status === proposal.fromStage) {
    data.status = proposal.toStage;
    written.push(`stage ${proposal.fromStage} → ${proposal.toStage}`);
  }
  if (written.length) await prisma.vision.update({ where: { id: vision.id }, data });
  return { written, eventId };
}

