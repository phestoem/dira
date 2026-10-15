import { prisma } from "../../prisma.js";
import { getOrCreateSelf, resolveEntity } from "./entityResolver.js";
import { categoryOf, isSensitive, isSymmetric, normalizeType } from "./relationshipTypes.js";

const GROQ_MODEL = "qwen/qwen3.8-27b";

const EXTRACT_PROMPT = `Extract relationship triples that are actually stated in the text.
Return JSON only:
{ "triples": [{ "subject": { "name": "", "type": "person|place|property|project|organisation|asset|vehicle|self" }, "predicate": "", "object": { "name": "", "type": "" }, "validFrom": null, "validTo": null, "attributes": {}, "confidence": 0.5, "evidence": "" }], "entityFacts": [{ "name": "", "birthDate": null, "deathDate": null, "kind": null }] }
Rules:
- "I", "me", "my", "mimi", "yangu" are type self.
- Do not invent family links that were not said.
- A death does not end a family edge. Put the date on entityFacts.deathDate.
- Selling, moving out, or a role ending sets validTo.
- Money transfers set attributes.amount and attributes.currency.
- At most 15 triples.
- Work in English or Swahili.`;

export async function extractTriples(text, context = {}) {
  const body = String(text || "").trim();
  if (body.length < 8) return { triples: [], entityFacts: [] };
  const known = Array.isArray(context.known) ? context.known.slice(0, 40) : [];
  const user = [
    context.selfName ? `Self: ${context.selfName}` : "",
    context.today ? `Today: ${context.today}` : "",
    context.title ? `Title: ${context.title}` : "",
    known.length ? `Known: ${known.map((item) => `${item.name} (${item.entityType})`).join("; ")}` : "",
    body.slice(0, 3500),
  ].filter(Boolean).join("\n");
  try {
    const raw = await completeJson(EXTRACT_PROMPT, user);
    const parsed = parseJson(raw);
    const triples = Array.isArray(parsed?.triples) ? parsed.triples.slice(0, 15) : [];
    const entityFacts = Array.isArray(parsed?.entityFacts) ? parsed.entityFacts.slice(0, 15) : [];
    return { triples, entityFacts };
  } catch (err) {
    console.error("[graph] extract failed:", err.message);
    return { triples: [], entityFacts: [] };
  }
}

export async function commitTriples(userId, triples, options = {}) {
  const source = options.source || "intake";
  const result = { created: 0, updated: 0, suggested: 0, conflicts: [] };
  const self = await getOrCreateSelf(userId);
  for (const triple of Array.isArray(triples) ? triples : []) {
    const subject = await resolveSide(userId, triple.subject, self);
    const object = await resolveSide(userId, triple.object, self);
    if (!subject.entity || !object.entity || subject.entity.id === object.entity.id) continue;
    const normalized = normalizeType(triple.predicate);
    let from = subject;
    let to = object;
    if (normalized.reverse) [from, to] = [to, from];
    if (isSymmetric(normalized.type) && from.entity.id > to.entity.id) [from, to] = [to, from];
    const ambiguous = subject.matchedBy === "ambiguous" || object.matchedBy === "ambiguous";
    const sensitive = isSensitive(normalized.type);
    let status = "suggested";
    if (options.forceStatus === "suggested" || options.forceStatus === "confirmed") status = options.forceStatus;
    else if (source === "user" && !ambiguous) status = "confirmed";
    else if (source === "journal") status = "suggested";
    else if (!sensitive && !ambiguous && Number(triple.confidence) >= 0.85) status = "confirmed";
    const saved = await upsertEdge(userId, {
      fromKind: "entity",
      fromId: from.entity.id,
      toKind: "entity",
      toId: to.entity.id,
      type: normalized.type,
      category: categoryOf(normalized.type),
      status,
      source,
      confidence: clamp(triple.confidence),
      validFrom: parseDate(triple.validFrom),
      validTo: parseDate(triple.validTo),
      evidenceEventId: options.evidenceEventId || null,
      evidenceText: clip(triple.evidence, 300),
      attributes: isObject(triple.attributes) ? triple.attributes : {},
    });
    if (!saved) continue;
    if (saved.created) result.created += 1;
    else result.updated += 1;
    if (saved.edge.status === "suggested") result.suggested += 1;
  }
  const factConflicts = await applyEntityFacts(userId, options.entityFacts || [], source);
  result.conflicts.push(...factConflicts);
  console.log(
    `[graph] committed ${result.created + result.updated} edges (${result.created + result.updated - result.suggested} confirmed, ${result.suggested} suggested) source=${source} event=${options.evidenceEventId || "-"}`,
  );
  return result;
}

export async function anchorEventEdges(userId, event) {
  if (!event?.id) return [];
  const self = await getOrCreateSelf(userId);
  const created = [];
  const people = Array.isArray(event.people) ? event.people : [];
  for (const person of people) {
    const name = typeof person === "string" ? person : person?.name;
    if (!name) continue;
    const resolved = person?.entityId
      ? { entity: await prisma.entity.findFirst({ where: { id: person.entityId, userId } }) }
      : await resolveEntity(userId, { name, entityType: "person" });
    if (!resolved.entity) continue;
    created.push(await upsertEdge(userId, edgeToEvent(userId, resolved.entity.id, event.id, "participant_in", "project", { role: person?.role || "mentioned" }, event)));
  }
  const places = Array.isArray(event.places) ? event.places : [];
  for (const place of places) {
    const name = typeof place === "string" ? place : place?.name;
    if (!name && !place?.entityId) continue;
    const resolved = place?.entityId
      ? { entity: await prisma.entity.findFirst({ where: { id: place.entityId, userId } }) }
      : await resolveEntity(userId, { name, entityType: "place" });
    if (!resolved.entity) continue;
    created.push(await upsertEdge(userId, {
      fromKind: "event",
      fromId: event.id,
      toKind: "entity",
      toId: resolved.entity.id,
      type: "happened_at",
      category: "location",
      status: "confirmed",
      source: "intake",
      confidence: 0.95,
      evidenceEventId: event.id,
      attributes: {},
    }));
  }
  const financial = event.financials && typeof event.financials === "object" ? event.financials : {};
  const amount = Number(financial.amount ?? financial.totalAmount);
  if (Number.isFinite(amount) && amount > 0) {
    created.push(await upsertEdge(userId, {
      fromKind: "entity",
      fromId: self.id,
      toKind: "event",
      toId: event.id,
      type: "paid",
      category: "financial",
      status: "confirmed",
      source: "intake",
      confidence: 0.8,
      evidenceEventId: event.id,
      attributes: { amount, currency: financial.currency || "TSH" },
    }));
  }
  return created.filter(Boolean);
}

export function scheduleExtraction(userId, text, options = {}) {
  setImmediate(async () => {
    try {
      const self = await prisma.entity.findFirst({ where: { userId, isSelf: true }, select: { name: true } });
      const known = await prisma.entity.findMany({
        where: { userId, status: { not: "archived" }, mergedIntoId: null },
        select: { name: true, entityType: true },
        take: 40,
        orderBy: { updatedAt: "desc" },
      });
      const extracted = await extractTriples(text, {
        selfName: self?.name,
        today: new Date().toISOString().slice(0, 10),
        title: options.title,
        known,
      });
      await commitTriples(userId, extracted.triples, { ...options, entityFacts: extracted.entityFacts });
    } catch (err) {
      console.error("[graph] schedule failed:", err.message);
    }
  });
}

export async function anchorVision(userId, vision) {
  const links = Array.isArray(vision?.connectedEntities) ? vision.connectedEntities : [];
  for (const link of links) {
    const name = link?.name;
    if (!name && !link?.entityId) continue;
    const place = link?.role === "location" || link?.relationship === "location";
    const resolved = link?.entityId
      ? { entity: await prisma.entity.findFirst({ where: { id: link.entityId, userId } }) }
      : await resolveEntity(userId, { name, entityType: place ? "place" : "other" });
    if (!resolved.entity) continue;
    await upsertEdge(userId, {
      fromKind: "vision",
      fromId: vision.id,
      toKind: "entity",
      toId: resolved.entity.id,
      type: place ? "planned_for" : "related_to",
      category: place ? "project" : "other",
      status: "confirmed",
      source: "intake",
      confidence: 0.8,
      attributes: {},
    });
  }
}

export async function retireEdges(userId, kind, id) {
  const edges = await prisma.relationship.findMany({
    where: {
      userId,
      status: { not: "rejected" },
      OR: [
        { fromKind: kind, fromId: id },
        { toKind: kind, toId: id },
      ],
    },
  });
  for (const edge of edges) {
    const attributes = isObject(edge.attributes) ? { ...edge.attributes, reason: "source_removed" } : { reason: "source_removed" };
    await prisma.relationship.update({
      where: { id: edge.id },
      data: { status: "rejected", attributes },
    });
  }
  return edges.length;
}

async function resolveSide(userId, side, self) {
  if (!side || typeof side !== "object") return { entity: null, matchedBy: "none" };
  if (side.type === "self" || /^(i|me|my|mimi)$/i.test(String(side.name || "").trim())) {
    return { entity: self, matchedBy: "self" };
  }
  return resolveEntity(userId, { name: side.name, entityType: side.type, kind: side.kind });
}

async function upsertEdge(userId, input) {
  if (!input?.fromId || !input?.toId) return null;
  const where = {
    userId_fromKind_fromId_type_toKind_toId: {
      userId,
      fromKind: input.fromKind,
      fromId: input.fromId,
      type: input.type,
      toKind: input.toKind,
      toId: input.toId,
    },
  };
  const existing = await prisma.relationship.findUnique({ where }).catch(() => null);
  if (existing?.status === "rejected" && input.source !== "user") return null;
  if (!existing) {
    const edge = await prisma.relationship.create({
      data: {
        userId,
        fromKind: input.fromKind,
        fromId: input.fromId,
        toKind: input.toKind,
        toId: input.toId,
        type: input.type,
        category: input.category,
        status: input.status,
        source: input.source,
        confidence: input.confidence ?? 0.5,
        strength: input.strength ?? (input.source === "user" && (input.category === "family" || input.category === "ownership") ? 0.7 : 0.5),
        validFrom: input.validFrom || null,
        validTo: input.validTo || null,
        evidenceEventId: input.evidenceEventId || null,
        evidenceText: input.evidenceText || null,
        attributes: input.attributes || {},
        label: input.label || null,
      },
    });
    maybeNotify(userId, edge, false);
    return { edge, created: true };
  }
  const ended = Boolean(input.validTo) && !existing.validTo;
  const attributes = mergeAttributes(existing.attributes, input.attributes, input);
  const edge = await prisma.relationship.update({
    where: { id: existing.id },
    data: {
      status: existing.status === "confirmed" ? "confirmed" : input.status,
      confidence: Math.max(existing.confidence || 0, input.confidence || 0),
      attributes,
      validTo: input.validTo || existing.validTo,
      evidenceText: existing.evidenceText || input.evidenceText || null,
    },
  });
  if (ended) maybeNotify(userId, edge, true);
  return { edge, created: false };
}

function maybeNotify(userId, edge, ended) {
  if (edge.status !== "confirmed") return;
  if (edge.category !== "family" && edge.category !== "ownership") return;
  if (Number(edge.strength) < 0.6 && !ended) return;
  setImmediate(async () => {
    try {
      const { notifyRelationshipShift } = await import("../altimetrixBridge.js");
      await notifyRelationshipShift(userId, edge, { ended });
    } catch (err) {
      console.error("[bridge] relationship shift failed:", err.message);
    }
  });
}

function mergeAttributes(current, incoming, input) {
  const base = isObject(current) ? { ...current } : {};
  const next = isObject(incoming) ? incoming : {};
  const amount = Number(next.amount);
  if (Number.isFinite(amount) && amount > 0 && (input.type === "sent_money_to" || input.type === "paid" || input.type === "funded" || input.type === "contributed_to")) {
    const priorCount = Number(base.count || 0);
    const priorTotal = priorCount > 0 ? Number(base.total || 0) : Number(base.amount || 0);
    base.total = priorTotal + amount;
    base.count = (priorCount || (base.amount ? 1 : 0)) + 1;
    base.currency = next.currency || base.currency || null;
    const history = Array.isArray(base.history) ? base.history.slice(-49) : [];
    history.push({ eventId: input.evidenceEventId || null, amount, date: new Date().toISOString().slice(0, 10) });
    base.history = history;
  }
  return { ...base, ...next, total: base.total, count: base.count, history: base.history, currency: base.currency || next.currency };
}

function edgeToEvent(userId, entityId, eventId, type, category, attributes, event) {
  void userId;
  void event;
  return {
    fromKind: "entity",
    fromId: entityId,
    toKind: "event",
    toId: eventId,
    type,
    category,
    status: "confirmed",
    source: "intake",
    confidence: 0.9,
    evidenceEventId: eventId,
    attributes,
  };
}

async function applyEntityFacts(userId, facts, source) {
  const conflicts = [];
  for (const fact of facts) {
    if (!fact?.name) continue;
    const resolved = await resolveEntity(userId, { name: fact.name, entityType: "person", kind: fact.kind });
    if (!resolved.entity || resolved.matchedBy === "ambiguous") continue;
    const entity = resolved.entity;
    const data = {};
    const birth = parseDate(fact.birthDate);
    const death = parseDate(fact.deathDate);
    if (birth && !entity.birthDate) data.birthDate = birth;
    else if (birth && entity.birthDate && entity.birthDate.toISOString().slice(0, 10) !== birth.toISOString().slice(0, 10)) {
      conflicts.push(await conflictSuggestion(userId, entity, "birthDate", entity.birthDate, birth, source));
    }
    if (death && !entity.deathDate) data.deathDate = death;
    else if (death && entity.deathDate && entity.deathDate.toISOString().slice(0, 10) !== death.toISOString().slice(0, 10)) {
      conflicts.push(await conflictSuggestion(userId, entity, "deathDate", entity.deathDate, death, source));
    }
    if (fact.kind && !entity.kind) data.kind = String(fact.kind).slice(0, 40);
    if (Object.keys(data).length) await prisma.entity.update({ where: { id: entity.id }, data });
  }
  return conflicts.filter(Boolean);
}

async function conflictSuggestion(userId, entity, field, current, incoming, source) {
  return prisma.relationship.create({
    data: {
      userId,
      fromKind: "entity",
      fromId: entity.id,
      toKind: "entity",
      toId: entity.id,
      type: "related_to",
      category: "other",
      status: "suggested",
      source,
      confidence: 0.4,
      label: "conflict",
      attributes: {
        conflictWith: field,
        current: current.toISOString().slice(0, 10),
        incoming: incoming.toISOString().slice(0, 10),
        name: entity.name,
      },
      evidenceText: `Records disagree: ${entity.name} ${field} ${current.toISOString().slice(0, 10)} vs ${incoming.toISOString().slice(0, 10)}`,
    },
  }).catch(() => null);
}

async function completeJson(system, user) {
  const key = usableKey(process.env.GROQ_API_KEY);
  if (!key) return "{\"triples\":[]}";
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Groq graph status ${response.status}`);
  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function parseJson(raw) {
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  try {
    return JSON.parse(fenced ? fenced[1] : text);
  } catch {
    return null;
  }
}

function parseDate(value) {
  if (!value || value === "null") return null;
  const text = String(value).trim();
  if (/^\d{4}$/.test(text)) return new Date(Date.UTC(Number(text), 0, 1));
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function clip(value, max) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : null;
}

function clamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function usableKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  if (!key || key.startsWith("your_")) return null;
  return key;
}
