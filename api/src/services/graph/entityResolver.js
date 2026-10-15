import { prisma } from "../../prisma.js";
import { inverseOf, isSymmetric } from "./relationshipTypes.js";

const HONORIFIC = /^(mr|mrs|ms|dr|prof|ndugu|bi|bwana|mzee)\.?\s+/i;
const KINSHIP = [
  { pattern: /\b(my|our)\s+(mother|mum|mom|mama)\b|\bmama\s+yangu\b/i, type: "parent_of", kind: "parent" },
  { pattern: /\b(my|our)\s+(father|dad|baba)\b|\bbaba\s+yangu\b/i, type: "parent_of", kind: "parent" },
  { pattern: /\b(my|our)\s+(wife|husband|spouse)\b|\b(mke|mume)\s+yangu\b/i, type: "spouse_of", kind: "spouse" },
  { pattern: /\b(my|our)\s+(sister|brother|sibling)\b|\b(dada|kaka)\s+yangu\b/i, type: "sibling_of", kind: "sibling" },
  { pattern: /\b(my|our)\s+(son|daughter|child)\b|\bmtoto\s+wangu\b/i, type: "child_of", kind: "child" },
];

export function normalizeName(value) {
  let text = String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(HONORIFIC, "");
  text = text.replace(/^mama\s+(?=\p{L}{2,})/u, "");
  return text.replace(/\s+/g, " ").trim();
}

export function chooseSelfName({ profileName, handle, eventNames = [], current } = {}) {
  const profile = String(profileName || "").trim();
  if (profile.split(/\s+/).filter(Boolean).length >= 2) return profile;
  const ranked = eventNames
    .filter((item) => item?.name && normalizeName(item.name).split(" ").length >= 2)
    .slice()
    .sort((left, right) => (right.count || 0) - (left.count || 0) || wordCount(right.name) - wordCount(left.name));
  if (ranked[0]?.name) return ranked[0].name.trim();
  if (profile) return profile;
  const present = String(current || "").trim();
  return present || String(handle || "").trim() || "Me";
}

export async function getOrCreateSelf(userId) {
  const existing = await prisma.entity.findFirst({
    where: { userId, isSelf: true, status: { not: "archived" } },
  });
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const profile = user?.name?.trim() || "";
  const weak = !existing || wordCount(existing.name) < 2;
  let best = wordCount(profile) >= 2 ? profile : "";
  if (!best && weak) {
    const found = await namesSeenAsSelf(userId, [profile, user?.handle, existing?.name]);
    best = chooseSelfName({ profileName: profile, handle: user?.handle, eventNames: found, current: existing?.name });
  }
  if (!best) best = profile || existing?.name || "Me";
  const aliases = mergeAliases(existing?.aliases, [user?.handle, existing?.name, "me", "i", "mimi"]);
  if (!existing) {
    return prisma.entity.create({
      data: {
        userId,
        name: best,
        entityType: "person",
        kind: "self",
        isSelf: true,
        normalizedName: normalizeName(best),
        aliases,
        attributes: { email: user?.email || null },
        space: "personal",
        status: "active",
      },
    });
  }
  const data = {};
  if (weak && wordCount(best) >= 2 && normalizeName(best) !== normalizeName(existing.name)) {
    data.name = best;
    data.normalizedName = normalizeName(best);
  }
  const nextAliases = mergeAliases(data.name ? [existing.name, ...aliases] : aliases, []);
  if (nextAliases.join("\n") !== (existing.aliases || []).join("\n")) data.aliases = nextAliases;
  if (!Object.keys(data).length) return existing;
  return prisma.entity.update({ where: { id: existing.id }, data });
}

export async function resolveEntity(userId, input, options = {}) {
  const readOnly = Boolean(options.readOnly);
  const name = String(input?.name || "").trim();
  const entityType = cleanType(input?.entityType);
  if (!name) return { entity: null, created: false, matchedBy: "none", confidence: 0, candidates: [] };
  if (input?.entityType === "self" || isSelfName(name)) {
    const self = readOnly
      ? await prisma.entity.findFirst({ where: { userId, isSelf: true, status: { not: "archived" } } })
      : await getOrCreateSelf(userId);
    return { entity: self, created: false, matchedBy: "self", confidence: 1, candidates: [] };
  }

  const kinship = kinshipOf(name);
  if (kinship) {
    const self = await prisma.entity.findFirst({ where: { userId, isSelf: true, status: { not: "archived" } } });
    if (self) {
      const matches = await kinshipMatches(userId, self.id, kinship.type);
      if (matches.length === 1) {
        return { entity: matches[0], created: false, matchedBy: "kinship", confidence: 0.92, candidates: [] };
      }
      if (matches.length > 1) {
        return { entity: null, created: false, matchedBy: "ambiguous", confidence: 0.4, candidates: matches };
      }
    }
  }

  const normalized = normalizeName(name);
  if (!normalized) return { entity: null, created: false, matchedBy: "none", confidence: 0, candidates: [] };

  const pool = await prisma.entity.findMany({
    where: { userId, status: { not: "archived" }, mergedIntoId: null, ...(entityType ? { entityType } : {}) },
    take: 200,
  });
  const exact = pool.find((entity) => entity.normalizedName === normalized || normalizeName(entity.name) === normalized);
  if (exact) return { entity: exact, created: false, matchedBy: "name", confidence: 0.98, candidates: [] };

  const alias = pool.find((entity) => (entity.aliases || []).some((item) => normalizeName(item) === normalized));
  if (alias) return { entity: alias, created: false, matchedBy: "alias", confidence: 0.9, candidates: [] };

  const first = normalized.split(" ")[0];
  if (first.length >= 3) {
    const people = pool.filter((entity) => entity.entityType === "person" || !entityType);
    const firstMatches = people.filter((entity) => normalizeName(entity.name).split(" ")[0] === first);
    if (firstMatches.length === 1) {
      return { entity: firstMatches[0], created: false, matchedBy: "first-name", confidence: 0.7, candidates: [] };
    }
    if (firstMatches.length > 1) {
      return { entity: null, created: false, matchedBy: "ambiguous", confidence: 0.4, candidates: firstMatches.slice(0, 3) };
    }
  }

  if (readOnly) return { entity: null, created: false, matchedBy: "none", confidence: 0, candidates: [] };

  const created = await prisma.entity.create({
    data: {
      userId,
      name: name.slice(0, 160),
      entityType: entityType || "other",
      kind: textOrNull(input?.kind),
      normalizedName: normalized,
      aliases: [name.slice(0, 160)],
      space: "personal",
      status: "active",
    },
  });
  return { entity: created, created: true, matchedBy: "created", confidence: 0.55, candidates: [] };
}

export async function mergeEntities(userId, keepId, mergeId) {
  if (keepId === mergeId) throw graphError("Choose two different records", 400);
  const [keep, merge] = await Promise.all([
    prisma.entity.findFirst({ where: { id: keepId, userId } }),
    prisma.entity.findFirst({ where: { id: mergeId, userId } }),
  ]);
  if (!keep || !merge) throw graphError("Entity not found", 404);
  if (merge.isSelf) throw graphError("The self record cannot be merged away", 400);

  const edges = await prisma.relationship.findMany({
    where: {
      userId,
      OR: [
        { fromKind: "entity", fromId: mergeId },
        { toKind: "entity", toId: mergeId },
      ],
    },
  });
  let moved = 0;
  let deduped = 0;
  for (const edge of edges) {
    const next = {
      fromId: edge.fromKind === "entity" && edge.fromId === mergeId ? keepId : edge.fromId,
      toId: edge.toKind === "entity" && edge.toId === mergeId ? keepId : edge.toId,
    };
    if (next.fromId === next.toId && edge.fromKind === edge.toKind) {
      await prisma.relationship.delete({ where: { id: edge.id } });
      deduped += 1;
      continue;
    }
    const clash = await prisma.relationship.findFirst({
      where: {
        userId,
        fromKind: edge.fromKind,
        fromId: next.fromId,
        type: edge.type,
        toKind: edge.toKind,
        toId: next.toId,
        NOT: { id: edge.id },
      },
    });
    if (clash) {
      await prisma.relationship.update({
        where: { id: clash.id },
        data: {
          confidence: Math.max(clash.confidence, edge.confidence),
          status: clash.status === "confirmed" || edge.status === "confirmed" ? "confirmed" : clash.status,
        },
      });
      await prisma.relationship.delete({ where: { id: edge.id } });
      deduped += 1;
    } else {
      await prisma.relationship.update({ where: { id: edge.id }, data: next });
      moved += 1;
    }
  }

  await repointJson(userId, mergeId, keep);
  const aliases = [...new Set([...(keep.aliases || []), ...(merge.aliases || []), merge.name])];
  await prisma.entity.update({
    where: { id: keepId },
    data: {
      aliases,
      description: keep.description || merge.description,
      kind: keep.kind || merge.kind,
      birthDate: keep.birthDate || merge.birthDate,
      deathDate: keep.deathDate || merge.deathDate,
      normalizedName: keep.normalizedName || normalizeName(keep.name),
    },
  });
  await prisma.entity.update({
    where: { id: mergeId },
    data: { mergedIntoId: keepId, status: "archived" },
  });
  return { keepId, mergeId, moved, deduped, aliases: aliases.length };
}

export async function expandGraphNames(userId, names) {
  const list = (names || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (!list.length) return [];
  const entities = await prisma.entity.findMany({
    where: { userId, status: { not: "archived" }, mergedIntoId: null },
    select: { name: true, aliases: true, normalizedName: true },
    take: 200,
  });
  const extra = [];
  for (const name of list) {
    const normalized = normalizeName(name);
    const hit = entities.find((entity) => entity.normalizedName === normalized || normalizeName(entity.name) === normalized || (entity.aliases || []).some((alias) => normalizeName(alias) === normalized));
    if (hit) extra.push(hit.name, ...(hit.aliases || []));
  }
  return [...new Set([...list, ...extra])].slice(0, 12);
}

export async function findDuplicateCandidates(userId) {
  const people = await prisma.entity.findMany({
    where: { userId, entityType: "person", status: { not: "archived" }, mergedIntoId: null, isSelf: false },
    take: 300,
  });
  const pairs = [];
  for (let i = 0; i < people.length; i += 1) {
    for (let j = i + 1; j < people.length; j += 1) {
      const left = people[i];
      const right = people[j];
      if (notDuplicate(left, right.id) || notDuplicate(right, left.id)) continue;
      const sameBirth = left.birthDate && right.birthDate && left.birthDate.getTime() === right.birthDate.getTime();
      const score = nameSimilarity(normalizeName(left.name), normalizeName(right.name));
      if (sameBirth || score >= 0.84) {
        pairs.push({
          left: { id: left.id, name: left.name },
          right: { id: right.id, name: right.name },
          score: sameBirth ? Math.max(score, 0.9) : score,
        });
      }
    }
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, 20);
}

async function kinshipMatches(userId, selfId, type) {
  const inverse = inverseOf(type);
  const edges = await prisma.relationship.findMany({
    where: {
      userId,
      status: "confirmed",
      OR: [
        { type, toKind: "entity", toId: selfId, fromKind: "entity" },
        { type: inverse, fromKind: "entity", fromId: selfId, toKind: "entity" },
        ...(isSymmetric(type) ? [{ type, fromKind: "entity", fromId: selfId, toKind: "entity" }] : []),
      ],
    },
  });
  const ids = [...new Set(edges.map((edge) => (edge.fromId === selfId ? edge.toId : edge.fromId)))];
  if (!ids.length) return [];
  return prisma.entity.findMany({ where: { userId, id: { in: ids }, status: { not: "archived" } } });
}

async function repointJson(userId, mergeId, keep) {
  const [events, visions] = await Promise.all([
    prisma.event.findMany({ where: { userId, status: { not: "archived" } }, select: { id: true, people: true, places: true } }),
    prisma.vision.findMany({ where: { userId, status: { not: "archived" } }, select: { id: true, connectedEntities: true } }),
  ]);
  for (const event of events) {
    const people = rewriteRefs(event.people, mergeId, keep);
    const places = rewriteRefs(event.places, mergeId, keep);
    if (people.changed || places.changed) {
      await prisma.event.update({
        where: { id: event.id },
        data: { ...(people.changed ? { people: people.value } : {}), ...(places.changed ? { places: places.value } : {}) },
      });
    }
  }
  for (const vision of visions) {
    const next = rewriteRefs(vision.connectedEntities, mergeId, keep);
    if (next.changed) await prisma.vision.update({ where: { id: vision.id }, data: { connectedEntities: next.value } });
  }
}

function rewriteRefs(value, mergeId, keep) {
  if (!Array.isArray(value)) return { changed: false, value };
  let changed = false;
  const next = value.map((item) => {
    if (!item || item.entityId !== mergeId) return item;
    changed = true;
    return { ...item, entityId: keep.id, name: item.name || keep.name };
  });
  return { changed, value: next };
}

function kinshipOf(name) {
  return KINSHIP.find((item) => item.pattern.test(name)) || null;
}

function isSelfName(name) {
  return /^(i|me|myself|mimi|self)$/i.test(name.trim());
}

function wordCount(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean).length;
}

function mergeAliases(existing, extra) {
  const seen = new Set();
  const out = [];
  for (const item of [...(existing || []), ...(extra || [])]) {
    const text = String(item || "").trim();
    const key = normalizeName(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.slice(0, 40);
}

async function namesSeenAsSelf(userId, seeds) {
  const roots = seeds.map((seed) => normalizeName(seed).split(" ")[0]).filter((seed) => seed && seed.length >= 3);
  if (!roots.length) return [];
  const events = await prisma.event.findMany({
    where: { userId, status: { not: "archived" } },
    select: { title: true, understoodMeaning: true, fullText: true, people: true },
  });
  const counts = new Map();
  const note = (name) => {
    const text = String(name || "").trim();
    if (wordCount(text) < 2) return;
    const first = normalizeName(text).split(" ")[0];
    if (!roots.includes(first)) return;
    const key = normalizeName(text);
    const current = counts.get(key) || { name: text, count: 0 };
    current.count += 1;
    if (text.length > current.name.length) current.name = text;
    counts.set(key, current);
  };
  for (const event of events) {
    const people = Array.isArray(event.people) ? event.people : [];
    for (const person of people) note(typeof person === "string" ? person : person?.name);
    const blob = [event.title, event.understoodMeaning, String(event.fullText || "").slice(0, 4000)].filter(Boolean).join("\n");
    for (const match of blob.matchAll(/\b[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,3}\b/gu)) note(match[0]);
  }
  return [...counts.values()];
}

function cleanType(value) {
  const text = String(value || "").toLowerCase();
  if (["person", "place", "project", "organisation", "property", "asset", "vehicle", "document", "other"].includes(text)) return text;
  return "";
}

function notDuplicate(entity, otherId) {
  const list = entity?.attributes?.notDuplicateOf;
  return Array.isArray(list) && list.includes(otherId);
}

function nameSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = new Set(left.split(" "));
  const b = new Set(right.split(" "));
  const shared = [...a].filter((word) => b.has(word) && word.length > 2);
  return shared.length / Math.max(a.size, b.size);
}

function textOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

function graphError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
