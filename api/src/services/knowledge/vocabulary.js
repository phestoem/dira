// The core claim vocabulary (docs/knowledge-layer.md). One table for the extractor, the validator, the resolver, the
// answer tools and the scorer: a predicate's domain, what its object is, and whether it reads the same both ways.

export const ENTITY_TYPES = ["person", "organisation", "place", "property", "vehicle", "document", "project", "asset", "event"];

export const DOMAINS = ["people", "work", "assets", "money", "projects", "time", "plans"];

// object: "entity" (objectId), "value" (value), "either", or "date" (value is an ISO date at some precision).
const P = (domain, object, extra = {}) => ({ domain, object, ...extra });

export const PREDICATES = {
  // people
  parent_of: P("people", "entity"),
  spouse_of: P("people", "entity", { symmetric: true }),
  sibling_of: P("people", "entity", { symmetric: true }),
  relative_of: P("people", "entity"),
  friend_of: P("people", "entity", { symmetric: true }),
  neighbour_of: P("people", "entity", { symmetric: true }),
  knows: P("people", "entity", { symmetric: true }),
  // work
  works_at: P("work", "entity"),
  colleague_of: P("work", "entity", { symmetric: true }),
  manages: P("work", "entity"),
  client_of: P("work", "entity"),
  contractor_for: P("work", "entity"),
  business_partner_of: P("work", "entity", { symmetric: true }),
  founded: P("work", "entity"),
  director_of: P("work", "entity"),
  owns_share_of: P("work", "entity"),
  member_of: P("work", "entity"),
  studied_at: P("work", "entity"),
  // assets and documents
  owns: P("assets", "entity"),
  rents: P("assets", "entity"),
  bought: P("assets", "entity"),
  sold: P("assets", "entity"),
  located_in: P("assets", "entity"),
  identifier: P("assets", "value"),
  expires_on: P("assets", "date"),
  renews_on: P("assets", "date"),
  valued_at: P("assets", "value"),
  issued_by: P("assets", "entity"),
  // money
  paid: P("money", "entity"),
  received_from: P("money", "entity"),
  contributed_to: P("money", "entity"),
  owes: P("money", "entity"),
  earns: P("money", "either"),
  costs: P("money", "value"),
  // projects
  status: P("projects", "value"),
  works_on: P("projects", "entity"),
  part_of: P("projects", "entity"),
  milestone: P("projects", "value"),
  // time
  born: P("time", "date"),
  died: P("time", "date"),
  happened: P("time", "date"),
  visited: P("time", "entity"),
  lives_in: P("time", "entity"),
  scheduled: P("time", "date"),
  due_on: P("time", "date"),
  // plans
  plans: P("plans", "value"),
  decided: P("plans", "value"),
  intends: P("plans", "value"),
  // escape hatch: anything stated that fits nothing above, in the user's words (label) with evidence
  related_to: P("people", "either"),
};

// Same fact, other direction: "B received from A" is "A paid B".
export const INVERSES = { received_from: "paid" };

export const CLAIM_STATUSES = ["stated", "confirmed", "rejected", "superseded"];
export const PRECISIONS = ["day", "month", "year"];

export function domainOf(predicate) {
  return PREDICATES[predicate]?.domain || null;
}
