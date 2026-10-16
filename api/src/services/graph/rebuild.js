import { prisma } from "../../prisma.js";
import { graphAutoExtractEnabled, setGraphAutoExtract } from "./autoExtract.js";
import { findDuplicateCandidates, getOrCreateSelf, normalizeName, resolveEntity } from "./entityResolver.js";
import { applySupersession, dedupeProposedNames, isCorrectionEvent } from "./graphQuality.js";
import {
  absorbDroppedPayment,
  anchorEventEdges,
  anchorVision,
  commitTriples,
  deterministicEdgePlans,
  extractTriples,
  extractWithRetry,
  loadQualityContext,
  markGraphExtracted,
  prepareTriples,
} from "./relationshipExtractor.js";
import { categoryOf, isSensitive, normalizeType } from "./relationshipTypes.js";

export { graphAutoExtractEnabled, setGraphAutoExtract };

export async function catchUpGraphExtractions() {
  const users = await prisma.user.findMany({ select: { id: true, settings: true } });
  for (const user of users) {
    if (!graphAutoExtractEnabled(user.settings)) continue;
    const pending = await countMissing(user.id);
    if (!pending) continue;
    try {
      await rebuildGraph(user.id, { dryRun: false, onlyMissing: true, limit: 10 });
    } catch (err) {
      console.error(`[graph-rebuild] catch-up failed for ${user.id}:`, err.message);
    }
  }
}

export async function rebuildGraph(userId, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const onlyMissing = options.force === true ? false : options.onlyMissing !== false;
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : null;
  let budget = limit;
  const report = {
    dryRun,
    entitiesCreated: 0,
    duplicateCandidates: [],
    edges: dryRun ? { wouldCreate: 0, wouldUpdate: 0, wouldSuggest: 0 } : {},
    conflicts: [],
    proposed: [],
    dropped: [],
    skipped: [],
    reviewQuestions: [],
    counts: {
      eventsProcessed: 0,
      eventsSkipped: 0,
      triplesProposed: 0,
      triplesDropped: 0,
      newEntities: 0,
      droppedByReason: {},
    },
  };
  const newNames = new Set();
  let consecutiveSkips = 0;
  if (!dryRun) await getOrCreateSelf(userId);
  const events = await loadRecords("event", userId, onlyMissing, budget);
  if (budget != null) budget -= events.length;
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true }, select: { id: true, name: true, aliases: true } });
  const quality = await loadQualityContext(userId, self);
  const seenNames = [];
  const createdIds = new Map();
  let ledger = [];
  const known = await prisma.entity.findMany({
    where: { userId, status: { not: "archived" }, mergedIntoId: null },
    select: { name: true, entityType: true },
    take: 40,
  });

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    try {
      const plans = deterministicEdgePlans(event, quality.selfName || self?.name);
      const sourceText = eventText(event);
      const extracted = await extractWithRetry(() => extractTriples(sourceText, {
        selfName: quality.selfName,
        today: new Date().toISOString().slice(0, 10),
        title: event.title,
        known,
      }));
      const prepared = prepareTriples(extracted.triples, { ...quality, message: sourceText, sourceText });
      noteQuestions(report, prepared.reviewQuestions);
      canonize(prepared.kept, seenNames);
      for (const triple of prepared.dropped) absorbDroppedPayment(plans, triple, event, quality.selfName || self?.name);
      if (dryRun) {
        noteDropped(report, prepared.dropped);
        for (const plan of plans) {
          const proposal = presentPlan(plan);
          report.proposed.push(proposal);
          ledger = trackSupersession(ledger, proposal, event);
        }
        for (const triple of prepared.kept) {
          const proposal = await describeTriple(userId, triple, self, newNames, { source: "backfill", evidenceEventId: event.id });
          if (proposal.reason) {
            noteDropped(report, [{ ...triple, reason: proposal.reason }]);
            continue;
          }
          const row = { eventId: event.id, ...proposal };
          report.proposed.push(row);
          ledger = trackSupersession(ledger, row, event);
          report.counts.triplesProposed += 1;
          await tally(report, userId, row, true);
        }
        for (const plan of plans) await tally(report, userId, plan, true);
      } else {
        noteDropped(report, prepared.dropped);
        noteQuestions(report, prepared.reviewQuestions);
        await renameCreated(userId, seenNames, createdIds);
        await anchorEventEdges(userId, event);
        const committed = await commitTriples(userId, prepared.kept, {
          source: "backfill",
          evidenceEventId: event.id,
          title: event.title,
          entityFacts: [...(extracted.entityFacts || []), ...prepared.entityFacts],
          quality,
          message: sourceText,
          sourceText,
          occurredAt: event.occurredAt || null,
          correction: isCorrectionEvent(event),
        });
        for (const item of committed.createdEntities || []) createdIds.set(item.name, item.id);
        noteQuestions(report, committed.reviewQuestions);
        addCounts(report, committed);
        await markGraphExtracted(userId, "event", event.id);
      }
      report.counts.eventsProcessed += 1;
      consecutiveSkips = 0;
    } catch (err) {
      noteSkip(report, { eventId: event.id, title: event.title, reason: skipReason(err) });
      consecutiveSkips += 1;
      console.error(`[graph-rebuild] skip ${event.id}:`, err.message);
    }
    if ((index + 1) % 5 === 0 || index + 1 === events.length) {
      console.log(`[graph-rebuild] ${index + 1}/${events.length} events, ${report.counts.eventsSkipped} skipped`);
    }
    const moreEvents = index < events.length - 1;
    const paused = await pauseIfStuck(consecutiveSkips, moreEvents);
    consecutiveSkips = paused.count;
    if (moreEvents && !paused.paused) await sleep(1500);
  }

  const visions = budget === 0 ? [] : await loadRecords("vision", userId, onlyMissing, budget);
  if (budget != null) budget -= visions.length;
  const journal = budget === 0 ? [] : await loadRecords("diary", userId, onlyMissing, budget);
  if (consecutiveSkips >= 3 && (visions.length || journal.length)) {
    const paused = await pauseIfStuck(consecutiveSkips, true);
    consecutiveSkips = paused.count;
  }
  for (let index = 0; index < visions.length; index += 1) {
    const vision = visions[index];
    try {
      if (dryRun) {
        report.proposed.push(...visionPlans(vision));
      } else {
        await anchorVision(userId, vision);
        await markGraphExtracted(userId, "vision", vision.id);
      }
      report.counts.eventsProcessed += 1;
      consecutiveSkips = 0;
    } catch (err) {
      noteSkip(report, { visionId: vision.id, title: vision.title, reason: skipReason(err) });
      consecutiveSkips += 1;
      console.error(`[graph-rebuild] skip vision ${vision.id}:`, err.message);
    }
    const more = index < visions.length - 1 || journal.length > 0;
    const paused = await pauseIfStuck(consecutiveSkips, more);
    consecutiveSkips = paused.count;
  }

  for (let index = 0; index < journal.length; index += 1) {
    const entry = journal[index];
    try {
      const sourceText = String(entry.rawContent || "").slice(0, 3000);
      const extracted = await extractWithRetry(() => extractTriples(sourceText, {
        selfName: quality.selfName,
        today: new Date().toISOString().slice(0, 10),
        known,
      }));
      const prepared = prepareTriples(extracted.triples, { ...quality, message: sourceText, sourceText });
      noteQuestions(report, prepared.reviewQuestions);
      canonize(prepared.kept, seenNames);
      noteDropped(report, prepared.dropped);
      if (dryRun) {
        for (const triple of prepared.kept) {
          const proposal = await describeTriple(userId, triple, self, newNames, { source: "journal" });
          if (proposal.reason) {
            noteDropped(report, [{ ...triple, reason: proposal.reason }]);
            continue;
          }
          report.proposed.push({ journalId: entry.id, ...proposal });
          report.counts.triplesProposed += 1;
          await tally(report, userId, proposal, true);
        }
      } else {
        const committed = await commitTriples(userId, prepared.kept, {
          source: "journal",
          forceStatus: "suggested",
          entityFacts: [...(extracted.entityFacts || []), ...prepared.entityFacts],
          quality,
          message: sourceText,
          sourceText,
        });
        addCounts(report, committed);
        await markGraphExtracted(userId, "diary", entry.id);
      }
      report.counts.eventsProcessed += 1;
      consecutiveSkips = 0;
    } catch (err) {
      noteSkip(report, { diaryEntryId: entry.id, title: entryTitle(entry), reason: skipReason(err) });
      consecutiveSkips += 1;
      console.error(`[graph-rebuild] skip journal ${entry.id}:`, err.message);
    }
    const moreEntries = index < journal.length - 1;
    const paused = await pauseIfStuck(consecutiveSkips, moreEntries);
    consecutiveSkips = paused.count;
    if (moreEntries && !paused.paused) await sleep(1500);
  }

  if (!dryRun) await applyLifeDates(userId, events);
  console.log(`[graph-rebuild] done: ${report.counts.eventsProcessed} extracted, ${report.counts.eventsSkipped} skipped`);
  if (!dryRun) await setGraphAutoExtract(userId, true);
  report.duplicateCandidates = dryRun ? [] : await findDuplicateCandidates(userId);
  report.counts.newEntities = newNames.size;
  return report;
}

async function describeTriple(userId, triple, self, newNames, meta) {
  const normalized = normalizeType(triple.predicate);
  if (!normalized) return { reason: "unknown-predicate" };
  const reverse = triple._reverse != null ? Boolean(triple._reverse) : normalized.reverse;
  const statedSubject = reverse ? triple.object : triple.subject;
  const statedObject = reverse ? triple.subject : triple.object;
  const subject = await resolveSide(userId, statedSubject, self, true);
  const object = await resolveSide(userId, statedObject, self, true);
  if (subject.entity && object.entity && subject.entity.id === object.entity.id) return { reason: "same-node" };
  rememberNew(newNames, subject, statedSubject);
  rememberNew(newNames, object, statedObject);
  const ambiguous = subject.matchedBy === "ambiguous" || object.matchedBy === "ambiguous";
  const status = proposedStatus(triple, meta.source, normalized.type, ambiguous);
  return {
    kind: "extracted",
    ...triple,
    subject: statedSubject,
    object: statedObject,
    fromName: statedSubject?.name || null,
    toName: statedObject?.name || null,
    type: normalized.type,
    status,
    resolvedSubject: { existingEntityId: subject.entity?.id || "new" },
    resolvedObject: { existingEntityId: object.entity?.id || "new" },
    evidenceEventId: meta.evidenceEventId || null,
  };
}

async function resolveSide(userId, side, self, readOnly) {
  if (!side || typeof side !== "object") return { entity: null, matchedBy: "none" };
  if (side.type === "self" || /^(i|me|my|mimi|self)$/i.test(String(side.name || "").trim())) {
    return { entity: self, matchedBy: self ? "self" : "none" };
  }
  return resolveEntity(userId, { name: side.name, entityType: side.type, kind: side.kind }, { readOnly });
}

async function tally(report, userId, proposal, dryRun) {
  if (!dryRun || proposal.reason) return;
  const status = proposal.status || (proposal.kind === "deterministic" ? "confirmed" : "suggested");
  if (status === "suggested") {
    report.edges.wouldSuggest += 1;
    return;
  }
  const fromId = proposal.resolvedSubject?.existingEntityId;
  const toId = proposal.resolvedObject?.existingEntityId || proposal.toId;
  const type = proposal.type;
  if (!fromId || fromId === "new" || !toId || toId === "new" || !type) {
    report.edges.wouldCreate += 1;
    return;
  }
  const existing = await prisma.relationship.findFirst({
    where: {
      userId,
      type,
      OR: [
        { fromId, toId },
        { fromId: toId, toId: fromId },
      ],
    },
  });
  if (existing) report.edges.wouldUpdate += 1;
  else report.edges.wouldCreate += 1;
}

function proposedStatus(triple, source, type, ambiguous) {
  if (source === "journal" || source === "conversation") return "suggested";
  if (categoryOf(type) === "family" && source !== "user" && source !== "conversation") return "suggested";
  if (source === "user" && !ambiguous) return "confirmed";
  if (!isSensitive(type) && !ambiguous && Number(triple.confidence) >= 0.85) return "confirmed";
  return "suggested";
}

function rememberNew(names, resolved, side) {
  if (resolved.entity || resolved.matchedBy === "ambiguous" || resolved.matchedBy === "self") return;
  const name = String(side?.name || "").trim().toLowerCase();
  if (name) names.add(name);
}

function noteDropped(report, dropped) {
  for (const triple of dropped) {
    const reason = triple.reason || "unknown";
    report.counts.droppedByReason[reason] = (report.counts.droppedByReason[reason] || 0) + 1;
    report.counts.triplesDropped += 1;
    if (triple.silent || report.dropped.length >= 20) continue;
    report.dropped.push({
      reason,
      predicate: triple.predicate || null,
      subject: triple.subject?.name || null,
      object: triple.object?.name || null,
    });
  }
}

function noteQuestions(report, questions) {
  for (const question of questions || []) {
    if (question && !report.reviewQuestions.includes(question)) report.reviewQuestions.push(question);
  }
}

function canonize(triples, seenNames) {
  const incoming = [];
  for (const triple of triples) {
    if (triple.subject?.type !== "self" && triple.subject?.name) incoming.push(triple.subject.name);
    if (triple.object?.type !== "self" && triple.object?.name) incoming.push(triple.object.name);
  }
  const map = dedupeProposedNames([...seenNames, ...incoming]);
  for (const name of incoming) seenNames.push(name);
  for (const triple of triples) {
    if (triple.subject?.type !== "self" && map.has(triple.subject?.name)) triple.subject.name = map.get(triple.subject.name);
    if (triple.object?.type !== "self" && map.has(triple.object?.name)) triple.object.name = map.get(triple.object.name);
  }
}

function presentPlan(plan) {
  return {
    ...plan,
    kind: "deterministic",
    status: "confirmed",
    fromName: plan.fromName || null,
    toName: plan.toName || null,
    type: plan.type,
    subject: plan.fromName ? { name: plan.fromName } : null,
    object: plan.toName ? { name: plan.toName } : null,
  };
}

function trackSupersession(ledger, proposal, event) {
  const next = applySupersession(ledger, {
    fromName: proposal.fromName || proposal.subject?.name,
    toName: proposal.toName || proposal.object?.name,
    type: proposal.type,
    at: event?.occurredAt ? new Date(event.occurredAt).toISOString().slice(0, 10) : proposal.validFrom || null,
    validFrom: proposal.validFrom || null,
    validTo: proposal.validTo || null,
    correction: isCorrectionEvent(event),
    proposal,
  });
  for (const edge of next) {
    if (edge.proposal) edge.proposal.validTo = edge.validTo || null;
  }
  return next;
}

async function renameCreated(userId, seenNames, createdIds) {
  const map = dedupeProposedNames(seenNames);
  for (const [from, to] of map) {
    if (!from || from === to) continue;
    const id = createdIds.get(from);
    if (!id) continue;
    await prisma.entity.update({
      where: { id },
      data: { name: to, normalizedName: normalizeName(to) },
    });
    createdIds.delete(from);
    createdIds.set(to, id);
  }
}

function visionPlans(vision) {
  const links = Array.isArray(vision.connectedEntities) ? vision.connectedEntities : [];
  return links.filter((link) => link?.name).map((link) => ({
    kind: "deterministic",
    visionId: vision.id,
    type: link.role === "location" || link.relationship === "location" ? "planned_for" : "related_to",
    fromName: vision.title,
    toName: link.name,
  }));
}

function eventText(event) {
  return [event.title, event.understoodMeaning, event.fullText, event.rawInput].filter(Boolean).join("\n").slice(0, 8000);
}

async function loadRecords(kind, userId, onlyMissing, budget) {
  if (budget === 0) return [];
  const where = { userId };
  if (kind !== "diary") where.status = { not: "archived" };
  if (onlyMissing) where.graphExtractedAt = null;
  const query = {
    where,
    orderBy: kind === "event" ? [{ occurredAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }] : { createdAt: "asc" },
    ...(budget != null ? { take: budget } : {}),
  };
  if (kind === "event") return prisma.event.findMany(query);
  if (kind === "vision") return prisma.vision.findMany(query);
  return prisma.diaryEntry.findMany(query);
}

async function countMissing(userId) {
  const [events, visions, diary] = await Promise.all([
    prisma.event.count({ where: { userId, status: { not: "archived" }, graphExtractedAt: null } }),
    prisma.vision.count({ where: { userId, status: { not: "archived" }, graphExtractedAt: null } }),
    prisma.diaryEntry.count({ where: { userId, graphExtractedAt: null } }),
  ]);
  return events + visions + diary;
}

function noteSkip(report, item) {
  report.counts.eventsSkipped += 1;
  report.skipped.push(item);
}

async function pauseIfStuck(count, more) {
  if (count < 3 || !more) return { count, paused: false };
  console.warn("[graph-rebuild] pausing 60s after 3 skipped items");
  await sleep(60000);
  return { count: 0, paused: true };
}

function skipReason(err) {
  if (err?.status === 429) return "rate_limited";
  return err?.message || "failed";
}

function entryTitle(entry) {
  const text = String(entry?.rawContent || "").trim();
  return text ? text.slice(0, 80) : "journal";
}

async function applyLifeDates(userId, events) {
  for (const event of events) {
    const title = String(event.title || "");
    if (!/\bbirth\b/i.test(title) || !event.occurredAt) continue;
    const people = Array.isArray(event.people) ? event.people : [];
    for (const person of people) {
      const name = typeof person === "string" ? person : person?.name;
      if (!name) continue;
      const entity = await prisma.entity.findFirst({
        where: { userId, name: { equals: name, mode: "insensitive" }, status: { not: "archived" } },
      });
      if (entity && !entity.birthDate) {
        await prisma.entity.update({ where: { id: entity.id }, data: { birthDate: event.occurredAt } });
      }
    }
  }
}

function addCounts(report, committed) {
  report.conflicts.push(...(committed.conflicts || []));
  report.edges.created = (report.edges.created || 0) + committed.created;
  report.edges.updated = (report.edges.updated || 0) + committed.updated;
  report.edges.suggested = (report.edges.suggested || 0) + committed.suggested;
  report.counts.triplesProposed += committed.created + committed.updated;
  if (committed.dropped?.length) noteDropped(report, committed.dropped);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
