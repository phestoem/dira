import { prisma } from "../prisma.js";

// Links mentions of confirmed people to their records by plain name lookup, with no model call. A person counts as
// confirmed when the record has a confirmed relationship to another record (the rule the bridge uses too); the
// self is left out. A record is found by its full name, an alias, or its first name (3+ letters) when no other
// confirmed person has that first name. Unknown names stay plain names: nothing here creates a record.

function fold(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function confirmedPeople(userId) {
  const persons = await prisma.entity.findMany({
    where: { userId, entityType: "person", isSelf: false, status: { not: "archived" }, mergedIntoId: null },
    select: { id: true, name: true, aliases: true },
    take: 1000,
  });
  if (!persons.length) return [];
  const ids = persons.map((person) => person.id);
  const edges = await prisma.relationship.findMany({
    where: { userId, status: "confirmed", fromKind: "entity", toKind: "entity", OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] },
    select: { fromId: true, toId: true },
  });
  const linked = new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]));
  return persons.filter((person) => linked.has(person.id));
}

// [{ key, id, name }] longest first, so "Bo Linden" wins over "Bo".
export function nameKeys(people) {
  const keys = new Map();
  const firstNames = new Map();
  for (const person of people) {
    for (const name of [person.name, ...(person.aliases || [])]) {
      const key = fold(name);
      if (key.length >= 2 && !keys.has(key)) keys.set(key, person);
    }
    const first = fold(person.name).split(" ")[0];
    if (first && first !== fold(person.name)) firstNames.set(first, firstNames.has(first) && firstNames.get(first).id !== person.id ? null : person);
  }
  for (const [first, person] of firstNames) {
    if (person && first.length >= 3 && !keys.has(first)) keys.set(first, person);
  }
  return [...keys].map(([key, person]) => ({ key, id: person.id, name: person.name })).sort((a, b) => b.key.length - a.key.length);
}

// The confirmed people a text mentions, each once, in order of first mention.
export function mentionedPeople(text, keys) {
  let folded = fold(text);
  if (!folded || !keys.length) return [];
  const found = [];
  for (const entry of keys) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
    const match = pattern.exec(folded);
    if (!match) continue;
    if (!found.some((item) => item.id === entry.id)) found.push({ id: entry.id, name: entry.name, at: match.index });
    // Blank the match so a shorter key (a first name) cannot match inside it again.
    folded = folded.slice(0, match.index) + " ".repeat(entry.key.length) + folded.slice(match.index + entry.key.length);
  }
  return found.sort((a, b) => a.at - b.at).map(({ id, name }) => ({ id, name }));
}

// Event/journal people ([{ name } | { entityId }]) with confirmed people linked: a plain name that is a confirmed
// person gets its entityId, and confirmed people the text mentions are added. Nothing is removed.
export function linkPeople(people, text, keys) {
  const byKey = new Map(keys.map((entry) => [entry.key, entry]));
  const out = [];
  const seen = new Set();
  for (const person of Array.isArray(people) ? people : []) {
    if (person?.entityId) {
      if (!seen.has(person.entityId)) out.push(person);
      seen.add(person.entityId);
      continue;
    }
    const name = typeof person === "string" ? person : person?.name;
    const match = byKey.get(fold(name));
    if (!match) {
      out.push(typeof person === "string" ? { name: person, role: "mentioned" } : person);
    } else if (!seen.has(match.id)) {
      seen.add(match.id);
      out.push({ ...(typeof person === "object" ? person : {}), name: match.name, entityId: match.id, role: person?.role || "mentioned" });
    }
  }
  for (const item of mentionedPeople(text, keys)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ name: item.name, entityId: item.id, role: "mentioned" });
  }
  return out;
}

export async function linkConfirmedPeople(userId, people, text) {
  const keys = nameKeys(await confirmedPeople(userId));
  return linkPeople(people, text, keys);
}
