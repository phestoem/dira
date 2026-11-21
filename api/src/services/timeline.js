import { prisma } from "../prisma.js";
import { whenText } from "./focus.js";
import { amountText, formatDay } from "./savedSummary.js";

// Timeline and progress questions ("how many days until my trip?", "how is the renovation going?") are answered by
// code from the records: the days until the next recorded date, what is recorded for each thing asked about, and
// what is not recorded (flights, a contractor, …). Only recorded progress is reported; nothing here ever calls a
// plan "on track".

const DAY_MS = 24 * 60 * 60 * 1000;
export const TIMELINE_QUESTION = /\b(on track|progress|how (?:is|are|'s) (?:the |my |our )?[\p{L} ]{0,40}going|status (?:of|on)|where (?:am i|are we|do i stand|do we stand) with|ready for|prepared for|how far (?:along|is|are)|days? (?:until|till|left|to go|before)|how long (?:until|till|before)|how many days|timeline|countdown)\b/iu;

export function isTimelineQuestion(text) {
  return TIMELINE_QUESTION.test(String(text || ""));
}

const STOP = new Set(["what", "when", "where", "which", "with", "that", "this", "there", "they", "them", "their", "have", "does", "doing", "going", "about", "until", "till", "left", "days", "many", "long", "much", "status", "progress", "track", "ready", "prepared", "timeline", "countdown", "before", "after", "from", "into", "your", "mine", "ours", "will", "would", "should", "could", "stand", "along", "things", "plans", "plan", "next"]);
const TOPIC = /\b(trips?|travel(?:ling)?|journey|flights?|renovation|construction|building|house|fence|landscaping|works|project|wedding|move|moving)\b/gi;

// Names (proper nouns) and topic words ("trip", "renovation") in the question.
export function subjectTerms(question) {
  const text = String(question || "");
  const names = [];
  for (const match of text.matchAll(/\b[\p{Lu}][\p{L}'’-]{2,}(?:\s+[\p{Lu}][\p{L}'’-]{2,})*/gu)) {
    const words = match[0].replace(/['’]s\b/g, "").split(/\s+/).filter((word) => !STOP.has(word.toLowerCase()) && !/^(How|What|When|Where|Which|Am|Is|Are|Do|Does|My|Our|The|Has|Have|Will)$/.test(word));
    if (words.length) names.push(words.join(" ").toLowerCase());
  }
  const topics = [...new Set([...text.matchAll(TOPIC)].map((match) => match[0].toLowerCase().replace(/s$/, "").replace(/^travelling$/, "travel")))];
  return { names: [...new Set(names)], topics };
}

const textOf = (event) => [event.title, event.understoodMeaning, event.rawInput].filter(Boolean).join(" ").toLowerCase();
const TRIP_WORDS = /\b(trip|travel|flight|journey|safari|visit)\b/;
const WORK_WORDS = /\b(renovation|construction|building|build|fence|uzio|landscaping|works|repair|installation|house)\b/;

const CHECKS = {
  trip: [
    ["flights", /\b(flights?|tickets?|airline|boarding|booking ref)\b/],
    ["accommodation", /\b(hotel|accommodation|airbnb|guest ?house|lodge|stay at)\b/],
    ["return date", null],
    ["local transport", /\b(driver|car hire|rental car|pick-?up|transfer|transport)\b/],
    ["budget", null],
  ],
  work: [
    ["contractor", /\b(contractor|fundi|builder|company|agreement|signed|hired)\b/],
    ["cost estimate", /\b(estimate|estimation|quotation|quote|bill of quantities|boq|budget)\b/],
    ["payments", null],
    ["materials", /\b(materials?|cement|bricks?|timber|roofing|tiles)\b/],
    ["start or finish date", null],
  ],
};
const PROGRESS = /\b(completed|finished|done|started|began|broke ground|installed|built|paid|progress|fixed|delivered)\b/;

function kindFrom(topics, records) {
  if (topics.some((topic) => TRIP_WORDS.test(topic))) return "trip";
  if (topics.some((topic) => WORK_WORDS.test(topic) || topic === "project")) return "work";
  const titles = records.map((event) => String(event.title || "").toLowerCase()).join(" ");
  if (TRIP_WORDS.test(titles)) return "trip";
  if (WORK_WORDS.test(titles)) return "work";
  return null;
}


export function missing(kind, records, today) {
  const text = records.map(textOf).join(" ");
  const out = [];
  for (const [label, pattern] of CHECKS[kind] || []) {
    if (pattern) {
      if (!pattern.test(text)) out.push(label);
    } else if (label === "return date") {
      if (!records.some((event) => event.endsAt)) out.push(label);
    } else if (label === "budget" || label === "payments") {
      if (!records.some((event) => amountText(event.financials))) out.push(label);
    } else if (label === "start or finish date") {
      if (!records.some((event) => (event.occurredAt && event.occurredAt >= today) || event.dueAt || event.endsAt)) out.push(label);
    }
  }
  return out;
}

const sortKey = (item) => (item.precision === "month" ? Date.UTC(item.at.getUTCFullYear(), item.at.getUTCMonth() + 1, 0) : item.at.getTime());

const wordIn = (term, text) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(String(text || ""));

// [{ name, kind, records, next, progress, missing }] for the things the question asks about: one per name it
// gives ("Elmstead", "Quiet Harbour"), or one for its topic when it names nothing. A record belongs to a name when
// its title has the name; a trip question keeps only trip records.
export function timelineSubjects(question, events, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { names, topics } = subjectTerms(question);
  const tripAsked = topics.some((topic) => TRIP_WORDS.test(topic));
  // A trip question is about a trip ahead (or just under way), not one taken years ago.
  const recentEnough = (event) => !event.occurredAt || new Date(event.endsAt || event.occurredAt) >= new Date(today.getTime() - 30 * DAY_MS);
  const isTrip = (event) => TRIP_WORDS.test(String(event.title || "").toLowerCase()) && recentEnough(event);
  const groups = [];
  if (names.length) {
    for (const name of names) {
      let records = events.filter((event) => wordIn(name, event.title));
      if (tripAsked) records = events.filter((event) => isTrip(event) && (wordIn(name, event.title) || wordIn(name, event.understoodMeaning)));
      if (records.length) groups.push({ name, records });
    }
  }
  if (!groups.length && topics.length) {
    const records = events.filter((event) => topics.some((topic) => wordIn(topic, event.title)) || (tripAsked && isTrip(event)));
    if (records.length) groups.push({ name: [...names, ...topics].join(" "), records });
  }
  return groups.map((group) => {
    const kind = kindFrom(topics, group.records);
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const dated = group.records
      .flatMap((event) => [["starts", event.occurredAt, event.datePrecision], ["ends", event.endsAt, null], ["due", event.dueAt, null]]
        .filter(([, at, precision]) => at && new Date(at) >= (precision === "month" ? monthStart : today))
        .map(([what, at, precision]) => ({ event, what, at: new Date(at), precision })))
      // A month-only date ranks at the end of its month, so an exact day in that month comes first.
      .sort((a, b) => sortKey(a) - sortKey(b));
    const progress = group.records.filter((event) => PROGRESS.test(textOf(event)) && (!event.occurredAt || new Date(event.occurredAt) < today));
    const label = names.length && topics.length && groups.length === 1 ? `${group.name} ${topics.join(" ")}` : group.name;
    return { name: label, kind, records: group.records, next: dated[0] || null, progress, missing: kind ? missing(kind, group.records, today) : [], today };
  });
}

function recordLine(event) {
  const when = event.occurredAt ? formatDay(event.occurredAt, event.datePrecision) : "no date";
  const money = amountText(event.financials);
  return `${event.title} (${when}${money ? `, ${money}` : ""})`;
}

export function timelineAnswer(question, subjects) {
  if (!subjects.length) return "I found no records for that. Name the trip or project as you saved it, or save its dates first.";
  const blocks = subjects.slice(0, 3).map((subject) => {
    const title = subject.name.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
    const lines = [`${title}:`];
    if (subject.next) {
      const next = subject.next;
      const when = next.precision === "month"
        ? (whenText(next.at, subject.today, "month").startsWith("this month") ? `${formatDay(next.at, "month")}, this month (no day recorded)` : `${formatDay(next.at, "month")} (no day recorded)`)
        : `${formatDay(next.at)}, ${whenText(next.at, subject.today)}`;
      lines.push(`- Next date: ${next.event.title} ${next.what} ${when}.`);
    } else {
      lines.push("- No upcoming date recorded.");
    }
    const records = subject.records.slice(0, 6).map(recordLine);
    lines.push(`- Recorded (${subject.records.length}): ${records.join("; ")}${subject.records.length > 6 ? "; …" : ""}.`);
    lines.push(subject.progress.length ? `- Recorded progress: ${subject.progress.slice(0, 4).map((event) => event.title).join("; ")}.` : "- Recorded progress: none.");
    if (subject.missing.length) lines.push(`- Not recorded: ${subject.missing.join(", ")}.`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

export async function answerTimeline(userId, question) {
  const events = await prisma.event.findMany({
    where: { userId, status: { not: "archived" } },
    select: { id: true, title: true, understoodMeaning: true, rawInput: true, occurredAt: true, datePrecision: true, endsAt: true, dueAt: true, financials: true },
    orderBy: [{ occurredAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    take: 500,
  });
  const subjects = timelineSubjects(question, events);
  // Nothing on record matches ("how's it going?"): not a timeline question after all.
  if (!subjects.length) return null;
  return { reply: timelineAnswer(question, subjects), count: subjects.reduce((sum, subject) => sum + subject.records.length, 0) };
}
