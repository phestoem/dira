import { prisma } from "../../prisma.js";
import { normalizeName } from "./entityResolver.js";
import { getFamilyTree } from "./graphQuery.js";
import { isOrdinalKin, KIN_PATTERN, kinOf } from "./kinship.js";

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
  // "My brothers' birthdays: Diego was born on 4 May 1990, …" tells; it doesn't ask.
  if (!value.includes("?") && !/^(?:please\s+)?(?:who|what|when|where|which|how|list|show|name|tell|give|remind|do|does|did|is|are)\b/i.test(value) && /\b(born|married|died|passed away)\b/i.test(value)) return false;
  if (/\b(family tree|who is|who's|who are|who was|how old|birthdays?|birth dates?|relatives)\b/i.test(value)) return true;
  // Any role word or birth-order word after my/our in a question: "when was my stepbrother born?", "who is our eldest?"
  if (asks(value) && (MY_KIN.test(value) || MY_ORDINAL.test(value))) return true;
  if (/\bhow many\b/i.test(value) && /\b(kids|children|sons|daughters|sisters|brothers)\b/i.test(value)) return true;
  if (/\b(children|kids|sisters|brothers|parents)'?s?\s+names\b/i.test(value)) return true;
  if (/^(?:please\s+)?(?:list|show|name|tell me|give me|remind me of)\b/i.test(value) && /\b(my|our)\s+(parents|wife|husband|spouse|father|mother|sisters|brothers|siblings|children|kids|sons|daughters|family)\b/i.test(value)) return true;
  if (/[?]/.test(value) && /\b(my|our)\s+(parents|wife|husband|father|mother|sisters|brothers|children|kids)\b/i.test(value)) return true;
  return /\b(my|our)\s+\w+'s\s+(family|spouse|wife|husband|children|parents|sisters|brothers|birthday|age)\b/i.test(value);
}


// Answers read only what was saved: confirmed relatives from the tree, relatives on suggested edges (shown as
// unconfirmed), dates on the people themselves, the marriage date on the spouse edge, and conflicts the save step
// recorded. Event text is never parsed at question time.
export async function loadPeopleContext(userId) {
  const tree = await getFamilyTree(userId);
  const selfId = tree.self?.id;
  const [edges, conflictRows] = await Promise.all([
    // Ended marriages stay in view as former spouses; any other ended edge is history, not a current relative.
    prisma.relationship.findMany({ where: { userId, category: { in: ["family", "social"] }, status: { in: ["confirmed", "suggested"] }, OR: [{ validTo: null }, { type: "spouse_of" }] } }),
    prisma.relationship.findMany({ where: { userId, label: "conflict", status: "suggested" } }),
  ]);
  const people = peopleFromTree(tree);
  const otherIds = [...new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]))].filter((id) => !people.some((person) => person.id === id));
  const others = otherIds.length ? await prisma.entity.findMany({ where: { userId, id: { in: otherIds }, status: { not: "archived" } } }) : [];
  const nameOf = (id) => people.find((person) => person.id === id)?.name || others.find((person) => person.id === id)?.name || "";
  const namedEdges = edges.map((edge) => ({
    id: edge.id,
    type: edge.type,
    status: edge.status,
    fromId: edge.fromId,
    toId: edge.toId,
    validFrom: edge.validFrom,
    validTo: edge.validTo,
    attributes: edge.attributes || {},
    fromName: nameOf(edge.fromId),
    toName: nameOf(edge.toId),
  }));
  const conflicts = conflictRows.map((row) => ({
    entityId: row.fromId,
    name: row.attributes?.name || nameOf(row.fromId),
    field: row.attributes?.conflictWith || "birthDate",
    values: [row.attributes?.current, row.attributes?.incoming].filter(Boolean).sort(),
  })).filter((conflict) => conflict.values.length === 2);
  return buildPeopleContext({ self: tree.self, people, others, edges: namedEdges, conflicts, about: await aboutPeople(userId, selfId, [...people, ...others]) });
}

// What else is recorded about each person (work, places, ownership, family between others), for "who is X?".
async function aboutPeople(userId, selfId, people) {
  const ids = people.map((person) => person.id).filter((id) => id && id !== selfId);
  if (!ids.length) return {};
  const rows = await prisma.relationship.findMany({
    where: { userId, status: { in: ["confirmed", "suggested"] }, validTo: null, label: null, OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] },
    take: 400,
  });
  const nodeIds = [...new Set(rows.flatMap((row) => [row.fromId, row.toId]))];
  const nodes = nodeIds.length ? await prisma.entity.findMany({ where: { userId, id: { in: nodeIds } }, select: { id: true, name: true, isSelf: true } }) : [];
  const label = (id) => (id === selfId ? "you" : nodes.find((node) => node.id === id)?.name || "");
  const about = {};
  for (const row of rows) {
    if (row.fromId === selfId || row.toId === selfId || row.fromKind !== "entity" || row.toKind !== "entity") continue;
    const from = label(row.fromId);
    const to = label(row.toId);
    if (!from || !to) continue;
    const line = `${from} ${String(row.type).replaceAll("_", " ")} ${to}${row.status === "suggested" ? " (unconfirmed)" : ""}`;
    for (const id of [row.fromId, row.toId]) if (ids.includes(id)) (about[id] ||= []).push(line);
  }
  return about;
}

export function buildPeopleContext({ self, people = [], others = [], edges = [], conflicts = [], about = {} } = {}) {
  const selfId = self?.id || people.find((person) => person?.kind === "self")?.id;
  const ended = (edge) => Boolean(edge.validTo || edge.attributes?.ended);
  const touchesSelf = (edge) => edge.fromId === selfId || edge.toId === selfId;
  const otherEnd = (edge) => (edge.fromId === selfId ? edge.toId : edge.fromId);
  const entityOf = (id, fallback) => people.find((person) => person.id === id) || others.find((person) => person.id === id) || { id, name: fallback };
  // A spouse whose only marriage to you has ended is a former spouse, not "your wife".
  const former = [];
  for (const edge of edges.filter((item) => item.type === "spouse_of" && touchesSelf(item) && ended(item))) {
    const id = otherEnd(edge);
    if (edges.some((item) => item.type === "spouse_of" && touchesSelf(item) && !ended(item) && otherEnd(item) === id)) continue;
    const person = entityOf(id, edge.fromId === selfId ? edge.toName : edge.fromName);
    if (!person.name || former.some((item) => item.id === id)) continue;
    former.push({ ...person, role: "former-spouse", kind: kinOf(person.kind)?.group === "spouse" ? kinOf(person.kind).base : "spouse", married: normalizeDate(edge.validFrom), until: edge.attributes?.endPrecision === "year" ? String(edge.validTo || "").slice(0, 4) || null : normalizeDate(edge.validTo), pending: edge.status === "suggested" });
  }
  const roster = people.filter((person) => person?.name && !(person.role === "spouse" && former.some((item) => item.id === person.id)));
  const current = edges.filter((edge) => !(edge.type === "spouse_of" && ended(edge)));
  const confirmed = current.filter((edge) => edge.status !== "suggested");
  const suggested = current.filter((edge) => edge.status === "suggested");
  // Grandparents, step- and in-law relatives, uncles, cousins, and people you know (a neighbour, a friend).
  const extended = [];
  for (const edge of current.filter((item) => touchesSelf(item) && ["grandparent_of", "relative_of", "knows", "friend_of"].includes(item.type))) {
    const id = otherEnd(edge);
    if (roster.some((person) => person.id === id) || extended.some((person) => person.id === id)) continue;
    const person = entityOf(id, edge.fromId === selfId ? edge.toName : edge.fromName);
    if (!person.name) continue;
    const role = edge.type === "grandparent_of" ? (edge.toId === selfId ? "grandparent" : "grandchild") : edge.type === "relative_of" ? "relative" : "social";
    const kind = edge.attributes?.kind || (person.kind && kinOf(person.kind) ? person.kind : role);
    extended.push({ ...person, role, kind, pending: edge.status === "suggested" });
  }
  // People who are only on a suggested edge to the self: unconfirmed, in the role that edge gives them.
  const pending = [];
  for (const edge of suggested) {
    if (edge.fromId !== selfId && edge.toId !== selfId) continue;
    const otherId = edge.fromId === selfId ? edge.toId : edge.fromId;
    if (roster.some((person) => person.id === otherId) || pending.some((person) => person.id === otherId) || extended.some((person) => person.id === otherId)) continue;
    const entity = entityOf(otherId, edge.fromId === selfId ? edge.toName : edge.fromName);
    if (!entity.name) continue;
    const role = edge.type === "spouse_of" ? "spouse" : edge.type === "sibling_of" ? "sibling" : edge.type === "parent_of" ? (edge.toId === selfId ? "parent" : "child") : null;
    if (!role) continue;
    const own = String(entity.kind || "").toLowerCase();
    pending.push({ ...entity, role, kind: ROLE_KINDS[role]?.includes(own) ? own : role, pending: true });
  }
  const everyone = [...roster, ...pending, ...extended, ...former];
  const allowedNames = everyone.map((person) => person.name);
  const allowedDates = new Set();
  const facts = [];
  for (const person of everyone) {
    const bits = [person.pending ? `unconfirmed: ${person.name}` : person.name];
    if (person.kind && person.kind !== "self") bits.push(person.kind);
    for (const field of ["birthDate", "deathDate"]) {
      const iso = normalizeDate(person[field]);
      if (!iso) continue;
      allowedDates.add(iso);
      bits.push(`${field} ${iso}`);
    }
    facts.push({ text: bits.join(" | "), source: { type: "entity", id: person.id } });
  }
  const spouseEdge = [...confirmed, ...suggested].find((edge) => edge.type === "spouse_of" && touchesSelf(edge));
  const marriageDate = normalizeDate(spouseEdge?.validFrom);
  if (marriageDate) allowedDates.add(marriageDate);
  for (const edge of confirmed) {
    const married = edge === spouseEdge && marriageDate ? ` | married ${marriageDate}` : "";
    facts.push({ text: `${edge.fromName || edge.fromId} ${edge.type} ${edge.toName || edge.toId}${married}`, source: { type: "edge", id: edge.id } });
  }
  for (const edge of suggested) {
    facts.push({ text: `unconfirmed: ${edge.fromName || edge.fromId} ${edge.type} ${edge.toName || edge.toId}`, source: { type: "edge", id: edge.id } });
  }
  for (const person of former) {
    if (person.married) allowedDates.add(person.married);
    facts.push({ text: `${person.name} | former ${person.kind}${person.married ? ` | married ${person.married}` : ""}${person.until ? ` | ended ${person.until}` : ""}`, source: { type: "entity", id: person.id } });
  }
  for (const [id, lines] of Object.entries(about)) {
    for (const line of lines.slice(0, 6)) facts.push({ text: line, source: { type: "entity", id } });
    allowedNames.push(...lines.flatMap((line) => line.match(/[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)*/gu) || []));
  }
  for (const conflict of conflicts) for (const value of conflict.values) allowedDates.add(value);
  return { self, people: roster, pending, extended, former, about, edges: confirmed, suggested, facts, marriageDate, allowedNames, allowedDates, conflicts };
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
  if (/\bparents?\b/i.test(previous)) return "name my parents";
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

// my/our + any role word the vocabulary knows; my/our + a birth-order word.
const MY_KIN = new RegExp(`\\b(?:my|our)\\s+(?:late\\s+|dear\\s+)?(${KIN_PATTERN})\\b`, "i");
const MY_ORDINAL = /\b(?:my|our)\s+(firstborn|first-born|eldest|oldest|youngest|last-born|baby)\b/i;

function asks(value) {
  return value.includes("?") || /^(?:please\s+)?(?:who|what|when|where|which|how|list|show|name|tell|give|remind|do|does|did|is|are|was)\b/i.test(value);
}

// The known person a question is about by name ("who is Ana Lopes?"): the full name, or a first name only one person has.
export function namedPerson(question, context) {
  const q = ` ${normalizeName(question)} `;
  const everyone = [...(context?.people || []), ...(context?.pending || []), ...(context?.extended || []), ...(context?.former || [])].filter((person) => person.kind !== "self");
  const full = everyone.filter((person) => q.includes(` ${normalizeName(person.name)} `)).sort((a, b) => b.name.length - a.name.length);
  if (full.length) return full[0];
  const firsts = everyone.filter((person) => q.includes(` ${normalizeName(person.name).split(" ")[0]} `));
  return firsts.length === 1 ? firsts[0] : null;
}

export function usesRecordedAnswer(question, context = null) {
  const q = String(question || "");
  if (MY_ORDINAL.test(q) || MY_KIN.test(q)) return true;
  if (context && /\b(who is|who's|who was|tell me about)\b/i.test(q) && namedPerson(q, context)) return true;
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
  const ordinal = q.match(MY_ORDINAL) || q.match(/\b(firstborn|first-born|eldest|oldest|youngest|last-born)\s+(?:child|son|daughter)\b/i);
  if (ordinal) return ordinalAnswer(ordinal[1].toLowerCase(), q, context);
  const roleAnswer = extendedKinAnswer(q, context);
  if (roleAnswer) return roleAnswer;
  if (/\b(who is|who's|who was|tell me about)\b/i.test(q)) {
    const person = namedPerson(q, context);
    if (person && !MY_KIN.test(q)) return personAnswer(person, context);
  }
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
    const what = conflict.field === "deathDate" ? "date of death" : "birth date";
    const label = context.self && conflict.entityId === context.self.id ? `Your ${what}` : `${conflict.name}'s ${what}`;
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

const RECORD_LINE = "From your records — confirm in Review to lock it in.";
const MONTH_WORDS = Object.keys(MONTHS).sort((a, b) => b.length - a.length).map(anyCase).join("|");
const DAY = "\\d{1,2}(?:st|nd|rd|th)?";
// "3 February 1993", "25th of April 1977", "February 3rd, 1993", "Feb 17th 1978", "2006-08-05".
const DATE = `(?:${DAY}\\s+(?:of\\s+)?(?:${MONTH_WORDS})\\.?,?\\s+\\d{4}|(?:${MONTH_WORDS})\\.?\\s+${DAY},?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`;

function anyCase(word) {
  return `[${word[0].toUpperCase()}${word[0]}]${word.slice(1)}`;
}

function spouseAnswer(question, context) {
  const word = /\bhusband\b/i.test(question) && !/\bwife\b/i.test(question) ? "husband" : "wife";
  if (/\b(ex|former|first|previous|old)[- ]?(wife|husband|spouse|partner)\b/i.test(question)) return formerSpouseAnswer(context);
  const confirmed = (context?.people || []).find((person) => ["wife", "husband", "spouse"].includes(person.kind));
  const record = spouseRecord(context);
  if (confirmed) {
    const married = record?.marriageDate ? ` (married ${prettyDate(record.marriageDate)})` : "";
    return `${confirmed.name} — your ${confirmed.kind === "spouse" ? word : confirmed.kind}${married}.`;
  }
  if (!record?.name) return "Your spouse isn't recorded yet.";
  const married = record.marriageDate ? ` (married ${prettyDate(record.marriageDate)})` : "";
  return `${record.name} — your ${record.kind && record.kind !== "spouse" ? record.kind : word}${married}.\n${RECORD_LINE}`;
}

function spouseRecord(context) {
  const pending = (context?.pending || []).find((person) => ["wife", "husband", "spouse"].includes(person.kind));
  if (!pending && !context?.marriageDate) return null;
  return { name: pending?.name || "", kind: pending?.kind || "spouse", marriageDate: context?.marriageDate || null };
}

// Everyone in one role: confirmed tree people first, then people only a suggested edge names.
function relatives(context, kinds) {
  const fromTree = (context?.people || []).filter((person) => kinds.includes(person.kind));
  const fromEvents = (context?.pending || []).filter((person) => kinds.includes(person.kind));
  const birth = (person) => birthOf(person, context)?.iso || "9999";
  const all = [...fromTree, ...fromEvents].sort((a, b) => birth(a).localeCompare(birth(b)));
  return { fromTree, fromEvents, all };
}

function kindOf(person) {
  return person.kind;
}

function deathOf(person) {
  return normalizeDate(person?.deathDate);
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
  for (const person of context?.former || []) {
    lines.push(`Former spouse: ${describe(person, person.kind, person.married ? `married ${prettyDate(person.married)}` : "", person.until ? `ended ${/^\d{4}$/.test(person.until) ? person.until : prettyDate(person.until)}` : "")}`);
  }
  const grand = (context?.extended || []).filter((person) => person.role === "grandparent");
  if (grand.length) lines.push(`Grandparents: ${grand.map((person) => describe(person, person.kind !== "grandparent" ? person.kind : "", born(person))).join("; ")}`);
  const siblings = siblingsFor("siblings", context).people;
  if (siblings.length) lines.push(`Siblings: ${siblings.map((person) => describe(person, kindOf(person, context, ["sister", "brother"]).replace("sibling", ""), born(person))).join("; ")}`);
  const children = relatives(context, ["child", "son", "daughter"]).all;
  if (children.length) lines.push(`Children: ${children.map((person) => describe(person, kindOf(person, context, ["son", "daughter"]).replace("child", ""), born(person))).join("; ")}`);
  const grandchildren = (context?.extended || []).filter((person) => person.role === "grandchild");
  if (grandchildren.length) lines.push(`Grandchildren: ${grandchildren.map((person) => describe(person, born(person))).join("; ")}`);
  const relativesOther = (context?.extended || []).filter((person) => person.role === "relative");
  if (relativesOther.length) lines.push(`Other relatives: ${relativesOther.map((person) => describe(person, person.kind, born(person))).join("; ")}`);
  if (lines.length <= 1) return "Your family tree isn't recorded yet.";
  return lines.join("\n");
}

// "my firstborn", "our youngest": the children by birth date (an explicit birth order wins).
function ordinalAnswer(word, question, context) {
  const children = relatives(context, ["child", "son", "daughter"]).all;
  if (!children.length) return "Your children aren't recorded yet.";
  const order = (person) => Number(person.attributes?.birthOrder) || null;
  const dated = children.filter((person) => birthOf(person) || order(person));
  const key = (person) => (order(person) ? String(order(person)).padStart(4, "0") : birthOf(person).iso);
  dated.sort((a, b) => key(a).localeCompare(key(b)));
  const youngest = /^(youngest|last-born|baby)$/.test(word);
  const person = youngest ? dated.at(-1) : dated[0];
  if (!person || (dated.length < children.length && youngest)) return `Which child is your ${word} isn't recorded yet — not every child has a birth date.`;
  const born = birthOf(person);
  const line = `${person.name} — your ${word}${born ? ` (b. ${prettyDate(born.iso)})` : ""}.`;
  return person.pending ? `${line}\n${RECORD_LINE}` : line;
}

// Roles the core answers do not cover: grand-, step-, half-, in-law, ex-, uncles, cousins, neighbours, friends.
function extendedKinAnswer(question, context) {
  for (const match of question.matchAll(new RegExp(MY_KIN.source, "gi"))) {
    const kin = kinOf(match[1]);
    if (!kin) continue;
    const special = kin.ex || kin.half || kin.step || kin.inLaw || ["grandparent", "grandchild", "relative", "social"].includes(kin.group);
    if (!special) continue;
    if (kin.ex) return formerSpouseAnswer(context);
    const want = kin.word.replace(/(?<=[a-z])s$/, "");
    const pool = [...(context?.people || []), ...(context?.pending || []), ...(context?.extended || [])];
    const found = pool.filter((person) => {
      const has = kinOf(person.kind);
      if (!has) return false;
      if (kin.half) return has.half && has.base === kin.base;
      if (has.word === want || has.base === kin.base && has.step === kin.step && has.inLaw === kin.inLaw && has.half === kin.half) return true;
      return kin.base === kin.group && has.group === kin.group;
    });
    if (!found.length) return `Your ${want} isn't recorded yet.`;
    const aboutBirth = /\b(born|birth|birthday|age|old)\b/i.test(question);
    const lines = found.map((person) => {
      const born = birthOf(person);
      if (aboutBirth) return born ? `${person.name} — your ${person.kind}, born ${prettyDate(born.iso)}.` : `${person.name} — your ${person.kind}; birth date not recorded yet.`;
      return `${person.name} — your ${person.kind}${passed(person)}.`;
    });
    if (found.some((person) => person.pending)) lines.push(RECORD_LINE);
    return lines.join("\n");
  }
  return null;
}

function formerSpouseAnswer(context) {
  const former = context?.former || [];
  if (!former.length) return "No former spouse is recorded.";
  const lines = former.map((person) => {
    const bits = [person.married ? `married ${prettyDate(person.married)}` : "", person.until ? `ended ${/^\d{4}$/.test(person.until) ? person.until : prettyDate(person.until)}` : ""].filter(Boolean);
    return `${person.name} — your former ${person.kind}${bits.length ? ` (${bits.join(", ")})` : ""}.`;
  });
  if (former.some((person) => person.pending)) lines.push(RECORD_LINE);
  return lines.join("\n");
}

// "Who is Ana Lopes?": their role to you, if any, and what else is recorded about them.
function personAnswer(person, context) {
  const role = person.role === "former-spouse" ? `your former ${person.kind}` : person.role && person.kind && person.kind !== "self" ? `your ${person.kind}` : "";
  const born = birthOf(person);
  const bits = [role, born ? `born ${prettyDate(born.iso)}` : "", person.deathDate ? `passed ${prettyDate(normalizeDate(person.deathDate))}` : ""].filter(Boolean);
  const lines = [`${person.name}${bits.length ? ` — ${bits.join(", ")}` : ""}.`];
  for (const line of (context?.about?.[person.id] || []).slice(0, 5)) lines.push(line);
  if (lines.length === 1 && !bits.length) return `${person.name} is in your records, but nothing more about them is recorded yet.`;
  if (person.pending) lines.push(RECORD_LINE);
  return lines.join("\n");
}

function birthOf(person) {
  const own = normalizeDate(person?.birthDate);
  return own && /^\d{4}-\d{2}-\d{2}$/.test(own) ? { iso: own, fromEvent: Boolean(person.pending) } : null;
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
