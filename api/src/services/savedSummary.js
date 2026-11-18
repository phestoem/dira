import { prisma } from "../prisma.js";

// The key fields of a saved event in one line, read back from what was stored: title, dates, people, amount.
// "Trip to Lakeview, 10 Mar 2027 → 17 Mar 2027, with Bo Linden and Cy Marsh, 1,200 EUR"

export function formatDay(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

export function dateRange(start, end) {
  const from = formatDay(start);
  const to = formatDay(end);
  if (from && to && from !== to) return `${from} → ${to}`;
  return from || (to ? `until ${to}` : "");
}

export function joinNames(names) {
  const list = [...new Set(names.map((name) => String(name || "").trim()).filter(Boolean))];
  if (list.length <= 1) return list[0] || "";
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

export function amountText(financials) {
  const amount = Number(financials?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${financials.currency || ""}`.trim();
}

// Plain fields, no database: also used for the preview before saving.
export function summaryLine({ title, start, end, people = [], financials }) {
  const names = joinNames(people);
  return [title || "Untitled", dateRange(start, end), names ? `with ${names}` : "", amountText(financials)].filter(Boolean).join(", ");
}

// People on an event are { name } or { entityId }; linked person records are shown by their record name (a linked
// project or vehicle is not a person and is left out).
export async function eventPeopleNames(userId, event) {
  const people = Array.isArray(event?.people) ? event.people : [];
  const ids = people.map((person) => person?.entityId).filter(Boolean);
  const entities = ids.length
    ? await prisma.entity.findMany({ where: { userId, id: { in: ids }, isSelf: false, entityType: "person" }, select: { id: true, name: true } })
    : [];
  const byId = new Map(entities.map((entity) => [entity.id, entity.name]));
  return people
    .filter((person) => person?.role !== "location")
    .map((person) => (person?.entityId ? byId.get(person.entityId) : person?.name))
    .filter(Boolean);
}

export async function savedSummary(userId, event) {
  return summaryLine({
    title: event.title,
    start: event.occurredAt,
    end: event.endsAt,
    people: await eventPeopleNames(userId, event),
    financials: event.financials,
  });
}
