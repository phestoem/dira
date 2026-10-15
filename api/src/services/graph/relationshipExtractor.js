import { prisma } from "../../prisma.js";
import { getOrCreateSelf, normalizeName, resolveEntity } from "./entityResolver.js";
import { buildSelfAliasSet, dropReason, fullNameFromProfile, prepareTriples as refineTriples, relativesFromEdges } from "./graphQuality.js";
import { categoryOf, isSensitive, isSymmetric, listRelationshipTypes, normalizeType } from "./relationshipTypes.js";

const ROLE_ALIAS = new Set(["i", "me", "my", "mimi", "yangu", "the individual", "the user", "the owner", "the occupier", "the buyer"]);
const GROQ_MODEL = "qwen/qwen3.8-27b";
const OPENAI_MODEL = "gpt-4o-mini";
const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000];
const MAX_EXTRACT_ATTEMPTS = 5;

function extractPrompt() {
  const predicates = listRelationshipTypes().map((item) => item.type).join(", ");
  return `Extract relationship triples that are actually stated in the text.
Return JSON only:
{ "triples": [{ "subject": { "name": "", "type": "person|place|property|project|organisation|asset|vehicle|self" }, "predicate": "", "object": { "name": "", "type": "" }, "validFrom": null, "validTo": null, "attributes": {}, "confidence": 0.5, "evidence": "" }], "entityFacts": [{ "name": "", "birthDate": null, "deathDate": null, "kind": null }] }
Rules:
- Subjects and objects must be real-world things: a person, place, property, project, organisation, vehicle, or named asset (for example "Plot P9104").
- Money amounts, dates, durations, percentages, quantities and statuses go in "attributes", never in subject or object.
- Predicates must be one of: ${predicates}.
  Synonyms are accepted: mama, mum, mother, dada, mke, mume, mtoto, fundi, msimamizi, ananunua, alinunua, supervises, owns, occupies, married, alioa, studies at, sold to, sent money to.
  If no listed predicate fits, omit the triple.
- Prefer relationships between people, places and assets over describing a single event's properties.
- The narrator is the SELF named in the user message. "I", "me", "my", "mimi", "yangu", and every spelling of that person's name are type self. Never map the narrator to any other person.
- Possessive kinship ("my wife", "my husband", "my father", "my mother", "my children", "mke wangu", "baba yangu") always connects that person to the narrator, one clause at a time. Never attach "my wife" to another person mentioned nearby. Keep every word of a name ("Zelda Goodluck Mambosho", "Prisha Neema").
- Only output a family relationship when the text states it explicitly. A shared surname or middle name is not evidence of any relationship.
- Words such as wife, husband, parents, mother, father, children, sisters and family are not names. Use the person's name, or omit the triple.
- Do not output generic activities (landscaping, purchase, renovation), money words (cash, payment, cost, fee), or identifier numbers (TIN, application, chassis) as subject or object. A named project such as "Kisarawe House Renovation" is allowed.
- "issued" is administrative. Omit it.
- A death or birth is an entityFact (deathDate or birthDate), never a triple.
- Do not invent family links that were not said.
- A death does not end a family edge. Put the date on entityFacts.deathDate.
- Selling, moving out, or a role ending sets validTo.
- Money transfers set attributes.amount and attributes.currency.
- At most 15 triples.
- Work in English or Swahili.

Bad: { "subject": { "name": "Electrical Works", "type": "project" }, "predicate": "hasTotalContractValue", "object": { "name": "2,399,500 TSH", "type": "asset" } }
Bad: { "subject": { "name": "Plot P9104", "type": "property" }, "predicate": "dated", "object": { "name": "12 May 2024", "type": "other" } }
Good: { "subject": { "name": "Burton", "type": "person" }, "predicate": "supervises", "object": { "name": "Mbeya Home", "type": "property" } }
Good: { "subject": { "name": "me", "type": "self" }, "predicate": "owns", "object": { "name": "Plot P9104", "type": "property" } }
Good: { "subject": { "name": "me", "type": "self" }, "predicate": "sent_money_to", "object": { "name": "Makoba", "type": "person" }, "attributes": { "amount": 50000, "currency": "TSH" } }`;
}

export async function extractTriples(text, context = {}) {
  const body = String(text || "").trim();
  if (body.length < 8) return { triples: [], entityFacts: [] };
  const known = Array.isArray(context.known) ? context.known.slice(0, 40) : [];
  const selfName = context.selfName || "me";
  const others = known.filter((item) => !item.isSelf && normalizeName(item.name) !== normalizeName(selfName));
  const user = [
    `SELF (the narrator, 'I/me'): ${selfName}`,
    "Never map the narrator to any other person in the list.",
    context.today ? `Today: ${context.today}` : "",
    context.title ? `Title: ${context.title}` : "",
    others.length ? `Known: ${others.map((item) => `${item.name} (${item.entityType})`).join("; ")}` : "",
    body.slice(0, 3500),
  ].filter(Boolean).join("\n");
  try {
    const raw = await completeJson(extractPrompt(), user);
    const parsed = parseJson(raw);
    const triples = Array.isArray(parsed?.triples) ? parsed.triples.slice(0, 15) : [];
    const entityFacts = Array.isArray(parsed?.entityFacts) ? parsed.entityFacts.slice(0, 15) : [];
    return { triples, entityFacts };
  } catch (err) {
    if (err.status !== 429) console.error("[graph] extract failed:", err.message);
    throw err;
  }
}

export function graphExtractProvider() {
  return String(process.env.GRAPH_EXTRACT_PROVIDER || "openai").trim().toLowerCase() === "groq" ? "groq" : "openai";
}

export function retryDelayMs(error, attempt) {
  const headerWait = headerDelayMs(error);
  if (headerWait != null) return Math.min(headerWait, 60000);
  const index = Math.min(Math.max(Number(attempt) || 1, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index];
}

export async function extractWithRetry(run, sleepFn = sleep) {
  let last;
  for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      last = err;
      if (err?.status !== 429 || attempt === MAX_EXTRACT_ATTEMPTS) throw err;
      const wait = retryDelayMs(err, attempt);
      console.warn(`[graph] rate limited, waiting ${Math.round(wait / 1000)}s (attempt ${attempt}/${MAX_EXTRACT_ATTEMPTS})`);
      await sleepFn(wait);
    }
  }
  throw last;
}

export { dropReason };

export function prepareTriples(triples, context = {}) {
  const prepared = refineTriples(triples, context);
  for (const triple of prepared.dropped) {
    if (triple.silent) continue;
    console.debug(`[graph] dropped triple (${triple.reason}): ${sideName(triple.subject)} —${triple.predicate}→ ${sideName(triple.object)}`);
  }
  return prepared;
}

export function moneyValue(triple) {
  const attributes = isObject(triple?.attributes) ? triple.attributes : {};
  const stated = Number(attributes.amount);
  if (Number.isFinite(stated) && stated > 0) {
    return { amount: stated, currency: attributes.currency || currencyIn(sideName(triple.object)) || currencyIn(sideName(triple.subject)) || "TSH" };
  }
  return moneyFromName(sideName(triple?.object)) || moneyFromName(sideName(triple?.subject));
}

export function eventLikeProject(triple, eventTitle) {
  const type = String(triple?.subject?.type || "").toLowerCase();
  const name = sideName(triple?.subject);
  if (type === "project" || type === "event") return true;
  return Boolean(eventTitle && name && normalizeName(name) === normalizeName(eventTitle));
}

export function selfIsPayer(triple) {
  const attributes = isObject(triple?.attributes) ? triple.attributes : {};
  const payer = attributes.payer || attributes.paidBy;
  if (!payer) return true;
  return /^(self|i|me|my|mimi)$/i.test(String(payer).trim());
}

export function deterministicEdgePlans(event, selfName) {
  if (!event?.id) return [];
  const plans = [];
  for (const person of Array.isArray(event.people) ? event.people : []) {
    const name = typeof person === "string" ? person : person?.name;
    if (!name) continue;
    plans.push({
      kind: "deterministic",
      type: "participant_in",
      eventId: event.id,
      fromName: name,
      toName: event.title,
      toKind: "event",
      toId: event.id,
      attributes: { role: person?.role || "mentioned" },
    });
  }
  for (const place of Array.isArray(event.places) ? event.places : []) {
    const name = typeof place === "string" ? place : place?.name;
    if (!name) continue;
    plans.push({
      kind: "deterministic",
      type: "happened_at",
      eventId: event.id,
      fromName: event.title,
      fromKind: "event",
      fromId: event.id,
      toName: name,
      attributes: {},
    });
  }
  const financial = event.financials && typeof event.financials === "object" ? event.financials : {};
  const amount = Number(financial.amount ?? financial.totalAmount);
  if (Number.isFinite(amount) && amount > 0) {
    plans.push({
      kind: "deterministic",
      type: "paid",
      eventId: event.id,
      fromName: selfName || "self",
      toName: event.title,
      toKind: "event",
      toId: event.id,
      attributes: { amount, currency: financial.currency || "TSH" },
    });
  }
  return plans;
}

export function absorbDroppedPayment(plans, triple, event, selfName) {
  if (!eventLikeProject(triple, event?.title) || !selfIsPayer(triple)) return false;
  const money = moneyValue(triple);
  if (!money) return false;
  const paid = plans.find((plan) => plan.kind === "deterministic" && plan.type === "paid" && plan.eventId === event.id);
  if (paid) {
    if (!paid.attributes?.amount) paid.attributes = { ...paid.attributes, ...money };
    return true;
  }
  plans.push({
    kind: "deterministic",
    type: "paid",
    eventId: event.id,
    fromName: selfName || "self",
    toName: event.title,
    toKind: "event",
    toId: event.id,
    attributes: money,
  });
  return true;
}

export async function commitTriples(userId, triples, options = {}) {
  const source = options.source || "intake";
  const result = { created: 0, updated: 0, suggested: 0, conflicts: [], dropped: [], reviewQuestions: [], createdEntities: [] };
  const self = await getOrCreateSelf(userId);
  const quality = options.quality || await loadQualityContext(userId, self);
  const prepared = prepareTriples(triples, {
    ...quality,
    message: options.message || "",
    sourceText: options.sourceText || options.message || "",
  });
  result.reviewQuestions = prepared.reviewQuestions;
  await rememberSelfSpellings(self, prepared.selfSpellings);
  result.dropped = prepared.dropped;
  for (const triple of prepared.dropped) {
    if (triple.reason === "amount-as-node" && options.evidenceEventId) {
      await attachPaymentIfNeeded(userId, triple, options, self);
    }
  }
  for (const triple of prepared.kept) {
    const subject = await resolveSide(userId, triple.subject, self);
    const object = await resolveSide(userId, triple.object, self);
    if (!subject.entity || !object.entity) continue;
    if (subject.matchedBy === "created") result.createdEntities.push({ id: subject.entity.id, name: subject.entity.name });
    if (object.matchedBy === "created") result.createdEntities.push({ id: object.entity.id, name: object.entity.name });
    if (subject.entity.id === object.entity.id) {
      console.debug(`[graph] dropped triple (same-node): ${sideName(triple.subject)} —${triple.predicate}→ ${sideName(triple.object)}`);
      result.dropped.push({ ...triple, reason: "same-node" });
      continue;
    }
    const normalized = normalizeType(triple.predicate);
    if (!normalized) continue;
    const reverse = triple._reverse != null ? Boolean(triple._reverse) : normalized.reverse;
    let from = subject;
    let to = object;
    if (reverse) [from, to] = [to, from];
    if (isSymmetric(normalized.type) && from.entity.id > to.entity.id) [from, to] = [to, from];
    const ambiguous = subject.matchedBy === "ambiguous" || object.matchedBy === "ambiguous";
    const sensitive = isSensitive(normalized.type);
    let status = "suggested";
    if (options.forceStatus === "suggested" || options.forceStatus === "confirmed") status = options.forceStatus;
    else if (source === "user" && !ambiguous) status = "confirmed";
    else if (source === "journal") status = "suggested";
    else if (normalized.category === "family" && source !== "user" && source !== "conversation") status = "suggested";
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
      occurredAt: options.occurredAt || null,
      correction: Boolean(options.correction),
    });
    if (!saved) continue;
    if (saved.created) result.created += 1;
    else result.updated += 1;
    if (saved.edge.status === "suggested") result.suggested += 1;
  }
  const factConflicts = await applyEntityFacts(userId, [...(options.entityFacts || []), ...prepared.entityFacts], source);
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
      const extracted = await extractWithRetry(() => extractTriples(text, {
        selfName: self?.name,
        today: new Date().toISOString().slice(0, 10),
        title: options.title,
        known,
      }));
      await commitTriples(userId, extracted.triples, { ...options, entityFacts: extracted.entityFacts });
      await markScheduled(userId, options);
    } catch (err) {
      console.error("[graph] schedule failed:", err.message);
    }
  });
}

export async function markGraphExtracted(userId, kind, id) {
  if (!userId || !id) return;
  const data = { graphExtractedAt: new Date() };
  if (kind === "event") await prisma.event.updateMany({ where: { id, userId }, data });
  else if (kind === "vision") await prisma.vision.updateMany({ where: { id, userId }, data });
  else if (kind === "diary") await prisma.diaryEntry.updateMany({ where: { id, userId }, data });
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
  if (side.type === "self" || /^(i|me|my|mimi|self)$/i.test(String(side.name || "").trim())) {
    return { entity: self, matchedBy: "self" };
  }
  if (side.entityId) {
    const entity = await prisma.entity.findFirst({ where: { id: side.entityId, userId, status: { not: "archived" } } });
    if (entity) return { entity, matchedBy: "id" };
  }
  return resolveEntity(userId, { name: side.name, entityType: side.type, kind: side.kind });
}

export async function loadQualityContext(userId, self) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, handle: true } });
  const profile = await prisma.event.findFirst({
    where: {
      userId,
      status: { not: "archived" },
      OR: [
        { title: { contains: "cv", mode: "insensitive" } },
        { title: { contains: "curriculum", mode: "insensitive" } },
        { title: { contains: "profile", mode: "insensitive" } },
        { title: { contains: "resume", mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  const aliases = buildSelfAliasSet({
    names: [user?.name, user?.handle, self?.name, fullNameFromProfile(profile)].filter(Boolean),
    aliases: self?.aliases || [],
  });
  const edges = self?.id ? await prisma.relationship.findMany({
    where: { userId, status: "confirmed", category: "family", OR: [{ fromId: self.id }, { toId: self.id }] },
  }) : [];
  const ids = [...new Set(edges.flatMap((edge) => [edge.fromId, edge.toId]))];
  const people = ids.length ? await prisma.entity.findMany({ where: { userId, id: { in: ids } }, select: { id: true, name: true } }) : [];
  return {
    selfAliases: aliases,
    selfName: self?.name || user?.name || "Me",
    relatives: relativesFromEdges(edges, self?.id, new Map(people.map((person) => [person.id, person.name]))),
  };
}

async function rememberSelfSpellings(self, spellings) {
  if (!self?.id || !spellings?.length) return;
  const existing = new Set((self.aliases || []).map((item) => normalizeName(item)));
  const extra = spellings.filter((name) => name && !existing.has(normalizeName(name)) && !ROLE_ALIAS.has(normalizeName(name)));
  if (!extra.length) return;
  const aliases = [...(self.aliases || []), ...extra].slice(0, 40);
  await prisma.entity.update({ where: { id: self.id }, data: { aliases } });
  self.aliases = aliases;
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
    await closeSuperseded(userId, { ...input, edgeId: edge.id });
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
  await closeSuperseded(userId, { ...input, edgeId: edge.id });
  return { edge, created: false };
}

async function closeSuperseded(userId, input) {
  if (!["located_in", "lives_at", "owns"].includes(input.type) || input.validTo) return;
  const where = {
    userId,
    type: input.type,
    status: { not: "rejected" },
    validTo: null,
    id: { not: input.edgeId },
  };
  if (input.type === "owns") {
    where.toId = input.toId;
    where.fromId = { not: input.fromId };
  } else {
    where.fromId = input.fromId;
    where.toId = { not: input.toId };
  }
  const previous = await prisma.relationship.findMany({ where });
  const at = input.validFrom || input.occurredAt || new Date();
  for (const edge of previous) {
    if (!input.correction && edge.validFrom && new Date(edge.validFrom) > new Date(at)) continue;
    await prisma.relationship.update({ where: { id: edge.id }, data: { validTo: new Date(at) } });
  }
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
    if (fact.birthOrder && !(isObject(entity.attributes) && entity.attributes.birthOrder)) {
      const attributes = isObject(entity.attributes) ? { ...entity.attributes } : {};
      attributes.birthOrder = fact.birthOrder;
      data.attributes = attributes;
    }
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

async function attachPaymentIfNeeded(userId, triple, options, self) {
  if (!eventLikeProject(triple, options.title || options.eventTitle) || !selfIsPayer(triple) || !self?.id) return;
  const money = moneyValue(triple);
  if (!money) return;
  const existing = await prisma.relationship.findFirst({
    where: {
      userId,
      fromKind: "entity",
      fromId: self.id,
      toKind: "event",
      toId: options.evidenceEventId,
      type: "paid",
    },
  });
  if (!existing) {
    await upsertEdge(userId, {
      fromKind: "entity",
      fromId: self.id,
      toKind: "event",
      toId: options.evidenceEventId,
      type: "paid",
      category: "financial",
      status: "confirmed",
      source: options.source || "intake",
      confidence: 0.8,
      evidenceEventId: options.evidenceEventId,
      attributes: money,
    });
    return;
  }
  const attributes = isObject(existing.attributes) ? existing.attributes : {};
  if (attributes.amount || attributes.total) return;
  await prisma.relationship.update({
    where: { id: existing.id },
    data: { attributes: { ...attributes, ...money } },
  });
}

function sideName(side) {
  if (!side) return "";
  if (typeof side === "string") return side.trim();
  return String(side.name || "").trim();
}

function isMoneyName(name) {
  const text = String(name || "").trim();
  if (!text) return false;
  if (/^[\d.,\s]+(TSH|TZS|EUR|USD|KES)?$/i.test(text) && /\d/.test(text)) return true;
  if (/^(TSH|TZS|EUR|USD|KES)\s*[\d.,\s]+$/i.test(text)) return true;
  return /^\d/.test(text) && /\b(TSH|TZS|EUR|USD|KES)\b/i.test(text);
}

function isDateName(name) {
  const text = String(name || "").trim();
  if (/^\d{4}$/.test(text)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return true;
  if (/^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(text)) return true;
  return /^(?:\d{1,2}\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{1,2})?(?:,?\s+\d{4})?$/i.test(text);
}

function isQuantityName(name) {
  return /^\d[\d.,]*\s*(%|percent|kg|g|m|sqm|m2|bags|units|pcs|hrs|hours|days)?$/i.test(String(name || "").trim());
}

function isStatusName(name) {
  return /^(completed|complete|pending|active|cancelled|canceled|paid|unpaid|done|approved|rejected|ongoing|dormant)$/i.test(String(name || "").trim());
}

function moneyFromName(name) {
  const text = String(name || "").trim();
  const match = text.match(/([\d][\d.,\s]*)\s*(TSH|TZS|EUR|USD|KES)?/i) || text.match(/(TSH|TZS|EUR|USD|KES)\s*([\d][\d.,\s]*)/i);
  if (!match) return null;
  const amountText = /\d/.test(match[1]) ? match[1] : match[2];
  const currency = /\d/.test(match[1]) ? match[2] : match[1];
  const amount = parseAmount(amountText);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: (currency || "TSH").toUpperCase() };
}

function currencyIn(name) {
  const match = String(name || "").match(/\b(TSH|TZS|EUR|USD|KES)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function parseAmount(text) {
  let num = String(text || "").replace(/\s/g, "");
  if (num.includes(",") && num.includes(".")) {
    if (num.lastIndexOf(",") > num.lastIndexOf(".")) num = num.replace(/\./g, "").replace(",", ".");
    else num = num.replace(/,/g, "");
  } else if ((num.match(/,/g) || []).length > 1 || (num.match(/\./g) || []).length > 1) {
    num = num.replace(/[.,]/g, "");
  } else {
    num = num.replace(/,/g, "");
  }
  const amount = Number(num);
  return Number.isFinite(amount) ? amount : null;
}

async function completeJson(system, user) {
  if (graphExtractProvider() === "groq") return completeWithGroq(system, user);
  try {
    return await completeWithOpenAI(system, user);
  } catch (err) {
    if (err.status === 429) throw err;
    console.error("[graph] openai extract failed, trying groq:", err.message);
    return completeWithGroq(system, user);
  }
}

async function completeWithOpenAI(system, user) {
  const key = usableKey(process.env.OPENAI_API_KEY);
  if (!key) throw new Error("OpenAI key is not configured");
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 429) throw rateLimitError("OpenAI", response);
  if (!response.ok) throw new Error(`OpenAI graph status ${response.status}`);
  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || "");
}

async function completeWithGroq(system, user) {
  const key = usableKey(process.env.GROQ_API_KEY);
  if (!key) throw new Error("Groq key is not configured");
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
  if (response.status === 429) throw rateLimitError("Groq", response);
  if (!response.ok) throw new Error(`Groq graph status ${response.status}`);
  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
}

function rateLimitError(provider, response) {
  const error = new Error(`${provider} graph status 429`);
  error.status = 429;
  error.retryAfter = headerDelayFrom(response.headers);
  return error;
}

function headerDelayMs(error) {
  if (Number.isFinite(error?.retryAfter) && error.retryAfter > 0) return error.retryAfter;
  return null;
}

export function headerDelayFrom(headers) {
  if (!headers?.get) return null;
  const retryAfter = parseWait(headers.get("retry-after"));
  if (retryAfter != null) return retryAfter;
  for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const parsed = parseWait(headers.get(name));
    if (parsed != null) return parsed;
  }
  return null;
}

function parseWait(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    if (numeric > 1e12) return Math.max(0, numeric - Date.now());
    if (numeric > 1e9) return Math.max(0, numeric * 1000 - Date.now());
    return Math.max(0, Math.ceil(numeric * 1000));
  }
  const date = Date.parse(text);
  if (Number.isFinite(date) && /[a-z]/i.test(text) && text.includes(",")) return Math.max(0, date - Date.now());
  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (!match || (match[1] == null && match[2] == null && match[3] == null)) return null;
  const ms = (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000;
  return ms > 0 ? Math.ceil(ms) : null;
}

async function markScheduled(userId, options) {
  if (options.evidenceEventId) await markGraphExtracted(userId, "event", options.evidenceEventId);
  if (options.diaryEntryId) await markGraphExtracted(userId, "diary", options.diaryEntryId);
  if (options.visionId) await markGraphExtracted(userId, "vision", options.visionId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
