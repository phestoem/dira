// The claim store: writes extracted claims for one source, resolving every mention through one resolver. Exact
// repeats are skipped; a correction marks the claims it replaces superseded and points at them. Nothing is deleted.
import { prisma } from "../../prisma.js";
import { materialize } from "./materialize.js";
import { createResolver } from "./resolver.js";
import { PREDICATES, SINGLE_VALUED } from "./vocabulary.js";

// "2024" → year, "2024-03" → month, "2024-03-15" → day. Anything else is not a date the text stated.
export function parseWhen(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), month ? Number(month) - 1 : 0, day ? Number(day) : 1));
  if (Number.isNaN(date.getTime()) || (month && date.getUTCMonth() !== Number(month) - 1)) return null;
  return { date, precision: day ? "day" : month ? "month" : "year" };
}

const iso = (date, precision) => (date ? date.toISOString().slice(0, { year: 4, month: 7, day: 10 }[precision] || 10) : "");
const clean = (value) => (value == null || value === "" ? null : String(value).trim());

function key(row) {
  const ends = [row.subjectId, row.objectId || ""];
  if (PREDICATES[row.predicate]?.symmetric) ends.sort();
  return [row.predicate, ...ends, (row.value || "").toLowerCase(), row.amount ?? "", (row.currency || "").toUpperCase(), row.contextId || "", iso(row.date, row.datePrecision), iso(row.until, row.untilPrecision)].join("|");
}

// Shape checks only (the extractor's validator judges meaning): a known predicate, an object when the predicate
// needs one, a value when it needs one, dates the text could state.
const named = (mention) => mention === "me" || Boolean(String(mention?.name || "").trim());

export function shapeProblem(item) {
  const spec = PREDICATES[item.predicate];
  if (!spec) return "unknown-predicate";
  if (!named(item.subject)) return "no-subject";
  if (spec.object === "entity" && !named(item.object)) return "no-object";
  if ((spec.object === "value" || spec.object === "date") && clean(item.value) == null && item.amount == null && !item.label) return "no-value";
  if (spec.object === "date" && !parseWhen(item.value)) return "bad-date-value";
  for (const field of ["date", "until"]) if (item[field] && !parseWhen(item[field])) return `bad-${field}`;
  if (item.amount != null && !Number.isFinite(Number(item.amount))) return "bad-amount";
  return null;
}

// items: [{ subject, predicate, object?, value?, label?, amount?, currency?, context?, date?, until?, evidence?,
// corrects? }] where subject/object/context are { name, type } (or "me"). meta: { eventId, source, sourceRef,
// extractor, model }.
export async function writeClaims(userId, items, meta = {}) {
  const resolver = await createResolver(userId);
  const existing = await prisma.claim.findMany({ where: { userId, status: { in: ["stated", "confirmed"] } } });
  const seen = new Set(existing.map(key));
  const written = [];
  const skipped = [];
  let superseded = 0;
  for (const item of items) {
    const problem = shapeProblem(item);
    if (problem) { skipped.push({ item, reason: problem }); continue; }
    const when = parseWhen(item.date);
    const until = parseWhen(item.until);
    const row = {
      userId,
      subjectId: await resolver.resolve(item.subject),
      predicate: item.predicate,
      objectId: item.object ? await resolver.resolve(item.object) : null,
      value: clean(item.value),
      label: clean(item.label),
      amount: item.amount == null ? null : Number(item.amount),
      currency: clean(item.currency)?.toUpperCase() || null,
      contextId: item.context ? await resolver.resolve(item.context) : null,
      date: when?.date || null,
      datePrecision: when?.precision || null,
      until: until?.date || null,
      untilPrecision: until?.precision || null,
      evidence: clean(item.evidence),
      eventId: meta.eventId || null,
      source: meta.source || null,
      sourceRef: meta.sourceRef || null,
      extractor: meta.extractor || null,
      model: meta.model || null,
    };
    if (row.subjectId && row.subjectId === row.objectId) { skipped.push({ item, reason: "self-loop" }); continue; }
    if (seen.has(key(row))) { skipped.push({ item, reason: "duplicate" }); continue; }
    if (item.corrects || SINGLE_VALUED.has(row.predicate)) {
      // The claims this one corrects: same subject and predicate (and same object, when the object is an entity).
      const replaced = existing.filter((old) => old.subjectId === row.subjectId && old.predicate === row.predicate && old.status !== "superseded" && (PREDICATES[row.predicate].object !== "entity" || old.objectId === row.objectId) && (item.corrects || old.value !== row.value));
      if (replaced.length) {
        await prisma.claim.updateMany({ where: { id: { in: replaced.map((old) => old.id) } }, data: { status: "superseded" } });
        replaced.forEach((old) => { old.status = "superseded"; });
        row.supersedesId = replaced.at(-1).id;
        superseded += replaced.length;
      }
    }
    const claim = await prisma.claim.create({ data: row });
    existing.push(claim);
    seen.add(key(claim));
    written.push(claim);
  }
  await materialize(userId);
  return { written, skipped, superseded };
}
