import { prisma } from "../../prisma.js";
import { isReadonly } from "../../readonly.js";
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
  // "My sisters' birthdays: Jeni was born on 4 December 1980, …" tells; it doesn't ask.
  if (!value.includes("?") && !/^(?:please\s+)?(?:who|what|when|where|which|how|list|show|name|tell|give|remind|do|does|did|is|are)\b/i.test(value) && /\b(born|married|died|passed away)\b/i.test(value)) return false;
  if (/\b(family tree|who is|who's|who are|how old|birthdays?|birth dates?|relatives)\b/i.test(value)) return true;
  if (/\bhow many\b/i.test(value) && /\b(kids|children|sons|daughters|sisters|brothers)\b/i.test(value)) return true;
  if (/\b(children|kids|sisters|brothers|parents)'?s?\s+names\b/i.test(value)) return true;
  if (/^(?:please\s+)?(?:list|show|name|tell me|give me|remind me of)\b/i.test(value) && /\b(my|our)\s+(parents|wife|husband|spouse|father|mother|sisters|brothers|siblings|children|kids|sons|daughters|family)\b/i.test(value)) return true;
  if (/[?]/.test(value) && /\b(my|our)\s+(parents|wife|husband|father|mother|sisters|brothers|children|kids)\b/i.test(value)) return true;
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
      select: { id: true, title: true, understoodMeaning: true, fullText: true, rawInput: true, notes: true },
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
  refineKinds(roster, records);
  const eventFacts = [];
  for (const record of records) {
    if (!record.name) continue;
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

export function resolvePeopleFollowUp(latest, prior) {
  const question = String(latest || "");
  const previous = String(prior || "");
  if (/\band (?:his|her|their) family\b/i.test(question)) {
    if (/\b(father|dad|baba)\b/i.test(previous)) return "my father's family tree";
    if (/\b(mother|mum|mama)\b/i.test(previous)) return "my mother's family tree";
    return "family tree";
  }
  if (!/\b(their names|who are they|what are they called)\b/i.test(question)) return question;
  if (/\b(kids|children|sons|daughters)\b/i.test(previous)) return "what are my children's names?";
  if (/\bsisters?\b/i.test(previous)) return "who are my sisters?";
  if (/\bbrothers?\b/i.test(previous)) return "who are my brothers?";
  if (/\bparents?\b/i.test(previous)) return "who are my parents?";
  if (/\b(father|dad|baba)\b/i.test(previous)) return "who is my father?";
  if (/\b(mother|mum|mama)\b/i.test(previous)) return "who is my mother?";
  return question;
}

export function contextualQuestion(latest, priorUser, priorAnswer) {
  const question = resolvePeopleFollowUp(latest, priorUser);
  const answer = String(priorAnswer || "").trim();
  if (!answer || !/\b(their names|who are they|what are they called|and (?:his|her|their) family)\b/i.test(String(latest || ""))) return question;
  return `${question}\n\nPrevious answer: ${answer}`;
}

export function usesRecordedAnswer(question) {
  const q = String(question || "");
  if (/\bfamily tree\b/i.test(q)) return true;
  if (/\b(wife|husband|spouse)\b/i.test(q)) return true;
  if (/\b(father|mother|dad|mum|baba|mama|parents?)\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return true;
  if (/\b(sisters?|brothers?|siblings?)\b/i.test(q)) return true;
  if (/\b(kids|children|sons|daughters)\b/i.test(q)) return true;
  return false;
}

export function answerPeopleQuestion(question, context) {
  const q = String(question || "");
  if (/\bfamily tree\b/i.test(q) && !/\b(father|mother)'s\b/i.test(q)) return familyTreeAnswer(context);
  if (/\b(wife|husband|spouse)\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return spouseAnswer(q, context);
  if (/\bparents?\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return parentsAnswer(context);
  if (/\b(father|dad|baba)\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return parentRoleAnswer("father", context);
  if (/\b(mother|mum|mama)\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return parentRoleAnswer("mother", context);
  if (/\b(kids|children|sons|daughters)\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return childrenAnswer(q, context);
  if (/\b(sisters?|brothers?|siblings?)\b/i.test(q) && /\b(born|birth|birthdays?)\b/i.test(q)) return siblingBirthAnswer(q, context);
  if (/\b(sisters?|brothers?|siblings?)\b/i.test(q) && !/\bfamily tree\b/i.test(q)) return siblingAnswer(q, context);
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
  const reply = recorded.trim() && (familyTree || checked.removed.length || modelMissed) ? recorded : (checked.reply || recorded);
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
  if (isReadonly()) return;
  for (const conflict of conflicts || []) {
    if (!conflict?.entityId) continue;
    const existing = await prisma.relationship.findFirst({
      where: { userId, fromId: conflict.entityId, toId: conflict.entityId, type: "related_to", label: "conflict", status: { not: "rejected" } },
    });
    if (existing) continue;
    await prisma.relationship.create({ data: conflictEdgeData(userId, conflict) }).catch(() => null);
  }
}

// The tree says where someone sits (parent, sibling, spouse, child). A specific kinship
// word on the entity refines that; a generic entity kind like "person" never replaces it.
const ROLE_KINDS = {
  parent: ["father", "mother"],
  sibling: ["sister", "brother"],
  spouse: ["wife", "husband"],
  child: ["son", "daughter"],
};

export function peopleFromTree(tree) {
  const rows = [];
  const push = (person, role) => {
    if (!person?.id || rows.some((row) => row.id === person.id)) return;
    const own = String(person.kind || "").toLowerCase();
    const kind = role === "self" ? "self" : (ROLE_KINDS[role]?.includes(own) ? own : role);
    rows.push({ ...person, kind, role });
  };
  push(tree?.self, "self");
  for (const person of tree?.parents || []) push(person, "parent");
  for (const person of tree?.siblings || []) push(person, "sibling");
  for (const person of tree?.spouse || []) push(person, "spouse");
  for (const person of tree?.children || []) push(person, "child");
  return rows;
}

// Event wording can say "my sister Jeni" where the edge only says sibling_of.
function refineKinds(people, records) {
  for (const person of people) {
    const choices = ROLE_KINDS[person.role];
    if (!choices || choices.includes(person.kind)) continue;
    const named = records.find((item) => choices.includes(item.kind) && samePerson(item, person));
    if (named) person.kind = named.kind;
  }
}

const RECORD_LINE = "From your records — confirm in Review to lock it in.";
// "Prisha - Neema" is one name; reading it as "Neema" would hand the date to a sister.
const NAME = "[\\p{Lu}][\\p{L}'’\\-]+(?:(?:\\s+[-–]\\s+|\\s+)[\\p{Lu}][\\p{L}'’\\-]+){0,3}";
const MONTH_WORDS = Object.keys(MONTHS).sort((a, b) => b.length - a.length).map(anyCase).join("|");
const DAY = "\\d{1,2}(?:st|nd|rd|th)?";
// "3 February 1993", "25th of April 1977", "February 3rd, 1993", "Feb 17th 1978", "2006-08-05".
const DATE = `(?:${DAY}\\s+(?:of\\s+)?(?:${MONTH_WORDS})\\.?,?\\s+\\d{4}|(?:${MONTH_WORDS})\\.?\\s+${DAY},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`;
const DATE_RE = new RegExp(DATE, "gi");
const KIN_WORDS = {
  father: "father", dad: "father", baba: "father", fadher: "father",
  mother: "mother", mum: "mother", mom: "mother", mama: "mother",
  sister: "sister", brother: "brother", son: "son", daughter: "daughter",
  wife: "wife", husband: "husband", fiance: "spouse", "fiancé": "spouse", fiancee: "spouse", "fiancée": "spouse",
};
const KIN = `(?:${Object.keys(KIN_WORDS).map(anyCase).join("|")})`;
const ORDER = "(?:(?:older|elder|eldest|oldest|younger|youngest|little|big|baby|first|second|third|fourth|fifth|last|first-born|firstborn|only)\\s+)";
const LIST_ROLE = { children: "child", kids: "child", sons: "son", daughters: "daughter", sisters: "sister", brothers: "brother", siblings: "sibling" };
const NOT_NAME = new Set([
  "i", "me", "my", "our", "your", "you", "he", "she", "his", "her", "their", "they", "we", "it", "the", "a", "an", "on", "in", "at",
  "and", "then", "followed", "birth", "born", "title", "date", "certificate", "user", "speaker", "family", "information", "profile",
  ...Object.keys(MONTHS),
]);

function recordedFromEvents(events, people) {
  const records = [];
  for (const event of events || []) {
    const text = [event?.title, event?.understoodMeaning, event?.fullText, event?.rawInput, event?.notes].filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    // One sentence at a time, so a date is never borrowed from the next fact.
    for (const sentence of text.split(/(?<=[.!?])\s+(?=[\p{Lu}\d])/u)) {
      collectKinship(sentence, event.id, people, records);
      collectLists(sentence, event.id, people, records);
      collectDatedNames(sentence, event.id, people, records);
      collectMarriage(sentence, event.id, people, records);
    }
  }
  return records;
}

function collectKinship(text, eventId, people, records) {
  const add = (raw, kind) => {
    const resolved = resolveRecord(raw, people);
    if (resolved) mergeRecord(records, { ...resolved, kind, eventId, birthDate: null, deathDate: null, marriageDate: null });
  };
  // "my sister Jeni", "our second son Presley", "the older son, Patrick", "your father Enock", "my wife is Zelda"
  // Without my/our/your/the, only the "son, Patrick" form counts; "her mother Emmiliana" is someone else's.
  const before = new RegExp(`(\\b(?:[Mm]y|[Oo]ur|[Yy]our|[Tt]he)\\s+)?${ORDER}?\\b(${KIN})\\b(,?)\\s+(?:(?:is|was|named|called)\\s+)?(${NAME})`, "gu");
  for (const match of text.matchAll(before)) {
    if (!match[1] && !match[3]) continue;
    add(match[4], KIN_WORDS[match[2].toLowerCase()]);
  }
  // "Careen is my eldest daughter", "Powell is our third son"
  for (const match of text.matchAll(new RegExp(`(${NAME})\\s+is\\s+(?:my|our|your)\\s+${ORDER}?(${KIN})\\b`, "gu"))) {
    add(match[1], KIN_WORDS[match[2].toLowerCase()]);
  }
  // "I am the father of Careen", "The speaker is the father of Careen"
  for (const match of text.matchAll(new RegExp(`\\b(?:I am|I'm|[Tt]he speaker is|[Uu]ser is)\\s+the\\s+(?:father|mother|parent)\\s+of\\s+(${NAME})`, "gu"))) {
    add(match[1], "child");
  }
  // "Froidah Biniala Kyando … married to my father"
  const partner = text.match(/\bmarried to (?:my|our|your) (father|mother|dad|mum|mom)\b/i);
  if (partner) {
    const first = candidateNames(text.slice(0, partner.index)).find((name) => resolveRecord(name, people));
    if (first) add(first, parentKind(partner[1]) === "father" ? "mother" : "father");
  }
  // Swahili: "mke wangu ni Zelda", "baba yangu ni Enock"
  for (const match of text.matchAll(new RegExp(`\\b(mke|mume|baba|mama)\\s+(?:wangu|yangu)(?:\\s+ni)?\\s+(${NAME})`, "gu"))) {
    add(match[2], { mke: "wife", mume: "husband", baba: "father", mama: "mother" }[match[1].toLowerCase()]);
  }
}

// "I have four sisters: Jeni, Leah, Neema and Zenah", "my children are …", "You have sisters Jeni, Leah …"
function collectLists(text, eventId, people, records) {
  const lists = [
    new RegExp(`\\b(?:[Mm]y|[Oo]ur|[Yy]our)\\s+(?:\\w+\\s+)?(children|kids|sons|daughters|sisters|brothers|siblings)\\s+(?:are|include)\\s+(.+)$`, "u"),
    new RegExp(`\\b(?:I|[Ww]e|[Yy]ou)\\s+have\\s+(?:\\w+\\s+)?(children|kids|sons|daughters|sisters|brothers|siblings)\\s*(?::|,|-|—|named|called)?\\s*(.+)$`, "u"),
  ];
  for (const pattern of lists) {
    const match = text.match(pattern);
    if (!match) continue;
    for (const name of splitNameList(match[2])) {
      const resolved = resolveRecord(name, people);
      if (resolved) mergeRecord(records, { ...resolved, kind: LIST_ROLE[match[1].toLowerCase()], eventId, birthDate: null, deathDate: null, marriageDate: null });
    }
  }
}

function splitNameList(text) {
  return String(text || "")
    .replace(/\([^)]*\)/g, " ")
    .split(/,|;|\band\b/i)
    .map((part) => properWords(part))
    .filter(Boolean);
}

function collectDatedNames(text, eventId, people, records) {
  const aboutBirth = /\b(born|birth|birthdays?|welcomed)\b/i.test(text);
  if (aboutBirth) {
    // "Zenah … was born on February 3rd, 1993", "Patrick was born in Helsinki on September 25, 2008", "Powell, born on 30 May 2015"
    for (const match of text.matchAll(new RegExp(`(${NAME}),?\\s+(?:was\\s+)?born\\b[^.!?]{0,60}?(${DATE})`, "gu"))) {
      addDate(records, people, match[1], eventId, { birthDate: spokenDate(match[2]) });
    }
    // "On 11th December 2012 our second son Presley was born"
    for (const match of text.matchAll(new RegExp(`\\b[Oo]n\\s+(${DATE}),?\\s+(?:[^.!?]{0,40}?\\s)?(${NAME})\\s+was\\s+born\\b`, "gu"))) {
      addDate(records, people, match[2], eventId, { birthDate: spokenDate(match[1]) });
    }
  }
  // "… Presley on 11 December 2012 and Prisha on 20 June 2020"; a bare "Leah 14 Dec 1983" only for someone known.
  for (const match of text.matchAll(new RegExp(`(${NAME}),?\\s+(?:on\\s+)?(${DATE})`, "gu"))) {
    const lead = text.slice(Math.max(0, match.index - 40), match.index);
    if (/\b(marriage|married|engagement|engaged|passed away|died|registered)\b/i.test(lead)) continue;
    if (!aboutBirth && !resolveRecord(match[1], people)?.personId) continue;
    addDate(records, people, match[1], eventId, { birthDate: spokenDate(match[2]) });
  }
  // "Enock Mwakyusa, born … in Rungwe, Mbeya, and he died on 25 April 2004": the person is the
  // first known name before the verb, not the nearest capitalised word (which is often a place).
  for (const match of text.matchAll(new RegExp(`\\b(?:passed away|died)\\s+(?:on\\s+)?(${DATE})`, "gu"))) {
    const names = candidateNames(text.slice(0, match.index));
    const who = names.find((name) => resolveRecord(name, people)?.personId) || names[0];
    if (who) addDate(records, people, who, eventId, { deathDate: spokenDate(match[1]) });
  }
}

// "I married Zelda … on 5 August 2006", "marriage to Zelda", "we got married on 5th August 2006", "Zelda joined me"
function collectMarriage(text, eventId, people, records) {
  if (!/\b(married|marriage|wedding|wed|engaged|engagement|joined me)\b/i.test(text)) return;
  const date = /\bengag/i.test(text) && !/\b(married|marriage|wedding)\b/i.test(text) ? null : marriageDateIn(text);
  let named = false;
  const patterns = [
    new RegExp(`\\b(?:married|wed)\\s+(?:to\\s+)?(${NAME})`, "gu"),
    new RegExp(`\\b(?:[Mm]arriage|[Ee]ngagement|[Ww]edding)\\s+(?:to|with)\\s+(${NAME})`, "gu"),
    new RegExp(`\\bengaged\\s+(?:to\\s+)?(?:my\\s+fianc[ée]e?\\s+)?(${NAME})`, "gu"),
    new RegExp(`(${NAME})\\s+joined\\s+me\\b`, "gu"),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (/\bmarried to (?:my|our|your) (father|mother)/i.test(match[0])) continue;
      const resolved = resolveRecord(match[1], people);
      if (!resolved) continue;
      named = true;
      mergeRecord(records, { ...resolved, kind: "spouse", eventId, birthDate: null, deathDate: null, marriageDate: date });
    }
  }
  // "we got married on 5th August 2006" names nobody; it still dates the marriage.
  if (!named && date && /\b(we|I)\b[^.!?]{0,20}\b(got married|married|wedding)\b|\bmy (wife|husband)\b/i.test(text) && !/\bparents\b/i.test(text)) {
    const kind = /\bmy wife\b/i.test(text) ? "wife" : /\bmy husband\b/i.test(text) ? "husband" : "spouse";
    records.push({ name: "", personId: null, kind, eventId, birthDate: null, deathDate: null, marriageDate: date });
  }
  const spouse = records.find((item) => item.eventId === eventId && ["spouse", "wife", "husband"].includes(item.kind));
  if (spouse && !spouse.marriageDate && date) spouse.marriageDate = date;
}

function marriageDateIn(text) {
  const word = String(text || "").match(/\b(?:married|marriage|wedding|wed)\b/i);
  if (!word) return null;
  const dates = [...String(text).matchAll(DATE_RE)].map((match) => ({ at: match.index, iso: normalizeDate(match[0]) })).filter((item) => item.iso);
  if (!dates.length) return null;
  dates.sort((a, b) => Math.abs(a.at - word.index) - Math.abs(b.at - word.index));
  return dates[0].iso;
}

function addDate(records, people, raw, eventId, dates) {
  const resolved = resolveRecord(raw, people);
  if (!resolved) return;
  mergeRecord(records, { ...resolved, kind: null, eventId, birthDate: dates.birthDate || null, deathDate: dates.deathDate || null, marriageDate: null });
}

function mergeRecord(records, claim) {
  const existing = records.find((item) => item.eventId === claim.eventId && samePerson(item, claim));
  if (!existing) {
    records.push({ ...claim });
    return;
  }
  if (!existing.personId && String(claim.name).length > String(existing.name).length) existing.name = claim.name;
  existing.personId = existing.personId || claim.personId || null;
  existing.birthDate = existing.birthDate || claim.birthDate;
  existing.deathDate = existing.deathDate || claim.deathDate;
  existing.marriageDate = existing.marriageDate || claim.marriageDate;
  if (claim.kind && (!existing.kind || existing.kind === "spouse" || existing.kind === "child")) existing.kind = claim.kind;
}

function resolveRecord(name, people) {
  const cleaned = properWords(name);
  if (!cleaned) return null;
  const key = normalizeName(cleaned);
  const exact = (people || []).find((person) => normalizeName(person.name) === key);
  if (exact) return { name: exact.name, personId: exact.id };
  const first = key.split(" ")[0];
  const hits = (people || []).filter((person) => normalizeName(person.name).split(" ")[0] === first);
  if (hits.length === 1) return { name: hits[0].name, personId: hits[0].id };
  return { name: cleaned, personId: null };
}

function properWords(name) {
  const kept = [];
  const words = String(name || "").replace(/^\s*(?:my|our|your|his|her|their|the|a|an)\s+/i, "").trim().split(/\s+/);
  for (const raw of words) {
    const word = raw.replace(/[.,;:!?)]+$/, "");
    if (!word || !/^[\p{Lu}][\p{L}'’\-]*$/u.test(word)) break;
    if (NOT_NAME.has(word.toLowerCase())) break;
    kept.push(word);
  }
  return kept.join(" ");
}

function candidateNames(text) {
  return [...String(text || "").matchAll(new RegExp(NAME, "gu"))].map((match) => properWords(match[0])).filter(Boolean);
}

function samePerson(left, right) {
  if (left?.personId && right?.personId) return left.personId === right.personId;
  if (left?.id && right?.personId) return left.id === right.personId;
  if (left?.personId && right?.id) return left.personId === right.id;
  return namesMatch(left?.name, right?.name);
}

// One row per person across events, keeping the first non-empty value of each field.
function distinctPeople(rows) {
  const out = [];
  for (const row of rows) {
    if (!row?.name) continue;
    const seen = out.find((item) => samePerson(item, row));
    if (!seen) {
      out.push({ ...row });
      continue;
    }
    seen.birthDate = seen.birthDate || row.birthDate || null;
    seen.deathDate = seen.deathDate || row.deathDate || null;
  }
  return out;
}

function namesMatch(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `);
}

function parentKind(word) {
  return ["mother", "mum", "mom", "mama"].includes(String(word || "").toLowerCase()) ? "mother" : "father";
}

function spokenDate(text) {
  const match = String(text || "").match(new RegExp(DATE, "i"));
  return match ? normalizeDate(match[0]) : null;
}

function anyCase(word) {
  return `[${word[0].toUpperCase()}${word[0]}]${word.slice(1)}`;
}

function spouseAnswer(question, context) {
  const word = /\bhusband\b/i.test(question) && !/\bwife\b/i.test(question) ? "husband" : "wife";
  const confirmed = (context?.people || []).find((person) => ["wife", "husband", "spouse"].includes(person.kind));
  const record = spouseRecord(context);
  if (confirmed) {
    const married = record?.marriageDate ? ` (married ${prettyDate(record.marriageDate)})` : "";
    const line = `${confirmed.name} — your ${confirmed.kind === "spouse" ? word : confirmed.kind}${married}.`;
    return record?.marriageDate ? `${line}\n${RECORD_LINE}` : line;
  }
  if (!record?.name) return "Your spouse isn't recorded yet.";
  const married = record.marriageDate ? ` (married ${prettyDate(record.marriageDate)})` : "";
  return `${record.name} — your ${record.kind && record.kind !== "spouse" ? record.kind : word}${married}.\n${RECORD_LINE}`;
}

function spouseRecord(context) {
  const hits = (context?.records || []).filter((item) => ["wife", "husband", "spouse"].includes(item.kind));
  if (!hits.length) return null;
  return hits.reduce((best, item) => ({
    name: String(item.name || "").length > String(best.name || "").length ? item.name : best.name,
    kind: best.kind && best.kind !== "spouse" ? best.kind : (item.kind || best.kind),
    marriageDate: best.marriageDate || item.marriageDate,
  }));
}

// Everyone in one role: confirmed tree people first, then people only the events name.
function relatives(context, kinds) {
  const fromTree = (context?.people || []).filter((person) => kinds.includes(person.kind));
  const fromEvents = distinctPeople((context?.records || []).filter((item) => kinds.includes(item.kind)))
    .filter((item) => !fromTree.some((person) => samePerson(item, person)));
  const birth = (person) => birthOf(person, context)?.iso || "9999";
  const all = [...fromTree, ...fromEvents].sort((a, b) => birth(a).localeCompare(birth(b)));
  return { fromTree, fromEvents, all };
}

function kindOf(person, context, choices) {
  if (choices.includes(person.kind)) return person.kind;
  return (context?.records || []).find((item) => choices.includes(item.kind) && samePerson(item, person))?.kind || person.kind;
}

function deathOf(person, context) {
  const own = normalizeDate(person?.deathDate);
  if (own) return own;
  return (context?.records || []).find((item) => item.deathDate && samePerson(item, person))?.deathDate || null;
}

function parentsAnswer(context) {
  const found = relatives(context, ["father", "mother", "parent"]);
  if (!found.all.length) return "Your parents aren't recorded yet.";
  const rank = { father: 0, mother: 1, parent: 2 };
  const lines = found.all
    .map((person) => ({ person, kind: kindOf(person, context, ["father", "mother"]) }))
    .sort((a, b) => rank[a.kind] - rank[b.kind])
    .map(({ person, kind }) => `${person.name} — your ${kind}${passed({ deathDate: deathOf(person, context) })}.`);
  if (found.fromEvents.length) lines.push(RECORD_LINE);
  return lines.join("\n");
}

function parentRoleAnswer(kind, context) {
  const found = relatives(context, [kind, "parent"]);
  const person = found.all.find((item) => kindOf(item, context, ["father", "mother"]) === kind);
  if (!person) return `Your ${kind} isn't recorded yet.`;
  const line = `${person.name} — your ${kind}${passed({ deathDate: deathOf(person, context) })}.`;
  return found.fromTree.includes(person) ? line : `${line}\n${RECORD_LINE}`;
}

function siblingsWanted(question) {
  if (/\bbrothers?\b/i.test(question) && !/\bsisters?\b/i.test(question)) return { label: "brothers", kinds: ["brother", "sibling"], not: "sister" };
  if (/\bsisters?\b/i.test(question) && !/\bbrothers?\b/i.test(question)) return { label: "sisters", kinds: ["sister", "sibling"], not: "brother" };
  return { label: "siblings", kinds: ["sister", "brother", "sibling"], not: null };
}

function siblingsFor(question, context) {
  const want = siblingsWanted(question);
  const found = relatives(context, want.kinds);
  const people = found.all.filter((person) => !want.not || kindOf(person, context, ["sister", "brother"]) !== want.not);
  return { want, people, fromEvents: found.fromEvents.some((item) => people.includes(item)) };
}

function siblingAnswer(question, context) {
  const { want, people, fromEvents } = siblingsFor(question, context);
  if (!people.length) return `Your ${want.label} aren't recorded yet.`;
  const count = /\bhow many\b/i.test(question) ? `You have ${people.length} ${want.label}: ` : `Your ${want.label}: `;
  const line = `${count}${people.map((person) => person.name).join(", ")}.`;
  return fromEvents ? `${line}\n${RECORD_LINE}` : line;
}

function siblingBirthAnswer(question, context) {
  const { want, people } = siblingsFor(question, context);
  if (!people.length) return `Your ${want.label} aren't recorded yet.`;
  let fromEvent = false;
  const lines = people.map((person) => {
    const found = birthOf(person, context);
    if (!found) return `${person.name} — birth date not recorded yet`;
    if (found.fromEvent) fromEvent = true;
    return `${person.name} — ${prettyDate(found.iso)}`;
  });
  if (fromEvent) lines.push(RECORD_LINE);
  return lines.join("\n");
}

function childrenAnswer(question, context) {
  const found = relatives(context, ["child", "son", "daughter"]);
  if (!found.all.length) return "Your children aren't recorded yet.";
  const names = found.all.map((person) => person.name);
  const count = /\bhow many\b/i.test(question) ? `You have ${names.length} children: ` : "Your children: ";
  const line = `${count}${names.join(", ")}.`;
  return found.fromEvents.length ? `${line}\n${RECORD_LINE}` : line;
}

// Built only from recorded facts; a person appears once, in the one role they hold.
function familyTreeAnswer(context) {
  const self = (context?.people || []).find((person) => person.kind === "self") || context?.self;
  const born = (person) => {
    const found = birthOf(person, context);
    return found ? `b. ${prettyDate(found.iso)}` : "";
  };
  const describe = (person, ...bits) => {
    const extra = bits.filter(Boolean).join(", ");
    return extra ? `${person.name} (${extra})` : person.name;
  };
  const lines = [];
  if (self?.name) lines.push(`You: ${self.name}`);
  const parents = relatives(context, ["father", "mother", "parent"]).all;
  if (parents.length) {
    lines.push(`Parents: ${parents.map((person) => {
      const death = deathOf(person, context);
      return describe(person, kindOf(person, context, ["father", "mother"]), born(person), death ? `passed ${prettyDate(death)}` : "");
    }).join("; ")}`);
  }
  const spouse = (context?.people || []).find((person) => ["wife", "husband", "spouse"].includes(person.kind));
  const record = spouseRecord(context);
  if (spouse || record?.name) {
    const person = spouse || record;
    const kind = person.kind && person.kind !== "spouse" ? person.kind : (record?.kind && record.kind !== "spouse" ? record.kind : "spouse");
    lines.push(`Spouse: ${describe(person, kind, record?.marriageDate ? `married ${prettyDate(record.marriageDate)}` : "")}`);
  }
  const siblings = siblingsFor("siblings", context).people;
  if (siblings.length) lines.push(`Siblings: ${siblings.map((person) => describe(person, kindOf(person, context, ["sister", "brother"]).replace("sibling", ""), born(person))).join("; ")}`);
  const children = relatives(context, ["child", "son", "daughter"]).all;
  if (children.length) lines.push(`Children: ${children.map((person) => describe(person, kindOf(person, context, ["son", "daughter"]).replace("child", ""), born(person))).join("; ")}`);
  if (lines.length <= 1) return "Your family tree isn't recorded yet.";
  return lines.join("\n");
}

function birthOf(person, context) {
  const own = normalizeDate(person?.birthDate);
  if (own && /^\d{4}-\d{2}-\d{2}$/.test(own)) return { iso: own, fromEvent: false };
  const record = (context?.records || []).find((item) => item.birthDate && /^\d{4}-\d{2}-\d{2}$/.test(item.birthDate) && samePerson(item, person));
  return record ? { iso: record.birthDate, fromEvent: true } : null;
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
  const pattern = new RegExp(`\\b(?:${DATE}|\\d{4})\\b`, "gi");
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
  const text = String(value || "").trim().replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1").replace(/\s+of\s+/i, " ").replace(/\.(?=\s)/g, "").replace(/(\d{1,2}\s+[A-Za-z]+),(\s+\d{4})$/, "$1$2");
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
