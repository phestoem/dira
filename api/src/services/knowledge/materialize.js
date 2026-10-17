// Views the UI already reads, rebuilt from claims: Relationship rows (source "claims") for claims between two
// entities, and a person's birth and death dates. Claims are the truth; these rows are a projection of them.
import { prisma } from "../../prisma.js";
import { categoryOf } from "../graph/relationshipTypes.js";

// Claim predicate → Relationship type the UI knows, with the label it shows when the type is broader.
const EDGE = {
  parent_of: { type: "parent_of" },
  spouse_of: { type: "spouse_of" },
  sibling_of: { type: "sibling_of" },
  relative_of: { type: "relative_of" },
  friend_of: { type: "friend_of" },
  neighbour_of: { type: "knows", label: "neighbour" },
  knows: { type: "knows" },
  works_at: { type: "works_at" },
  colleague_of: { type: "knows", label: "colleague" },
  manages: { type: "manages" },
  client_of: { type: "related_to", label: "client" },
  contractor_for: { type: "contractor_for" },
  business_partner_of: { type: "knows", label: "business partner" },
  founded: { type: "founded" },
  director_of: { type: "works_at", label: "director" },
  owns_share_of: { type: "owns", label: "shareholder" },
  member_of: { type: "related_to", label: "member" },
  studied_at: { type: "studies_at" },
  owns: { type: "owns" },
  rents: { type: "lives_at", label: "rents" },
  located_in: { type: "located_in" },
  issued_by: { type: "related_to", label: "issued by" },
  paid: { type: "paid" },
  contributed_to: { type: "contributed_to" },
  owes: { type: "related_to", label: "owes" },
  works_on: { type: "participant_in" },
  part_of: { type: "part_of" },
  visited: { type: "related_to", label: "visited" },
  lives_in: { type: "lives_at" },
  related_to: { type: "related_to" },
};

const ACTIVE = { in: ["stated", "confirmed"] };

export async function materialize(userId) {
  const claims = await prisma.claim.findMany({ where: { userId, status: ACTIVE }, orderBy: { createdAt: "asc" } });
  const rows = new Map();
  for (const claim of claims) {
    const edge = claim.objectId && EDGE[claim.predicate];
    if (!edge) continue;
    const attributes = {};
    if (claim.label) attributes.kind = claim.label;
    if (claim.amount != null) Object.assign(attributes, { amount: Number(claim.amount), currency: claim.currency });
    if (claim.until) Object.assign(attributes, { ended: claim.until.toISOString().slice(0, 10), endPrecision: claim.untilPrecision });
    if (claim.datePrecision) attributes.startPrecision = claim.datePrecision;
    attributes.claimId = claim.id;
    rows.set(`${claim.subjectId}|${edge.type}|${claim.objectId}`, {
      userId,
      fromKind: "entity",
      fromId: claim.subjectId,
      toKind: "entity",
      toId: claim.objectId,
      type: edge.type,
      label: edge.label || claim.label || null,
      category: categoryOf(edge.type),
      status: "confirmed",
      source: "claims",
      confidence: 0.9,
      validFrom: claim.date,
      validTo: claim.until,
      evidenceEventId: claim.eventId,
      evidenceText: claim.evidence,
      attributes,
    });
  }
  await prisma.relationship.deleteMany({ where: { userId, source: "claims" } });
  if (rows.size) await prisma.relationship.createMany({ data: [...rows.values()], skipDuplicates: true });

  // Birth and death dates on the person, from the latest active claim (year-only dates keep 1 January, as before).
  const dated = new Map();
  for (const claim of claims) {
    if (!["born", "died"].includes(claim.predicate) || !claim.value) continue;
    const [year, month = "01", day = "01"] = claim.value.split("-");
    const field = claim.predicate === "born" ? "birthDate" : "deathDate";
    dated.set(`${claim.subjectId}|${field}`, { id: claim.subjectId, field, date: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))) });
  }
  for (const { id, field, date } of dated.values()) {
    await prisma.entity.update({ where: { id }, data: { [field]: date } }).catch(() => {});
  }
}
