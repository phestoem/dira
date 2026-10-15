import { prisma } from "../../prisma.js";
import { normalizeName } from "./entityResolver.js";
import { getFamilyTree } from "./graphQuery.js";

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STOP_NAME = new Set(["your", "his", "her", "their", "the", "you", "and", "born", "married", "spouse", "children", "child", "father", "mother", "sisters", "sister", "wife", "husband"]);

export const PEOPLE_PROMPT = `FACTS ABOUT PEOPLE — absolute rule:
Never state a name, date, relationship or place about a person unless it appears in the provided context.
If something isn't recorded, say "not recorded yet".
Suggested edges may be mentioned only as "unconfirmed: …", never as fact.
Every fact below is prefixed with its source id.
Return JSON only: {"answer":"...","sourceIds":["entity:id","edge:id","event:id"]}`;

export function isPeopleQuestion(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/\b(my|our)\s+(sisters|brothers|children|sons|daughters|wife|husband|father|mother)\s+(are|is)\b/i.test(value)) return false;
  if (/\b(family tree|who is|who's|who are|how old|birthdays?|birth dates?|relatives)\b/i.test(value)) return true;
  if (/[?]/.test(value) && /\b(my|our)\s+(parents|wife|husband|father|mother|sisters|brothers|children)\b/i.test(value)) return true;
  return /\b(my|our)\s+\w+'s\s+(family|spouse|wife|husband|children|parents|sisters|brothers|birthday|age)\b/i.test(value);
}

export async function loadPeopleContext(userId) {
  const tree = await getFamilyTree(userId);
  const [edges, events] = await Promise.all([
    prisma.relationship.findMany({
      where: { userId, category: "family", status: { in: ["confirmed", "suggested"] } },
    }),
    prisma.event.findMany({
      where: { userId, status: { not: "archived" } },
      select: { id: true, title: true, understoodMeaning: true, fullText: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);
  const people = peopleFromTree(tree);
  const namedEdges = edges.map((edge) => ({
    id: edge.id,
    type: edge.type,
    status: edge.status,
    fromId: edge.fromId,
    toId: edge.toId,
    fromName: people.find((person) => person.id === edge.fromId)?.name || "",
    toName: people.find((person) => person.id === edge.toId)?.name || "",
  }));
  return buildPeopleContext({ self: tree.self, people, edges: namedEdges, events });
}

export function buildPeopleContext({ self, people = [], edges = [], events = [] } = {}) {
  const roster = people.filter((person) => person?.name);
  const allowedNames = roster.map((person) => person.name);
  const allowedDates = new Set();
  const facts = [];
  for (const person of roster) {
    const bits = [person.name];
    if (person.kind && person.kind !== "self") bits.push(person.kind);
    if (person.birthDate) {
      const iso = normalizeDate(person.birthDate);
      if (iso) {
        allowedDates.add(iso);
        bits.push(`birthDate ${iso}`);
      }
    }
    if (person.deathDate) {
      const iso = normalizeDate(person.deathDate);
      if (iso) {
        allowedDates.add(iso);
        bits.push(`deathDate ${iso}`);
      }
    }
    facts.push({ text: bits.join(" | "), source: { type: "entity", id: person.id } });
  }
  const confirmed = edges.filter((edge) => edge.status !== "suggested");
  const suggested = edges.filter((edge) => edge.status === "suggested");
  for (const edge of confirmed) {
    facts.push({
      text: `${edge.fromName || edge.fromId} ${edge.type} ${edge.toName || edge.toId}`,
      source: { type: "edge", id: edge.id },
    });
  }
  const records = recordedFromEvents(events, roster);
  const eventFacts = [];
  for (const record of records) {
    if (record.name) allowedNames.push(record.name);
    for (const iso of [record.birthDate, record.deathDate, record.marriageDate]) {
      if (iso) allowedDates.add(iso);
    }
    if (record.birthDate || record.deathDate) {
      eventFacts.push({
        personName: record.name,
        entityId: record.personId,
        field: record.deathDate && !record.birthDate ? "deathDate" : "birthDate",
        value: record.birthDate || record.deathDate,
        sources: [`event:${record.eventId}`],
      });
    }
    const bits = [record.name, record.kind].filter(Boolean);
    if (record.birthDate) bits.push(`birthDate ${record.birthDate}`);
    if (record.deathDate) bits.push(`deathDate ${record.deathDate}`);
    if (record.marriageDate) bits.push(`marriageDate ${record.marriageDate}`);
    facts.push({ text: bits.join(" | "), source: { type: "event", id: record.eventId } });
  }
  for (const edge of suggested) {
    facts.push({
      text: `unconfirmed: ${edge.fromName || edge.fromId} ${edge.type} ${edge.toName || edge.toId}`,
      source: { type: "edge", id: edge.id },
    });
  }
  return {
    self,
    people: roster,
    edges: confirmed,
    suggested,
    facts,
    records,
    eventFacts,
    allowedNames,
    allowedDates,
    conflicts: factConflicts(roster, eventFacts),
  };
}

export function peopleContextBlock(context) {
  return (context?.facts || []).map((fact) => `${fact.source.type}:${fact.source.id} | ${fact.text}`).join("\n");
}

export function usesRecordedAnswer(question) {
  const q = String(question || "");
  if (/\bfamily tree\b/i.test(q)) return true;
  if (/\b(wife|husband)\b/i.test(q)) return true;
  if (/\bparents?\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return true;
  if (/\bsisters?\b/i.test(q) && /\bbirth/i.test(q)) return true;
  return false;
}

export function answerPeopleQuestion(question, context) {
  const q = String(question || "");
  if (/\b(wife|husband)\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return spouseAnswer(q, context);
  if (/\bparents?\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return parentsAnswer(context);
  if (/\bsisters?\b/i.test(q) && /\bbirth/i.test(q)) return sisterBirthAnswer(context);
  const people = context?.people || [];
  const father = people.find((person) => person.kind === "father");
  const mother = people.find((person) => person.kind === "mother");
  const spouse = people.find((person) => person.kind === "wife" || person.kind === "husband");
  const sisters = people.filter((person) => person.kind === "sister");
  const lines = [];
  if (/\bfather\b/i.test(question || "") && father) {
    lines.push(`${father.name} — your father${passed(father)}.`);
    lines.push(mother ? `Your father's spouse: ${mother.name}.` : "Your father's spouse isn't recorded yet.");
  } else if (father) {
    lines.push(`${father.name} — your father${passed(father)}.`);
  }
  if (mother && !lines.some((line) => line.includes(mother.name))) lines.push(`${mother.name} — your mother.`);
  if (sisters.length) {
    lines.push(`Your sisters: ${sisters.map((person) => person.name).join(", ")}.`);
    const dated = sisters.filter((person) => birthOf(person, context));
    if (!dated.length) lines.push("Your sisters' birth dates aren't recorded yet.");
    else lines.push(dated.map((person) => `${person.name} — ${prettyDate(birthOf(person, context).iso)}`).join("\n"));
  }
  if (spouse) lines.push(`${spouse.name} — your ${spouse.kind}.`);
  for (const conflict of context?.conflicts || []) {
    const label = context.self && conflict.entityId === context.self.id ? "Your birth date" : `${conflict.name}'s birth date`;
    lines.push(`${label} is recorded as both ${conflict.values.map(prettyDate).join(" and ")}. Which is right?`);
  }
  for (const edge of context?.suggested || []) {
    const other = edge.fromId === context.self?.id ? edge.toName : edge.fromName;
    if (other) lines.push(`unconfirmed: ${other} — ${suggestedPhrase(edge)}`);
  }
  return lines.filter(Boolean).join("\n");
}

export function parseAdvisorPayload(text) {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      if (parsed && typeof parsed.answer === "string") {
        return { answer: parsed.answer, sourceIds: Array.isArray(parsed.sourceIds) ? parsed.sourceIds.map(String) : [] };
      }
    } catch {
      /* The model answered in prose. */
    }
  }
  return { answer: raw, sourceIds: [] };
}

export function groundAdvisorReply(reply, context) {
  const removed = [];
  const sentences = String(reply || "").split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim());
  const kept = [];
  for (const sentence of sentences) {
    const badNames = namesIn(maskDates(sentence)).filter((name) => !nameAllowed(name, context?.allowedNames || []));
    if (badNames.length) {
      for (const name of badNames) noteRemoved(removed, name);
      continue;
    }
    let next = sentence;
    for (const date of datesIn(sentence)) {
      if (!dateAllowed(date, context?.allowedDates)) {
        noteRemoved(removed, date);
        next = next.replace(date, "not recorded");
      }
    }
    kept.push(next);
  }
  return { reply: kept.join(" ").replace(/\s+/g, " ").trim(), removed };
}

export function deliverPeopleAnswer(modelText, context, question) {
  const parsed = parseAdvisorPayload(modelText);
  const checked = groundAdvisorReply(parsed.answer, context);
  const recorded = answerPeopleQuestion(question, context);
  const familyTree = /\bfamily tree\b/i.test(question || "");
  const modelMissed = /\b(not recorded|isn't recorded|aren't recorded)\b/i.test(checked.reply)
    && !/\b(not recorded|isn't recorded|aren't recorded)\b/i.test(recorded);
  const reply = familyTree || checked.removed.length || modelMissed ? recorded : checked.reply;
  return { reply, removed: checked.removed, sourceIds: parsed.sourceIds.filter((id) => knownSource(id, context)) };
}

export function conflictEdgeData(userId, conflict) {
  return {
    userId,
    fromKind: "entity",
    fromId: conflict.entityId,
    toKind: "entity",
    toId: conflict.entityId,
    type: "related_to",
    category: "other",
    status: "suggested",
    source: "inferred",
    confidence: 0.4,
    label: "conflict",
    attributes: {
      conflictWith: conflict.field,
      values: conflict.values,
      name: conflict.name,
      sources: conflict.sources,
    },
    evidenceText: `Records disagree: ${conflict.name} ${conflict.field} ${conflict.values.join(" vs ")}. Which is right?`,
  };
}

export async function persistConflicts(userId, conflicts) {
  for (const conflict of conflicts || []) {
    if (!conflict?.entityId) continue;
    const existing = await prisma.relationship.findFirst({
      where: { userId, fromId: conflict.entityId, toId: conflict.entityId, type: "related_to", label: "conflict", status: { not: "rejected" } },
    });
    if (existing) continue;
    await prisma.relationship.create({ data: conflictEdgeData(userId, conflict) }).catch(() => null);
  }
}

function peopleFromTree(tree) {
  const rows = [];
  const push = (person, kind) => {
    if (!person?.id || rows.some((row) => row.id === person.id)) return;
    rows.push({ ...person, kind: person.kind || kind || null });
  };
  push(tree?.self, "self");
  for (const person of tree?.parents || []) push(person, "parent");
  for (const person of tree?.siblings || []) push(person, "sibling");
  for (const person of tree?.spouse || []) push(person, "spouse");
  for (const person of tree?.children || []) push(person, "child");
  return rows;
}

const RECORD_LINE = "From your records — confirm in Review to lock it in.";
const NAME = "[\\p{Lu}][\\p{L}'’\\-]+(?:\\s+[\\p{Lu}][\\p{L}'’\\-]+){0,3}";
const SPOKEN = `\\d{1,2}\\s+(?:${Object.keys(MONTHS).map((month) => `${month[0].toUpperCase()}${month.slice(1)}|${month}`).join("|")})\\s+\\d{4}`;

function spouseAnswer(question, context) {
  const confirmed = (context?.people || []).find((person) => person.kind === "wife" || person.kind === "husband");
  if (confirmed) return `${confirmed.name} — your ${confirmed.kind}.`;
  const record = spouseRecord(context);
  if (!record) return "Your spouse isn't recorded yet.";
  const word = /\bhusband\b/i.test(question) && !/\bwife\b/i.test(question) ? "husband" : "wife";
  const married = record.marriageDate ? ` (married ${prettyDate(record.marriageDate)})` : "";
  return `${record.name} — your ${word}${married}.\n${RECORD_LINE}`;
}

function spouseRecord(context) {
  const hits = (context?.records || []).filter((item) => item.kind === "wife" || item.kind === "husband" || item.kind === "spouse");
  if (!hits.length) return null;
  return hits.reduce((best, item) => ({
    name: String(item.name || "").length > String(best.name || "").length ? item.name : best.name,
    kind: best.kind && best.kind !== "spouse" ? best.kind : (item.kind || best.kind),
    marriageDate: best.marriageDate || item.marriageDate,
  }));
}

function parentsAnswer(context) {
  const lines = [];
  let fromEvent = false;
  for (const kind of ["father", "mother"]) {
    const confirmed = (context?.people || []).find((person) => person.kind === kind);
    const record = (context?.records || []).find((item) => item.kind === kind);
    const person = confirmed || record;
    if (!person) continue;
    if (!confirmed) fromEvent = true;
    const death = confirmed?.deathDate || record?.deathDate;
    lines.push(`${(confirmed || record).name} — your ${kind}${passed({ deathDate: death })}.`);
  }
  if (!lines.length) return "Your parents aren't recorded yet.";
  if (fromEvent) lines.push(RECORD_LINE);
  return lines.join("\n");
}

function sisterBirthAnswer(context) {
  const sisters = (context?.people || []).filter((person) => person.kind === "sister" || person.kind === "sibling");
  const lines = [];
  let fromEvent = false;
  for (const sister of sisters) {
    const found = birthOf(sister, context);
    if (!found) continue;
    if (found.fromEvent) fromEvent = true;
    lines.push(`${sister.name} — ${prettyDate(found.iso)}`);
  }
  if (!lines.length) return "Your sisters' birth dates aren't recorded yet.";
  if (fromEvent) lines.push(RECORD_LINE);
  return lines.join("\n");
}

function birthOf(person, context) {
  const own = normalizeDate(person?.birthDate);
  if (own) return { iso: own, fromEvent: false };
  const record = (context?.records || []).find((item) => item.birthDate && namesMatch(item.name, person?.name));
  return record ? { iso: record.birthDate, fromEvent: true } : null;
}

function recordedFromEvents(events, people) {
  const records = [];
  for (const event of events || []) {
    const text = [event?.title, event?.understoodMeaning, event?.fullText].filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    collectKinship(text, event.id, people, records);
    collectDatedNames(text, event.id, people, records);
  }
  return records;
}

function collectKinship(text, eventId, people, records) {
  const patterns = [
    { re: new RegExp(`\\b(?:[Mm]y|[Oo]ur)\\s+(wife|husband)\\s+(?:[Ii]s\\s+)?(${NAME})`, "gu"), kind: (match) => match[1].toLowerCase() },
    { re: new RegExp(`\\b(?:[Mm]arriage|[Mm]arried|[Ee]ngagement)\\s+to\\s+(${NAME})`, "gu"), kind: () => "spouse" },
    { re: new RegExp(`\\b(?:[Mm]y|[Oo]ur)\\s+(father|mother|mum|mom|dad|mama|baba)\\s+(?:[Ii]s\\s+)?(${NAME})`, "gu"), kind: (match) => parentKind(match[1]) },
    { re: new RegExp(`\\b(mke|mume)\\s+wangu(?:\\s+ni)?\\s+(${NAME})`, "gu"), kind: (match) => (match[1].toLowerCase() === "mke" ? "wife" : "husband") },
    { re: new RegExp(`\\b(baba|mama)\\s+yangu(?:\\s+ni)?\\s+(${NAME})`, "gu"), kind: (match) => (match[1].toLowerCase() === "mama" ? "mother" : "father") },
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.re)) {
      const raw = match[match.length - 1];
      const resolved = resolveRecord(raw, people);
      if (!resolved) continue;
      const window = text.slice(match.index, match.index + match[0].length + 80);
      const death = /\b(passed away|died|death)\b/i.test(window) ? spokenDate(window) : null;
      const kind = pattern.kind(match);
      const marriage = kind === "spouse" || kind === "wife" || kind === "husband" ? spokenDate(window) : null;
      mergeRecord(records, { ...resolved, kind, eventId, birthDate: null, deathDate: death, marriageDate: marriage && !death ? marriage : null });
    }
  }
}

function collectDatedNames(text, eventId, people, records) {
  const born = new RegExp(`\\b(${NAME})\\s+(?:[Ww]as\\s+)?[Bb]orn(?:\\s+[Oo]n)?\\s+(${SPOKEN})`, "gu");
  const listed = new RegExp(`\\b(${NAME})\\s+(${SPOKEN})`, "gu");
  const died = new RegExp(`\\b(${NAME})\\b[^.!?]{0,80}?\\b(?:[Pp]assed away|[Dd]ied)\\s+[Oo]n\\s+(${SPOKEN})`, "gu");
  for (const match of text.matchAll(born)) addDate(records, people, match[1], eventId, { birthDate: spokenDate(match[2]) });
  for (const match of text.matchAll(listed)) {
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    if (/\b(marriage|married|engagement|passed away|died)\b/i.test(before)) continue;
    addDate(records, people, match[1], eventId, { birthDate: spokenDate(match[2]) });
  }
  for (const match of text.matchAll(died)) addDate(records, people, match[1], eventId, { deathDate: spokenDate(match[2]) });
}

function addDate(records, people, raw, eventId, dates) {
  const resolved = resolveRecord(raw, people);
  if (!resolved) return;
  mergeRecord(records, { ...resolved, kind: null, eventId, birthDate: dates.birthDate || null, deathDate: dates.deathDate || null, marriageDate: null });
}

function mergeRecord(records, claim) {
  const existing = records.find((item) => namesMatch(item.name, claim.name) && item.eventId === claim.eventId);
  if (!existing) {
    records.push({ ...claim });
    return;
  }
  if (String(claim.name).length > String(existing.name).length) existing.name = claim.name;
  existing.personId = existing.personId || claim.personId || null;
  existing.birthDate = existing.birthDate || claim.birthDate;
  existing.deathDate = existing.deathDate || claim.deathDate;
  existing.marriageDate = existing.marriageDate || claim.marriageDate;
  if (claim.kind && (!existing.kind || existing.kind === "spouse")) existing.kind = claim.kind;
}

function resolveRecordName(name, people) {
  return resolveRecord(name, people)?.name || "";
}

function resolveRecord(name, people) {
  const cleaned = properWords(name);
  if (!cleaned) return null;
  const exact = (people || []).find((person) => normalizeName(person.name) === normalizeName(cleaned));
  if (exact) return { name: exact.name, personId: exact.id };
  const first = normalizeName(cleaned).split(" ")[0];
  const hits = (people || []).filter((person) => normalizeName(person.name).split(" ")[0] === first);
  if (hits.length === 1) return { name: hits[0].name, personId: hits[0].id };
  return { name: cleaned, personId: null };
}

function properWords(name) {
  const kept = [];
  for (const word of String(name || "").replace(/^(my|our)\s+/i, "").trim().split(/\s+/)) {
    if (!word || !/^[\p{Lu}][\p{L}'’\-]*$/u.test(word)) break;
    if (/^(my|our|the|was|born|on)$/i.test(word)) break;
    kept.push(word);
  }
  return kept.join(" ");
}

function namesMatch(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

function parentKind(word) {
  return ["mother", "mum", "mama"].includes(String(word || "").toLowerCase()) ? "mother" : "father";
}

function spokenDate(text) {
  const match = String(text || "").match(new RegExp(SPOKEN, "i"));
  return match ? normalizeDate(match[0]) : null;
}

function factConflicts(people, eventFacts) {
  const groups = new Map();
  for (const fact of eventFacts) {
    const key = `${fact.entityId || fact.personName}:${fact.field}`;
    const group = groups.get(key) || { entityId: fact.entityId, name: fact.personName, field: fact.field, values: [], sources: [] };
    if (!group.values.includes(fact.value)) group.values.push(fact.value);
    for (const source of fact.sources || []) if (!group.sources.includes(source)) group.sources.push(source);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.values.length > 1)
    .map((group) => ({ ...group, values: group.values.slice().sort() }));
}

function namesIn(text) {
  const found = [];
  for (const match of String(text || "").matchAll(/\b[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){0,3}\b/gu)) {
    const parts = match[0].split(/\s+/).filter((part) => !STOP_NAME.has(part.toLowerCase()) && !/^[\p{Lu}]'?s$/u.test(part));
    if (parts.length) found.push(parts.join(" "));
  }
  return found;
}

function nameAllowed(candidate, allowed) {
  const cand = candidate.toLowerCase();
  if (!cand || STOP_NAME.has(cand)) return true;
  return allowed.some((name) => {
    const full = String(name || "").toLowerCase();
    if (!full) return false;
    if (full === cand || full.startsWith(`${cand} `) || cand.startsWith(`${full} `)) return true;
    const left = cand.split(" ");
    const right = full.split(" ");
    return left.length >= 2 && left[0] === right[0] && left[left.length - 1] === right[right.length - 1];
  });
}

function datesIn(text) {
  const value = String(text || "");
  const found = [];
  const pattern = /\b(?:\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{4}|(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2},?\s+\d{4}|\d{4})\b/gi;
  for (const match of value.matchAll(pattern)) found.push(match[0]);
  return found;
}

function maskDates(text) {
  return datesIn(text).reduce((current, date) => current.replace(date, " "), text);
}

function dateAllowed(raw, allowed) {
  const iso = normalizeDate(raw);
  if (!iso || !allowed) return false;
  if (allowed.has(iso)) return true;
  if (/^\d{4}$/.test(iso)) {
    for (const known of allowed) if (known.startsWith(`${iso}-`)) return true;
  }
  return false;
}

function normalizeDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value || "").trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  let match = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (match && MONTHS[match[2].toLowerCase()]) return `${match[3]}-${pad(MONTHS[match[2].toLowerCase()])}-${pad(match[1])}`;
  match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match && MONTHS[match[1].toLowerCase()]) return `${match[3]}-${pad(MONTHS[match[1].toLowerCase()])}-${pad(match[2])}`;
  if (/^\d{4}$/.test(text)) return text;
  return null;
}

function prettyDate(iso) {
  const match = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return iso;
  return `${Number(match[3])} ${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}`;
}

function passed(person) {
  const iso = normalizeDate(person?.deathDate);
  return iso ? ` (passed ${prettyDate(iso)})` : "";
}

function suggestedPhrase(edge) {
  if (edge.type === "sibling_of") return "your sibling";
  if (edge.type === "spouse_of") return "your spouse";
  if (edge.type === "parent_of") return "related";
  return String(edge.type || "related").replaceAll("_", " ");
}

function knownSource(id, context) {
  return (context?.facts || []).some((fact) => `${fact.source.type}:${fact.source.id}` === id);
}

function noteRemoved(removed, claim) {
  if (removed.includes(claim)) return;
  removed.push(claim);
  console.log(`[advisor] removed unsupported claim: "${claim}"`);
}

function pad(value) {
  return String(value).padStart(2, "0");
}
