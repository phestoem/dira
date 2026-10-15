import { prisma } from "../../prisma.js";
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
  if (/\b(family tree|who is|who's|who are|how old|birthdays?|birth date|relatives)\b/i.test(value)) return true;
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
  const eventFacts = [];
  for (const event of events) {
    for (const found of explicitDates(event, roster)) {
      allowedDates.add(found.value);
      eventFacts.push(found);
      facts.push({
        text: `${found.personName} ${found.field} ${found.value}`,
        source: { type: "event", id: event.id },
      });
    }
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
    eventFacts,
    allowedNames,
    allowedDates,
    conflicts: factConflicts(roster, eventFacts),
  };
}

export function peopleContextBlock(context) {
  return (context?.facts || []).map((fact) => `${fact.source.type}:${fact.source.id} | ${fact.text}`).join("\n");
}

export function answerPeopleQuestion(question, context) {
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
    if (sisters.every((person) => !person.birthDate)) lines.push("Your sisters' birth dates aren't recorded yet.");
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
  const familyTree = /\bfamily tree\b/i.test(question || "");
  const reply = familyTree || checked.removed.length ? answerPeopleQuestion(question, context) : checked.reply;
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

function explicitDates(event, people) {
  const text = [event?.title, event?.understoodMeaning, event?.fullText].filter(Boolean).join("\n");
  if (!text || !/\b(born|birth|died|passed|death)\b/i.test(text)) return [];
  const field = /\b(died|passed away|death)\b/i.test(text) && !/\b(born|birth)\b/i.test(text) ? "deathDate" : "birthDate";
  const dates = datesIn(text).map(normalizeDate).filter(Boolean);
  const found = [];
  const claimed = [];
  const hits = people
    .map((person) => ({ person, index: text.toLowerCase().indexOf(String(person.name || "").toLowerCase()) }))
    .filter((hit) => hit.index >= 0 && mentionsPerson(text, hit.person.name))
    .sort((left, right) => right.person.name.length - left.person.name.length);
  for (const hit of hits) {
    const start = hit.index;
    const end = start + hit.person.name.length;
    if (claimed.some((span) => start >= span.start && end <= span.end)) continue;
    claimed.push({ start, end });
    for (const value of dates) found.push({ personName: hit.person.name, entityId: hit.person.id, field, value, sources: [`event:${event.id}`] });
  }
  return found;
}

function mentionsPerson(text, name) {
  const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

function factConflicts(people, eventFacts) {
  const groups = new Map();
  for (const fact of eventFacts) {
    const key = `${fact.entityId}:${fact.field}`;
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
