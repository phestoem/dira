const TYPES = {
  parent_of: def("family", "child_of", false, true, ["person"], ["person"]),
  child_of: def("family", "parent_of", false, true, ["person"], ["person"]),
  spouse_of: def("family", "spouse_of", true, true, ["person"], ["person"]),
  sibling_of: def("family", "sibling_of", true, true, ["person"], ["person"]),
  grandparent_of: def("family", "grandchild_of", false, true, ["person"], ["person"]),
  grandchild_of: def("family", "grandparent_of", false, true, ["person"], ["person"]),
  relative_of: def("family", "relative_of", true, true, ["person"], ["person"]),
  owns: def("ownership", "owned_by", false, true, ["person", "organisation"], ["property", "asset", "vehicle", "place", "project"]),
  owned_by: def("ownership", "owns", false, true, ["property", "asset", "vehicle", "place"], ["person", "organisation"]),
  co_owns: def("ownership", "co_owns", true, true, ["person"], ["property", "asset", "vehicle"]),
  lives_at: def("location", "residence_of", false, false, ["person"], ["place", "property"]),
  residence_of: def("location", "lives_at", false, false, ["place", "property"], ["person"]),
  located_in: def("location", "contains", false, false, ["place", "property", "asset"], ["place"]),
  contains: def("location", "located_in", false, false, ["place"], ["place", "property"]),
  born_in: def("location", "birthplace_of", false, false, ["person"], ["place"]),
  birthplace_of: def("location", "born_in", false, false, ["place"], ["person"]),
  happened_at: def("location", "location_of", false, false, ["event"], ["place", "property"]),
  location_of: def("location", "happened_at", false, false, ["place"], ["event"]),
  supervises: def("work", "supervised_by", false, false, ["person"], ["person", "project", "property"]),
  supervised_by: def("work", "supervises", false, false, ["person", "project"], ["person"]),
  manages: def("work", "managed_by", false, false, ["person"], ["project", "property", "person"]),
  managed_by: def("work", "manages", false, false, ["project", "person"], ["person"]),
  caretaker_of: def("work", "cared_for_by", false, false, ["person"], ["property", "place", "person"]),
  cared_for_by: def("work", "caretaker_of", false, false, ["property", "place", "person"], ["person"]),
  contractor_for: def("work", "contracted", false, false, ["person", "organisation"], ["project", "property", "person"]),
  contracted: def("work", "contractor_for", false, false, ["person", "project"], ["person", "organisation"]),
  works_at: def("work", "employs", false, false, ["person"], ["organisation", "project", "place"]),
  employs: def("work", "works_at", false, false, ["organisation"], ["person"]),
  founded: def("work", "founded_by", false, false, ["person"], ["organisation", "project"]),
  founded_by: def("work", "founded", false, false, ["organisation", "project"], ["person"]),
  participant_in: def("project", "has_participant", false, false, ["person", "entity"], ["event", "project", "vision"]),
  has_participant: def("project", "participant_in", false, false, ["event", "project"], ["person"]),
  part_of: def("project", "has_part", false, false, ["event", "project"], ["project", "vision"]),
  has_part: def("project", "part_of", false, false, ["project"], ["event", "project"]),
  paid: def("financial", "paid_by", false, true, ["person"], ["event", "person", "organisation"]),
  paid_by: def("financial", "paid", false, true, ["event", "person"], ["person"]),
  funded: def("financial", "funded_by", false, true, ["person", "organisation"], ["project", "event"]),
  funded_by: def("financial", "funded", false, true, ["project", "event"], ["person"]),
  contributed_to: def("financial", "received_contribution_from", false, true, ["person"], ["project", "event", "person"]),
  received_contribution_from: def("financial", "contributed_to", false, true, ["project", "person"], ["person"]),
  sent_money_to: def("financial", "received_money_from", false, true, ["person"], ["person", "organisation"]),
  received_money_from: def("financial", "sent_money_to", false, true, ["person"], ["person"]),
  friend_of: def("social", "friend_of", true, false, ["person"], ["person"]),
  knows: def("social", "knows", true, false, ["person"], ["person"]),
  witness_of: def("social", "witnessed_by", false, false, ["person"], ["event"]),
  witnessed_by: def("social", "witness_of", false, false, ["event"], ["person"]),
  planned_for: def("project", "has_plan", false, false, ["vision"], ["place", "project", "property"]),
  has_plan: def("project", "planned_for", false, false, ["place", "project"], ["vision"]),
  inspired_by: def("project", "inspired", false, false, ["vision", "person"], ["event", "vision", "person", "place"]),
  inspired: def("project", "inspired_by", false, false, ["event", "person"], ["vision"]),
  related_to: def("other", "related_to", true, false, ["entity", "event", "vision"], ["entity", "event", "vision"]),
};

const CANONICAL = new Set(Object.keys(TYPES));

const SYNONYMS = [
  [/^(mother of|father of|parent of|mama yake|baba yake)$/i, "parent_of", false],
  [/^(mother|mum|mom|mama|father|dad|baba|parent)$/i, "parent_of", true],
  [/^(child of|son of|daughter of|mtoto wa)$/i, "parent_of", true],
  [/^(son|daughter|child|mtoto|kid)$/i, "child_of", false],
  [/^(spouse of|wife of|husband of|married to|mke wa|mume wa)$/i, "spouse_of", false],
  [/^(wife|husband|spouse|mke|mume)$/i, "spouse_of", false],
  [/^(sibling of|sister of|brother of|dada yake|kaka yake)$/i, "sibling_of", false],
  [/^(sister|brother|sibling|dada|kaka)$/i, "sibling_of", false],
  [/^(grandmother|grandfather|grandparent|bibi|babu)$/i, "grandparent_of", true],
  [/^(grandchild|grandson|granddaughter|mjuku)$/i, "grandchild_of", false],
  [/^(relative|cousin|jamaa)$/i, "relative_of", false],
  [/^(owns|owner of|bought|purchased|alinunua|ananunua)$/i, "owns", false],
  [/^(owned by)$/i, "owns", true],
  [/^(co-owns|co owns|shares ownership)$/i, "co_owns", false],
  [/^(lives at|lives in|resides at)$/i, "lives_at", false],
  [/^(located in|is in)$/i, "located_in", false],
  [/^(born in|birthplace)$/i, "born_in", false],
  [/^(happened at|took place at|located at)$/i, "happened_at", false],
  [/^(supervises|supervisor of|msimamizi)$/i, "supervises", false],
  [/^(supervised by)$/i, "supervises", true],
  [/^(manages|manager of)$/i, "manages", false],
  [/^(caretaker of|takes care of|cares for|looks after)$/i, "caretaker_of", false],
  [/^(contractor for|fundi|contractor of)$/i, "contractor_for", false],
  [/^(works at|works for|employed by)$/i, "works_at", false],
  [/^(founded|founder of)$/i, "founded", false],
  [/^(participant in|attended|mentioned in)$/i, "participant_in", false],
  [/^(part of)$/i, "part_of", false],
  [/^(paid|paid for)$/i, "paid", false],
  [/^(funded|funds)$/i, "funded", false],
  [/^(contributed to|contributes to)$/i, "contributed_to", false],
  [/^(sent money to|sent|transferred to|paid to)$/i, "sent_money_to", false],
  [/^(friend of|friends with)$/i, "friend_of", false],
  [/^(knows)$/i, "knows", false],
  [/^(planned for|plan for)$/i, "planned_for", false],
  [/^(inspired by)$/i, "inspired_by", false],
  [/^(related to|linked to|related)$/i, "related_to", false],
];

const PHRASE = {
  parent_of: ["parent of", "child of"],
  child_of: ["child of", "parent of"],
  spouse_of: ["spouse of", "spouse of"],
  sibling_of: ["sibling of", "sibling of"],
  grandparent_of: ["grandparent of", "grandchild of"],
  grandchild_of: ["grandchild of", "grandparent of"],
  relative_of: ["relative of", "relative of"],
  owns: ["owns", "owned by"],
  owned_by: ["owned by", "owns"],
  co_owns: ["co-owns", "co-owns"],
  lives_at: ["lives at", "home of"],
  residence_of: ["home of", "lives at"],
  located_in: ["located in", "contains"],
  contains: ["contains", "located in"],
  born_in: ["born in", "birthplace of"],
  birthplace_of: ["birthplace of", "born in"],
  happened_at: ["happened at", "location of"],
  location_of: ["location of", "happened at"],
  supervises: ["supervises", "supervised by"],
  supervised_by: ["supervised by", "supervises"],
  manages: ["manages", "managed by"],
  managed_by: ["managed by", "manages"],
  caretaker_of: ["takes care of", "cared for by"],
  cared_for_by: ["cared for by", "takes care of"],
  contractor_for: ["contractor for", "contracted"],
  contracted: ["contracted", "contractor for"],
  works_at: ["works at", "employs"],
  employs: ["employs", "works at"],
  founded: ["founded", "founded by"],
  founded_by: ["founded by", "founded"],
  participant_in: ["took part in", "includes"],
  has_participant: ["includes", "took part in"],
  part_of: ["part of", "includes"],
  has_part: ["includes", "part of"],
  paid: ["paid", "paid by"],
  paid_by: ["paid by", "paid"],
  funded: ["funded", "funded by"],
  funded_by: ["funded by", "funded"],
  contributed_to: ["contributed to", "received a contribution from"],
  received_contribution_from: ["received a contribution from", "contributed to"],
  sent_money_to: ["sent money to", "received money from"],
  received_money_from: ["received money from", "sent money to"],
  friend_of: ["friend of", "friend of"],
  knows: ["knows", "knows"],
  witness_of: ["witness of", "witnessed by"],
  witnessed_by: ["witnessed by", "witness of"],
  planned_for: ["planned for", "has a plan"],
  has_plan: ["has a plan", "planned for"],
  inspired_by: ["inspired by", "inspired"],
  inspired: ["inspired", "inspired by"],
  related_to: ["related to", "related to"],
};

function def(category, inverse, symmetric, sensitive, from, to) {
  return { category, inverse, symmetric, sensitive, from, to };
}

export function listRelationshipTypes() {
  return Object.entries(TYPES).map(([type, meta]) => ({ type, ...meta, phrase: phraseFor(type, "out") }));
}

export function normalizeType(raw) {
  let text = String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  text = text.replace(/^(is|was|are|were|be)\s+/, "").replace(/^(a|an|the|my|our)\s+/, "");
  if (CANONICAL.has(text)) {
    return { type: text, reverse: false, ...publicMeta(text) };
  }
  for (const [pattern, type, reverse] of SYNONYMS) {
    if (pattern.test(text)) return { type, reverse, ...publicMeta(type) };
  }
  return null;
}

export function inverseOf(type) {
  return TYPES[type]?.inverse || "related_to";
}

export function isSymmetric(type) {
  return Boolean(TYPES[type]?.symmetric);
}

export function categoryOf(type) {
  return TYPES[type]?.category || "other";
}

export function isSensitive(type) {
  const category = categoryOf(type);
  return category === "family" || category === "financial" || category === "ownership" || Boolean(TYPES[type]?.sensitive);
}

export function phraseFor(type, direction = "out") {
  const pair = PHRASE[type] || ["related to", "related to"];
  return direction === "in" ? pair[1] : pair[0];
}

export function typeMeta(type) {
  return TYPES[type] || null;
}

function publicMeta(type) {
  const meta = TYPES[type];
  return {
    category: meta.category,
    symmetric: meta.symmetric,
    sensitive: isSensitive(type),
  };
}
