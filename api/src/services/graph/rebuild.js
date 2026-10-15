import { prisma } from "../../prisma.js";
import { findDuplicateCandidates, getOrCreateSelf, resolveEntity } from "./entityResolver.js";
import {
  absorbDroppedPayment,
  anchorEventEdges,
  anchorVision,
  commitTriples,
  deterministicEdgePlans,
  extractTriples,
  extractWithRetry,
  markGraphExtracted,
  prepareTriples,
} from "./relationshipExtractor.js";
import { isSensitive, normalizeType } from "./relationshipTypes.js";

export async function catchUpGraphExtractions() {
  const users = await prisma.user.findMany({ select: { id: true } });
  for (const user of users) {
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
    counts: {
      eventsProcessed: 0,
      eventsSkipped: 0,
      triplesProposed: 0,
      triplesDropped: 0,
      newEntities: 0,
    },
  };
  const newNames = new Set();
  let consecutiveSkips = 0;
  if (!dryRun) await getOrCreateSelf(userId);
  const events = await loadRecords("event", userId, onlyMissing, budget);
  if (budget != null) budget -= events.length;
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true }, select: { id: true, name: true } });
  const known = await prisma.entity.findMany({
    where: { userId, status: { not: "archived" }, mergedIntoId: null },
    select: { name: true, entityType: true },
    take: 40,
  });

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    try {
      const plans = deterministicEdgePlans(event, self?.name);
      const extracted = await extractWithRetry(() => extractTriples(eventText(event), {
        selfName: self?.name,
        today: new Date().toISOString().slice(0, 10),
        title: event.title,
        known,
      }));
      const prepared = prepareTriples(extracted.triples);
      for (const triple of prepared.dropped) absorbDroppedPayment(plans, triple, event, self?.name);
      if (dryRun) {
        noteDropped(report, prepared.dropped);
        report.proposed.push(...plans);
        for (const triple of prepared.kept) {
          const proposal = await describeTriple(userId, triple, self, newNames, { source: "backfill", evidenceEventId: event.id });
          if (proposal.reason) {
            noteDropped(report, [{ ...triple, reason: proposal.reason }]);
            continue;
          }
          report.proposed.push({ eventId: event.id, ...proposal });
          report.counts.triplesProposed += 1;
          await tally(report, userId, proposal, true);
        }
        for (const plan of plans) await tally(report, userId, plan, true);
      } else {
        await anchorEventEdges(userId, event);
        const committed = await commitTriples(userId, extracted.triples, {
          source: "backfill",
          evidenceEventId: event.id,
          title: event.title,
          entityFacts: extracted.entityFacts,
        });
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
      const extracted = await extractWithRetry(() => extractTriples(String(entry.rawContent || "").slice(0, 3000), {
        selfName: self?.name,
        today: new Date().toISOString().slice(0, 10),
        known,
      }));
      const prepared = prepareTriples(extracted.triples);
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
          entityFacts: extracted.entityFacts,
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
  report.duplicateCandidates = dryRun ? [] : await findDuplicateCandidates(userId);
  report.counts.newEntities = newNames.size;
  return report;
}

async function describeTriple(userId, triple, self, newNames, meta) {
  const normalized = normalizeType(triple.predicate);
  if (!normalized) return { reason: "unknown-predicate" };
  const subject = await resolveSide(userId, triple.subject, self, true);
  const object = await resolveSide(userId, triple.object, self, true);
  if (subject.entity && object.entity && subject.entity.id === object.entity.id) return { reason: "same-node" };
  rememberNew(newNames, subject, triple.subject);
  rememberNew(newNames, object, triple.object);
  const ambiguous = subject.matchedBy === "ambiguous" || object.matchedBy === "ambiguous";
  const status = proposedStatus(triple, meta.source, normalized.type, ambiguous);
  return {
    kind: "extracted",
    ...triple,
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
  report.counts.triplesDropped += dropped.length;
  for (const triple of dropped) {
    if (report.dropped.length >= 20) break;
    report.dropped.push({
      reason: triple.reason,
      predicate: triple.predicate || null,
      subject: triple.subject?.name || null,
      object: triple.object?.name || null,
    });
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
  return [event.title, event.understoodMeaning, String(event.fullText || "").slice(0, 3000)].filter(Boolean).join("\n");
}

async function loadRecords(kind, userId, onlyMissing, budget) {
  if (budget === 0) return [];
  const where = { userId };
  if (kind !== "diary") where.status = { not: "archived" };
  if (onlyMissing) where.graphExtractedAt = null;
  const query = {
    where,
    orderBy: { createdAt: "asc" },
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
