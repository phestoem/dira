import { prisma } from "../../prisma.js";
import { fold, nameKeys } from "../peopleLinks.js";

// Birth, death and marriage dates a message states for people who already have a person record. Found by code
// (no model) at save time, shown in the save preview, and written to the records only when the user confirms the
// save. Only empty fields are filled: a record that already has a different date is left as it is and reported.
// Answers read dates from records only; event text never dates a person.

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const DATE = new RegExp(`\\b(?:${DAY}\\s+(?:of\\s+)?(${MONTH})\\.?,?\\s+(\\d{4})|(${MONTH})\\.?\\s+${DAY},?\\s+(\\d{4})|(\\d{4})-(\\d{2})-(\\d{2}))\\b`, "g");
const BIRTH = /\b(born|birth|birthdays?|welcomed)\b/;
const DEATH = /\b(died|passed away|passed on|passing|death|deceased|buried)\b/;
const MARRIAGE = /\b(married|marriage|wedding|wed)\b/;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoOf(match) {
  const [, d1, m1, y1, m2, d2, y2, iy, im, id] = match;
  const [year, month, day] = iy ? [Number(iy), Number(im), Number(id)] : d1 ? [Number(y1), MONTHS[m1], Number(d1)] : [Number(y2), MONTHS[m2], Number(d2)];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!month || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function prettyDay(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

// [{ id, name, field: birthDate|deathDate|marriageDate, iso }] for the known people the text dates.
// One sentence at a time; within it, each clause (split at commas, semicolons and "and") takes the person it
// names, or the last person named before it, and the kind of date its own words give, or the sentence's.
export function findStatedDates(text, keys) {
  const found = [];
  for (const sentence of fold(text).split(/(?<=[.!?])\s+/)) {
    let person = null;
    let kind = null;
    for (const clause of sentence.split(/,(?!\s*\d{4}\b)|;|\band\b/)) {
      const named = keys.find((entry) => new RegExp(`(?<![\\p{L}\\p{N}])${entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(clause));
      if (named) person = named;
      const own = DEATH.test(clause) ? "deathDate" : MARRIAGE.test(clause) ? "marriageDate" : BIRTH.test(clause) ? "birthDate" : null;
      if (own) kind = own;
      for (const match of clause.matchAll(DATE)) {
        const iso = isoOf(match);
        if (!iso || !person || !kind) continue;
        if (!found.some((item) => item.id === person.id && item.field === kind)) found.push({ id: person.id, name: person.name, field: kind, iso });
      }
    }
  }
  return found;
}

async function knownPeople(userId) {
  return prisma.entity.findMany({
    where: { userId, entityType: "person", isSelf: false, status: { not: "archived" }, mergedIntoId: null },
    select: { id: true, name: true, aliases: true, birthDate: true, deathDate: true },
    take: 1000,
  });
}

function spouseEdge(userId, selfId, personId) {
  return prisma.relationship.findFirst({
    where: { userId, type: "spouse_of", status: "confirmed", validTo: null, OR: [{ fromId: personId, toId: selfId }, { fromId: selfId, toId: personId }] },
  });
}

// What a confirm would write: [{ id, name, field, iso, status: "new"|"same"|"differs", current? }].
export async function statedDates(userId, text) {
  if (!/\d{4}/.test(String(text || ""))) return [];
  const people = await knownPeople(userId);
  if (!people.length) return [];
  const found = findStatedDates(text, nameKeys(people));
  if (!found.length) return [];
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true }, select: { id: true } });
  const out = [];
  for (const item of found) {
    let current = null;
    if (item.field === "marriageDate") {
      const edge = self ? await spouseEdge(userId, self.id, item.id) : null;
      if (!edge) continue;
      current = edge.validFrom;
    } else {
      current = people.find((person) => person.id === item.id)?.[item.field] || null;
    }
    const was = current ? new Date(current).toISOString().slice(0, 10) : null;
    out.push({ ...item, status: !was ? "new" : was === item.iso ? "same" : "differs", ...(was && was !== item.iso ? { current: was } : {}) });
  }
  // A birth on or after the death date stays out.
  return out.filter((item) => {
    if (item.field !== "birthDate") return true;
    const death = out.find((other) => other.id === item.id && other.field === "deathDate")?.iso
      || people.find((person) => person.id === item.id)?.deathDate?.toISOString().slice(0, 10);
    return !(death && item.iso >= death);
  });
}

const LABEL = { birthDate: "born", deathDate: "died", marriageDate: "married" };

export function statedDatesLine(items) {
  const fresh = (items || []).filter((item) => item.status === "new");
  const differs = (items || []).filter((item) => item.status === "differs");
  const parts = [];
  if (fresh.length) parts.push(`Also records on their pages: ${fresh.map((item) => `${item.name} ${LABEL[item.field]} ${prettyDay(item.iso)}`).join("; ")}.`);
  if (differs.length) parts.push(`Not changed (the record says otherwise): ${differs.map((item) => `${item.name} ${LABEL[item.field]} ${prettyDay(item.current)} on record, ${prettyDay(item.iso)} here`).join("; ")}.`);
  return parts.join(" ");
}

// On confirm: fill the empty fields only.
export async function applyStatedDates(userId, items) {
  const written = [];
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true }, select: { id: true } });
  for (const item of (items || []).filter((entry) => entry.status === "new")) {
    const value = new Date(`${item.iso}T00:00:00Z`);
    if (item.field === "marriageDate") {
      const edge = self ? await spouseEdge(userId, self.id, item.id) : null;
      if (!edge || edge.validFrom) continue;
      await prisma.relationship.update({ where: { id: edge.id }, data: { validFrom: value } });
    } else {
      const { count } = await prisma.entity.updateMany({ where: { id: item.id, userId, [item.field]: null }, data: { [item.field]: value } });
      if (!count) continue;
    }
    written.push(item);
  }
  return written;
}

export function recordedLine(items) {
  return items?.length ? ` Recorded on their pages: ${items.map((item) => `${item.name} ${LABEL[item.field]} ${prettyDay(item.iso)}`).join("; ")}.` : "";
}
