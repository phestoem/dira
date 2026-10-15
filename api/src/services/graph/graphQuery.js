import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.js";
import { getOrCreateSelf } from "./entityResolver.js";
import { categoryOf, inverseOf, isSymmetric, phraseFor } from "./relationshipTypes.js";

export async function getNeighbors(userId, kind, id, options = {}) {
  const started = Date.now();
  const edges = await loadEdges(userId, options);
  const matches = edges.filter((edge) => touches(edge, kind, id) && active(edge, options.asOf));
  const nodes = await loadNodes(userId, matches);
  const rows = matches.map((edge) => presentNeighbor(edge, kind, id, nodes)).filter(Boolean);
  logSlow("neighbors", started);
  return rows;
}

export async function getSubgraph(userId, seeds, options = {}) {
  const started = Date.now();
  const depth = Math.min(Number(options.depth) || 2, 3);
  const maxNodes = Math.min(Number(options.maxNodes) || 60, 80);
  const edges = await walkEdges(userId, seeds, depth, options);
  const nodes = new Map();
  for (const seed of seeds) nodes.set(`${seed.kind}:${seed.id}`, { kind: seed.kind, id: seed.id });
  for (const edge of edges) {
    if (nodes.size >= maxNodes) break;
    nodes.set(`${edge.fromKind}:${edge.fromId}`, { kind: edge.fromKind, id: edge.fromId });
    if (nodes.size >= maxNodes) break;
    nodes.set(`${edge.toKind}:${edge.toId}`, { kind: edge.toKind, id: edge.toId });
  }
  const hydrated = await loadNodes(userId, [...edges, ...nodes.values()]);
  logSlow("subgraph", started);
  return {
    nodes: [...nodes.values()].map((node) => hydrate(node, hydrated)).filter(Boolean).slice(0, maxNodes),
    edges: edges.slice(0, 120),
  };
}

export function assemblePaths(edges, from, to, maxDepth = 4, limit = 3) {
  const depth = Math.min(maxDepth, 4);
  const paths = [];
  const start = `${from.kind}:${from.id}`;
  const goal = `${to.kind}:${to.id}`;
  const queue = [[{ node: start, edge: null }]];
  const guard = new Set([start]);
  while (queue.length && paths.length < limit) {
    const path = queue.shift();
    const here = path[path.length - 1].node;
    if (path.length > depth + 1) continue;
    if (here === goal && path.length > 1) {
      paths.push(path);
      continue;
    }
    for (const edge of edges) {
      if (path.some((step) => step.edge && step.edge.id === edge.id)) continue;
      const [left, right] = ends(edge);
      let next = null;
      if (left === here) next = right;
      else if (right === here) next = left;
      if (!next) continue;
      const seen = new Set(path.map((step) => step.node));
      if (seen.has(next)) continue;
      if (guard.size > 400) return paths;
      guard.add(next);
      queue.push([...path, { node: next, edge }]);
    }
  }
  return paths;
}

export async function findPaths(userId, from, to, options = {}) {
  const started = Date.now();
  const depth = Math.min(Number(options.maxDepth) || 4, 4);
  const edges = await walkEdges(userId, [from], depth, options);
  const raw = assemblePaths(edges, from, to, depth, options.limit || 3);
  const nodes = await loadNodes(userId, edges);
  logSlow("paths", started);
  return raw.map((path) => path.map((step) => ({
    node: hydrate(parseKey(step.node), nodes),
    edge: step.edge,
    display: step.edge ? phraseFor(step.edge.type, "out") : null,
  })));
}

async function walkEdges(userId, seeds, depth, options = {}) {
  const usable = (seeds || []).filter((seed) => seed?.kind && seed?.id);
  if (!usable.length) return [];
  const statuses = options.includeSuggested ? ["confirmed", "suggested"] : ["confirmed"];
  const asOf = options.asOf ? new Date(options.asOf) : new Date();
  const depthLimit = Math.min(Number(depth) || 2, 4);
  const categories = (options.categories || []).filter(Boolean);
  const seedSql = Prisma.join(
    usable.flatMap((seed) => [
      Prisma.sql`("fromKind" = ${seed.kind} AND "fromId" = ${seed.id})`,
      Prisma.sql`("toKind" = ${seed.kind} AND "toId" = ${seed.id})`,
    ]),
    " OR ",
  );
  const categorySql = categories.length
    ? Prisma.sql`AND r.category IN (${Prisma.join(categories)})`
    : Prisma.empty;
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE walk AS (
      SELECT r.id, r."fromKind", r."fromId", r."toKind", r."toId", r.type, r.category, r.status,
             r."validFrom", r."validTo", r.label, r.confidence, r.strength, r.source, r."evidenceText",
             1 AS depth, ARRAY[r.id]::text[] AS path
      FROM relationships r
      WHERE r."userId" = ${userId}
        AND r.status IN (${Prisma.join(statuses)})
        AND NOT (r."fromKind" = r."toKind" AND r."fromId" = r."toId")
        AND (r."validFrom" IS NULL OR r."validFrom" <= ${asOf})
        AND (r."validTo" IS NULL OR r."validTo" > ${asOf})
        ${categorySql}
        AND (${seedSql})
      UNION ALL
      SELECT r.id, r."fromKind", r."fromId", r."toKind", r."toId", r.type, r.category, r.status,
             r."validFrom", r."validTo", r.label, r.confidence, r.strength, r.source, r."evidenceText",
             w.depth + 1, w.path || r.id
      FROM relationships r
      INNER JOIN walk w
        ON r."userId" = ${userId}
       AND w.depth < ${depthLimit}
       AND NOT (r.id = ANY(w.path))
       AND (
         (r."fromKind" = w."fromKind" AND r."fromId" = w."fromId")
         OR (r."fromKind" = w."toKind" AND r."fromId" = w."toId")
         OR (r."toKind" = w."fromKind" AND r."toId" = w."fromId")
         OR (r."toKind" = w."toKind" AND r."toId" = w."toId")
       )
      WHERE r.status IN (${Prisma.join(statuses)})
        AND NOT (r."fromKind" = r."toKind" AND r."fromId" = r."toId")
        AND (r."validFrom" IS NULL OR r."validFrom" <= ${asOf})
        AND (r."validTo" IS NULL OR r."validTo" > ${asOf})
        ${categorySql}
    )
    SELECT DISTINCT ON (id) id, "fromKind", "fromId", "toKind", "toId", type, category, status,
           "validFrom", "validTo", label, confidence, strength, source, "evidenceText"
    FROM walk
    ORDER BY id
    LIMIT 400
  `;
  return rows.map((row) => ({
    id: row.id,
    fromKind: row.fromKind,
    fromId: row.fromId,
    toKind: row.toKind,
    toId: row.toId,
    type: row.type,
    category: row.category,
    status: row.status,
    validFrom: row.validFrom,
    validTo: row.validTo,
    label: row.label,
    confidence: row.confidence,
    strength: row.strength,
    source: row.source,
    evidenceText: row.evidenceText,
  }));
}

export async function getFamilyTree(userId, options = {}) {
  const up = Math.min(Number(options.generationsUp) || 2, 3);
  const down = Math.min(Number(options.generationsDown) || 2, 3);
  const self = await getOrCreateSelf(userId);
  const edges = (await loadEdges(userId, {})).filter((edge) => edge.category === "family" && edge.status === "confirmed");
  const people = await prisma.entity.findMany({
    where: { userId, entityType: "person", status: { not: "archived" } },
  });
  const byId = new Map(people.map((person) => [person.id, presentPerson(person)]));
  const linked = (id, type, inbound) => familyLinks(edges, id, type, inbound).map((item) => byId.get(item)).filter(Boolean);
  const parents = linked(self.id, "parent_of", true);
  const children = linked(self.id, "parent_of", false);
  return {
    self: byId.get(self.id) || presentPerson(self),
    spouse: linked(self.id, "spouse_of", false),
    parents,
    grandparents: parents.flatMap((parent) => familyLinks(edges, parent.id, "parent_of", true)).map((id) => byId.get(id)).filter(Boolean).slice(0, up * 4),
    siblings: linked(self.id, "sibling_of", false),
    children,
    grandchildren: down > 1 ? children.flatMap((child) => familyLinks(edges, child.id, "parent_of", false)).map((id) => byId.get(id)).filter(Boolean) : [],
  };
}

export async function getEntityTimeline(userId, entityId) {
  const edges = await prisma.relationship.findMany({
    where: {
      userId,
      status: { not: "rejected" },
      OR: [
        { fromKind: "entity", fromId: entityId },
        { toKind: "entity", toId: entityId },
      ],
    },
  });
  const eventIds = edges.filter((edge) => edge.fromKind === "event" || edge.toKind === "event").map((edge) => (edge.fromKind === "event" ? edge.fromId : edge.toId));
  const events = eventIds.length
    ? await prisma.event.findMany({ where: { userId, id: { in: eventIds }, status: { not: "archived" } } })
    : [];
  const points = [
    ...events.map((event) => ({ kind: "event", id: event.id, title: event.title, at: event.occurredAt || event.createdAt })),
    ...edges.filter((edge) => edge.validFrom || edge.validTo).map((edge) => ({
      kind: "edge",
      id: edge.id,
      title: edge.type,
      at: edge.validFrom || edge.validTo,
      ended: Boolean(edge.validTo),
    })),
  ];
  return points.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
}

export async function getMoneyFlows(userId, options = {}) {
  const types = ["paid", "sent_money_to", "funded", "contributed_to"];
  const edges = await prisma.relationship.findMany({
    where: { userId, status: "confirmed", type: { in: types }, fromKind: "entity" },
  });
  const ids = [...new Set(edges.map((edge) => edge.toId))];
  const entities = ids.length ? await prisma.entity.findMany({ where: { userId, id: { in: ids } } }) : [];
  const names = new Map(entities.map((entity) => [entity.id, entity.name]));
  const from = options.from ? new Date(options.from) : null;
  const to = options.to ? new Date(options.to) : null;
  const totals = new Map();
  for (const edge of edges) {
    if (options.counterpart && names.get(edge.toId) !== options.counterpart && edge.toId !== options.counterpart) continue;
    const when = edge.validFrom || edge.createdAt;
    if (from && when < from) continue;
    if (to && when > to) continue;
    const attributes = isObject(edge.attributes) ? edge.attributes : {};
    const amount = Number(attributes.total || attributes.amount || 0);
    const currency = attributes.currency || "TSH";
    const key = `${edge.toId}:${currency}`;
    const row = totals.get(key) || {
      counterpartId: edge.toId,
      name: names.get(edge.toId) || "Unknown",
      currency,
      total: 0,
      count: 0,
      channel: attributes.channel || null,
      last: null,
    };
    row.total += Number.isFinite(amount) ? amount : 0;
    row.count += Number(attributes.count || 1);
    if (!row.last || when > row.last) row.last = when;
    totals.set(key, row);
  }
  return [...totals.values()];
}

export function serializeForPrompt(subgraph, options = {}) {
  const max = Math.min(Number(options.maxTriples) || 40, 40);
  const names = new Map((subgraph.nodes || []).map((node) => [`${node.kind}:${node.id}`, node.name]));
  return (subgraph.edges || []).slice(0, max).map((edge) => {
    const from = names.get(`${edge.fromKind}:${edge.fromId}`) || edge.fromKind;
    const to = names.get(`${edge.toKind}:${edge.toId}`) || edge.toKind;
    const since = edge.validFrom ? ` (since ${edge.validFrom.toISOString().slice(0, 10)})` : "";
    const ended = edge.validTo ? ` (ended ${edge.validTo.toISOString().slice(0, 10)})` : "";
    const tone = edge.status === "suggested" ? " [unconfirmed]" : "";
    return `${from} — ${phraseFor(edge.type, "out")} → ${to}${since}${ended}${tone}`;
  });
}

async function loadEdges(userId, options) {
  const statuses = options.includeSuggested ? ["confirmed", "suggested"] : ["confirmed"];
  return prisma.relationship.findMany({
    where: {
      userId,
      status: { in: statuses },
      ...(options.types?.length ? { type: { in: options.types } } : {}),
      ...(options.categories?.length ? { category: { in: options.categories } } : {}),
    },
    take: 800,
  });
}

async function loadNodes(userId, edges) {
  const ids = { entity: new Set(), event: new Set(), vision: new Set() };
  for (const edge of edges) {
    if (edge.kind && edge.id && !edge.fromId) {
      ids[edge.kind]?.add(edge.id);
      continue;
    }
    ids[edge.fromKind]?.add(edge.fromId);
    ids[edge.toKind]?.add(edge.toId);
  }
  const [entities, events, visions] = await Promise.all([
    ids.entity.size ? prisma.entity.findMany({ where: { userId, id: { in: [...ids.entity] } } }) : [],
    ids.event.size ? prisma.event.findMany({ where: { userId, id: { in: [...ids.event] } } }) : [],
    ids.vision.size ? prisma.vision.findMany({ where: { userId, id: { in: [...ids.vision] } } }) : [],
  ]);
  return {
    entity: new Map(entities.map((item) => [item.id, item])),
    event: new Map(events.map((item) => [item.id, item])),
    vision: new Map(visions.map((item) => [item.id, item])),
  };
}

function presentNeighbor(edge, kind, id, nodes) {
  const outbound = edge.fromKind === kind && edge.fromId === id;
  const otherKind = outbound ? edge.toKind : edge.fromKind;
  const otherId = outbound ? edge.toId : edge.fromId;
  const record = nodes[otherKind]?.get(otherId);
  if (!record) return null;
  const displayType = phraseFor(outbound ? edge.type : inverseOf(edge.type), "out");
  return {
    edge,
    node: { kind: otherKind, id: otherId, name: record.name || record.title, entityType: record.entityType || otherKind },
    direction: outbound ? "out" : "in",
    displayType,
  };
}

function hydrate(node, maps) {
  if (!node?.kind || !node.id) return null;
  const record = maps[node.kind]?.get(node.id);
  if (!record) return { ...node, name: node.kind };
  return { kind: node.kind, id: node.id, name: record.name || record.title, entityType: record.entityType || node.kind, deathDate: record.deathDate || null };
}

function familyLinks(edges, id, type, inbound) {
  const inverse = inverseOf(type);
  const ids = [];
  for (const edge of edges) {
    if (edge.fromKind !== "entity" || edge.toKind !== "entity") continue;
    if (!inbound && (edge.type === type || (isSymmetric(type) && edge.type === type)) && edge.fromId === id) ids.push(edge.toId);
    if (inbound && edge.type === type && edge.toId === id) ids.push(edge.fromId);
    if (inbound && edge.type === inverse && edge.fromId === id) ids.push(edge.toId);
    if (!inbound && isSymmetric(type) && edge.type === type && edge.toId === id) ids.push(edge.fromId);
  }
  return [...new Set(ids)];
}

function presentPerson(person) {
  return {
    id: person.id,
    name: person.name,
    birthDate: person.birthDate,
    deathDate: person.deathDate,
    kind: person.kind,
  };
}

function touches(edge, kind, id) {
  return (edge.fromKind === kind && edge.fromId === id) || (edge.toKind === kind && edge.toId === id);
}

function otherEnd(edge, kind, id) {
  if (edge.fromKind === kind && edge.fromId === id) return { kind: edge.toKind, id: edge.toId };
  return { kind: edge.fromKind, id: edge.fromId };
}

function ends(edge) {
  return [`${edge.fromKind}:${edge.fromId}`, `${edge.toKind}:${edge.toId}`];
}

function parseKey(value) {
  const [kind, id] = String(value).split(":");
  return { kind, id };
}

function active(edge, asOf) {
  const when = asOf ? new Date(asOf) : new Date();
  if (edge.validFrom && edge.validFrom > when) return false;
  if (edge.validTo && edge.validTo <= when) return false;
  return true;
}

function logSlow(name, started) {
  const ms = Date.now() - started;
  if (ms > 200) console.log(`[graph] slow query ${name} ${ms}ms`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export { categoryOf };
