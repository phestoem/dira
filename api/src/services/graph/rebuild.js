import { prisma } from "../../prisma.js";
import { findDuplicateCandidates, getOrCreateSelf } from "./entityResolver.js";
import { anchorEventEdges, anchorVision, commitTriples, extractTriples } from "./relationshipExtractor.js";

export async function rebuildGraph(userId, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const report = {
    dryRun,
    entitiesCreated: 0,
    duplicateCandidates: [],
    edges: {},
    conflicts: [],
    proposed: [],
  };
  if (!dryRun) await getOrCreateSelf(userId);
  const events = await prisma.event.findMany({
    where: { userId, status: { not: "archived" } },
    orderBy: { createdAt: "asc" },
  });
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true }, select: { name: true } });
  const known = await prisma.entity.findMany({
    where: { userId, status: { not: "archived" }, mergedIntoId: null },
    select: { name: true, entityType: true },
    take: 40,
  });

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if ((index + 1) % 10 === 0) console.log(`[graph-rebuild] ${index + 1}/${events.length} events processed`);
    if (!dryRun) await anchorEventEdges(userId, event);
    const text = [event.title, event.understoodMeaning, String(event.fullText || "").slice(0, 3000)].filter(Boolean).join("\n");
    const extracted = await extractTriples(text, {
      selfName: self?.name,
      today: new Date().toISOString().slice(0, 10),
      title: event.title,
      known,
    });
    if (dryRun) {
      report.proposed.push(...extracted.triples.map((triple) => ({ eventId: event.id, ...triple })));
    } else {
      const committed = await commitTriples(userId, extracted.triples, {
        source: "backfill",
        evidenceEventId: event.id,
        entityFacts: extracted.entityFacts,
      });
      addCounts(report, committed);
    }
    if (index < events.length - 1) await sleep(1500);
  }

  const visions = await prisma.vision.findMany({ where: { userId, status: { not: "archived" } } });
  if (!dryRun) {
    for (const vision of visions) await anchorVision(userId, vision);
  }

  const journal = await prisma.diaryEntry.findMany({ where: { userId }, orderBy: { createdAt: "asc" }, take: 100 });
  for (const entry of journal) {
    const extracted = await extractTriples(String(entry.rawContent || "").slice(0, 3000), {
      selfName: self?.name,
      today: new Date().toISOString().slice(0, 10),
      known,
    });
    if (dryRun) {
      report.proposed.push(...extracted.triples.map((triple) => ({ journalId: entry.id, ...triple })));
    } else {
      const committed = await commitTriples(userId, extracted.triples, {
        source: "journal",
        forceStatus: "suggested",
        entityFacts: extracted.entityFacts,
      });
      addCounts(report, committed);
    }
    await sleep(1500);
  }

  if (!dryRun) await applyLifeDates(userId, events);
  report.duplicateCandidates = dryRun ? [] : await findDuplicateCandidates(userId);
  return report;
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
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
