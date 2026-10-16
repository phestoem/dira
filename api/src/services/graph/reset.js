import { prisma } from "../../prisma.js";
import { getOrCreateSelf } from "./entityResolver.js";
import { setGraphAutoExtract } from "./autoExtract.js";

export function stripEntityIds(list) {
  if (!Array.isArray(list)) return { list, removed: 0 };
  let removed = 0;
  const next = list.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.entityId == null) return item;
    const copy = { ...item };
    delete copy.entityId;
    removed += 1;
    return copy;
  });
  return { list: next, removed };
}

export async function resetGraph(userId, options = {}) {
  const dryRun = options.dryRun !== false;
  const [entities, edges, events, visions, journal] = await Promise.all([
    prisma.entity.count({ where: { userId, isSelf: false } }),
    prisma.relationship.count({ where: { userId } }),
    prisma.event.findMany({ where: { userId }, select: { id: true, people: true, places: true, graphExtractedAt: true } }),
    prisma.vision.findMany({ where: { userId }, select: { id: true, connectedEntities: true, graphExtractedAt: true } }),
    prisma.diaryEntry.count({ where: { userId, graphExtractedAt: { not: null } } }),
  ]);
  const eventRefs = events.reduce((sum, event) => sum + stripEntityIds(event.people).removed + stripEntityIds(event.places).removed, 0);
  const visionRefs = visions.reduce((sum, vision) => sum + stripEntityIds(vision.connectedEntities).removed, 0);
  const report = {
    dryRun,
    entities,
    edges,
    references: eventRefs + visionRefs,
    extractedAt: {
      events: events.filter((event) => event.graphExtractedAt).length,
      visions: visions.filter((vision) => vision.graphExtractedAt).length,
      journal,
    },
  };
  if (dryRun) return report;

  await prisma.relationship.deleteMany({ where: { userId } });
  await prisma.entity.deleteMany({ where: { userId, isSelf: false } });
  const self = await prisma.entity.findFirst({ where: { userId, isSelf: true, status: { not: "archived" } } });
  if (!self) await getOrCreateSelf(userId);

  for (const event of events) {
    const people = stripEntityIds(event.people);
    const places = stripEntityIds(event.places);
    const data = {};
    if (people.removed) data.people = people.list;
    if (places.removed) data.places = places.list;
    if (event.graphExtractedAt) data.graphExtractedAt = null;
    if (Object.keys(data).length) await prisma.event.update({ where: { id: event.id }, data });
  }
  for (const vision of visions) {
    const links = stripEntityIds(vision.connectedEntities);
    const data = {};
    if (links.removed) data.connectedEntities = links.list;
    if (vision.graphExtractedAt) data.graphExtractedAt = null;
    if (Object.keys(data).length) await prisma.vision.update({ where: { id: vision.id }, data });
  }
  if (journal) {
    await prisma.diaryEntry.updateMany({
      where: { userId, graphExtractedAt: { not: null } },
      data: { graphExtractedAt: null },
    });
  }
  await setGraphAutoExtract(userId, false);
  console.log(`[graph-reset] removed ${report.entities} entities, ${report.edges} edges.`);
  return report;
}
