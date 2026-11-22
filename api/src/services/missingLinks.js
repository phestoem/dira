// "Which connections are missing?": answered by code, never the model. A record is suggested for a link when it names
// one of the person's projects, places or people (or a project's place) and is not already tied to that record: by
// an entity ref on the event, a relationship row of any status (a rejected one included: that was a "no"), or a
// vision that holds both. Nothing is written here; applyMissingLinks writes only the ticked suggestions.
import { prisma } from "../prisma.js";
import { isReadonly } from "../readonly.js";

const MISSING = /\b(connections?|links?|linked|connected)\b[^?.!]{0,40}\b(missing|miss|should|ought|could|forg[eo]t|haven'?t|not yet|not linked|not connected)\b|\b(missing|unlinked|not linked|not connected|un-?connected)\b[^?.!]{0,30}\b(connections?|links?|records?)\b|\b(records?|events?)\b[^?.!]{0,20}\b(unlinked|not linked|not connected)\b|\bwhat(?:'s| is| am i)? ?(?:not|n't) (?:linked|connected)\b/i;

export function isMissingConnectionsQuestion(text) {
  const value = String(text || "");
  return value.length <= 200 && MISSING.test(value);
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrase = (key) => new RegExp(`(?<![\\p{L}\\p{N}])${key.split(/\s+/).map(escape).join("[\\s_-]+")}(?![\\p{L}\\p{N}])`, "giu");
const STOP = new Set(["me", "i", "mimi", "home", "family", "house", "land", "project", "place", "the", "my"]);
const KIND_ORDER = { project: 0, place: 1, person: 2 };
const refs = (value) => (Array.isArray(value) ? value : []);

// Name keys per entity: its name, aliases, and a first name no other record's name contains. A project's place
// ("Elmstead, Northshire") adds its first part as a place key.
export function entityKeys(entities) {
  // How many records carry each word of a name anywhere in it (a parent's first name can be a child's middle name).
  const firsts = new Map();
  for (const entity of entities) {
    for (const word of new Set(String(entity.name || "").toLowerCase().split(/\s+/).filter(Boolean))) firsts.set(word, (firsts.get(word) || 0) + 1);
  }
  const keys = [];
  for (const entity of entities) {
    const names = new Set([entity.name, ...(entity.aliases || [])].map((name) => String(name || "").trim()).filter(Boolean));
    const parts = String(entity.name || "").trim().split(/\s+/);
    if (entity.entityType === "person" && parts.length > 1 && firsts.get(parts[0].toLowerCase()) === 1) names.add(parts[0]);
    for (const name of names) {
      if (name.length < 3 || STOP.has(name.toLowerCase())) continue;
      keys.push({ entity, key: name, via: "name" });
    }
    const place = String(entity.attributes?.place || "").split(",")[0].trim();
    if (entity.entityType === "project" && place.length >= 3 && !names.has(place)) keys.push({ entity, key: place, via: "place" });
  }
  // A key two records share says nothing about which one is meant.
  const owners = new Map();
  for (const item of keys) {
    const lower = item.key.toLowerCase();
    owners.set(lower, new Set([...(owners.get(lower) || []), item.entity.id]));
  }
  return keys.filter((item) => owners.get(item.key.toLowerCase()).size === 1).sort((left, right) => right.key.length - left.key.length);
}

// Which entities the text names, longest key first, so "Wren Ash Vale" is not also "Ash Vale".
export function mentions(text, keys) {
  let rest = String(text || "");
  const found = new Map();
  for (const item of keys) {
    const pattern = phrase(item.key);
    if (!pattern.test(rest)) continue;
    rest = rest.replace(phrase(item.key), (match) => " ".repeat(match.length));
    if (!found.has(item.entity.id)) found.set(item.entity.id, item);
  }
  return [...found.values()];
}

function recordText(record) {
  const named = [...refs(record.places), ...refs(record.people)].map((ref) => ref?.name).filter(Boolean);
  return [record.title, record.rawInput, record.understoodMeaning, record.summary, record.rawContent, record.notes, ...named].filter(Boolean).join(" \n ");
}

const day = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "");

export function findMissingLinks({ entities, events, visions, relationships }) {
  const usable = entities.filter((entity) => !entity.mergedIntoId && entity.status !== "archived" && KIND_ORDER[entity.entityType] !== undefined);
  // The person's own name is matched too, only so that "Robin Ash Vale" does not count as naming a parent
  // whose name it contains; the self record is never suggested.
  const keys = entityKeys(usable);
  const mentionsOf = (record) => mentions(recordText(record), keys).filter((item) => !item.entity.isSelf);
  const related = new Set(relationships.flatMap((row) => [`${row.fromId}|${row.toId}`, `${row.toId}|${row.fromId}`]));
  const throughVision = new Set();
  for (const vision of visions) {
    for (const event of refs(vision.connectedEvents)) {
      for (const entity of refs(vision.connectedEntities)) if (event?.eventId && entity?.entityId) throughVision.add(`${event.eventId}|${entity.entityId}`);
    }
  }
  const out = [];
  for (const event of events) {
    if (event.status === "archived") continue;
    const linked = new Set([...refs(event.people), ...refs(event.places)].map((ref) => ref?.entityId).filter(Boolean));
    for (const { entity, key, via } of mentionsOf(event)) {
      if (linked.has(entity.id) || related.has(`${event.id}|${entity.id}`) || throughVision.has(`${event.id}|${entity.id}`)) continue;
      out.push({
        id: `event:${event.id}:${entity.id}`, recordKind: "event", recordId: event.id, entityId: entity.id, key,
        line: `“${event.title}”${event.occurredAt ? ` (${day(event.occurredAt)})` : ""} → ${entity.entityType} “${entity.name}”: ${via === "place" ? `mentions its place, ${key}` : `mentions “${key}”`}`,
        order: [KIND_ORDER[entity.entityType], entity.name, day(event.occurredAt) || "9999", event.title],
      });
    }
  }
  for (const vision of visions) {
    if (["archived", "released"].includes(vision.status)) continue;
    const linked = new Set(refs(vision.connectedEntities).map((ref) => ref?.entityId).filter(Boolean));
    for (const { entity, key, via } of mentionsOf(vision)) {
      if (entity.entityType === "person") continue;
      if (linked.has(entity.id) || related.has(`${vision.id}|${entity.id}`)) continue;
      out.push({
        id: `vision:${vision.id}:${entity.id}`, recordKind: "vision", recordId: vision.id, entityId: entity.id, key,
        line: `vision “${vision.title}” → ${entity.entityType} “${entity.name}”: ${via === "place" ? `mentions its place, ${key}` : `mentions “${key}”`}`,
        order: [KIND_ORDER[entity.entityType], entity.name, "0000", vision.title],
      });
    }
  }
  const cmp = (left, right) => {
    for (let i = 0; i < left.order.length; i += 1) {
      if (left.order[i] !== right.order[i]) return left.order[i] < right.order[i] ? -1 : 1;
    }
    return 0;
  };
  return out.sort(cmp).map(({ order, ...item }) => item);
}

async function loadAll(userId) {
  const [entities, events, visions, relationships] = await Promise.all([
    prisma.entity.findMany({ where: { userId }, select: { id: true, name: true, aliases: true, entityType: true, status: true, isSelf: true, mergedIntoId: true, attributes: true } }),
    prisma.event.findMany({ where: { userId }, select: { id: true, title: true, status: true, rawInput: true, understoodMeaning: true, notes: true, occurredAt: true, people: true, places: true } }),
    prisma.vision.findMany({ where: { userId }, select: { id: true, title: true, status: true, summary: true, rawContent: true, notes: true, connectedEntities: true, connectedEvents: true } }),
    prisma.relationship.findMany({ where: { userId }, select: { fromId: true, toId: true } }),
  ]);
  return { entities, events, visions, relationships };
}

export async function missingLinks(userId) {
  return findMissingLinks(await loadAll(userId));
}

export const NOTHING_MISSING = "I found no unlinked records that name your projects, places or people. Everything that mentions them is already linked.";

export function missingLinksText(items) {
  if (!items.length) return NOTHING_MISSING;
  return [`Records that name one of your projects, places or people but are not linked to it (${items.length}):`, ...items.map((item) => `- ${item.line}`)].join("\n");
}

// Writes only the chosen suggestions, each only if the record still lacks that link. Returns lines written.
export async function applyMissingLinks(userId, items, chosen) {
  if (isReadonly()) return { written: [], readonly: true };
  const written = [];
  for (const item of items) {
    if (!chosen.has(item.id)) continue;
    const entity = await prisma.entity.findFirst({ where: { id: item.entityId, userId } });
    if (!entity) continue;
    const ref = { entityId: entity.id, name: entity.name, role: entity.entityType === "project" ? "project" : entity.entityType === "place" ? "location" : "mentioned" };
    if (item.recordKind === "event") {
      const event = await prisma.event.findFirst({ where: { id: item.recordId, userId } });
      if (!event) continue;
      const field = entity.entityType === "place" ? "places" : "people";
      const list = refs(event[field]);
      if ([...refs(event.people), ...refs(event.places)].some((existing) => existing?.entityId === entity.id)) continue;
      // A ref that already names the record without its id gets the id; otherwise the ref is added.
      const names = new Set([entity.name, item.key].filter(Boolean).map((name) => name.toLowerCase()));
      const same = list.findIndex((existing) => !existing?.entityId && names.has(String(existing?.name || "").toLowerCase()));
      const next = same >= 0 ? list.map((existing, index) => (index === same ? { ...existing, entityId: entity.id } : existing)) : [...list, ref];
      const result = await prisma.event.updateMany({ where: { id: event.id, userId, updatedAt: event.updatedAt }, data: { [field]: next } });
      if (result.count === 1) written.push(`“${event.title}” → ${entity.name}`);
    } else {
      const vision = await prisma.vision.findFirst({ where: { id: item.recordId, userId } });
      if (!vision || refs(vision.connectedEntities).some((existing) => existing?.entityId === entity.id)) continue;
      const result = await prisma.vision.updateMany({ where: { id: vision.id, userId, updatedAt: vision.updatedAt }, data: { connectedEntities: [...refs(vision.connectedEntities), ref], lastTouchedAt: new Date() } });
      if (result.count === 1) written.push(`vision “${vision.title}” → ${entity.name}`);
    }
  }
  return { written };
}
