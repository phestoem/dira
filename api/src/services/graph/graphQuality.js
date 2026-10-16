import { normalizeName } from "./entityResolver.js";
import { fitsGender, genderOf, KIN_PATTERN, knownGender, SELF_PRONOUNS, THIRD_PERSON } from "./kinship.js";
import { categoryOf, inverseOf, normalizeType, typeMeta } from "./relationshipTypes.js";

// Self pronouns are matched on their own (selfMatchKind), never stored or compared as aliases.
const ROLE_WORDS = ["the individual", "the user", "the owner", "the occupier", "the buyer"];
// "I married Ana on …" states a spouse without a kinship word; it supports spouse_of and nothing else.
const MARRIAGE_WORD = /\b(married|marriage|marry|wed|wedding|ndoa|alioa|aliolewa|tulioana)\b/i;
// Any role word the vocabulary knows ("stepfather", "sister-in-law", "bibi"), or a birth-order word ("our youngest").
const KINSHIP_WORD = new RegExp(`\\b(${KIN_PATTERN}|firstborn|first-born|eldest|oldest|youngest|last-born|twins)\\b`, "i");
const PLACEHOLDER_ROLES = {
  wife: ["spouse"],
  husband: ["spouse"],
  spouse: ["spouse"],
  parents: ["parent"],
  parent: ["parent"],
  mother: ["parent"],
  father: ["parent"],
  children: ["child"],
  child: ["child"],
  sons: ["child"],
  son: ["child"],
  daughters: ["child"],
  daughter: ["child"],
  sisters: ["sibling"],
  sister: ["sibling"],
  brothers: ["sibling"],
  brother: ["sibling"],
  family: ["spouse", "parent", "child", "sibling", "relative"],
};
const GENERIC_ACTIVITY = /^(landscaping|purchase|renovation|construction|maintenance|repair|cleaning|painting|plumbing|fencing|installation)$/i;
const MONEY_WORD = /^(cash|payment|payments|cost|costs|fee|fees|price)$/i;
const LAND_WORD = { plot: 4, parcel: 4, house: 5, shamba: 3, land: 2, property: 1 };
const STOP_WORD = new Set(["the", "a", "an", "of", "in", "at", "on", "and", "existing", "new", "for"]);

export function buildSelfAliasSet({ names = [], aliases = [] } = {}) {
  const seen = new Set();
  const out = [];
  for (const item of [...ROLE_WORDS, ...names, ...aliases]) {
    const key = normalizeName(item);
    if (!key || seen.has(key) || SELF_PRONOUNS.has(key)) continue;
    seen.add(key);
    out.push(String(item).trim());
  }
  return out;
}

export function mentionsSelf(name, aliases = []) {
  return selfMatchKind(name, aliases) != null;
}

export function selfMatchKind(name, aliases = []) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  if (SELF_PRONOUNS.has(normalized)) return "pronoun";
  const keys = aliases.map((item) => normalizeName(item)).filter(Boolean);
  if (keys.includes(normalized)) return "exact";
  const parts = normalized.split(" ");
  if (parts.length < 2) return null;
  const first = parts[0];
  const last = parts[parts.length - 1];
  for (const alias of keys) {
    const bits = alias.split(" ");
    if (bits.length < 2 || bits[0] !== first) continue;
    const surname = bits[bits.length - 1];
    if (surname.length >= 4 && last.length >= 4 && editDistance(surname, last) <= 2) return "fuzzy";
  }
  return null;
}

export function fullNameFromProfile(event) {
  if (!event) return null;
  const text = [event.title, event.understoodMeaning, String(event.fullText || "").slice(0, 2000)].filter(Boolean).join("\n");
  const labeled = text.match(/\b(?:full name|name)\s*[:\-]\s*([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,3})/u);
  if (labeled) return labeled[1];
  const people = Array.isArray(event.people) ? event.people : [];
  for (const person of people) {
    const name = typeof person === "string" ? person : person?.name;
    if (name && normalizeName(name).split(" ").length >= 2) return name;
  }
  return null;
}

export function relativesFromEdges(edges, selfId, namesById = new Map(), kindsById = new Map()) {
  const relatives = [];
  for (const edge of edges || []) {
    if (edge.status !== "confirmed" || edge.category !== "family") continue;
    const selfFrom = edge.fromId === selfId;
    const selfTo = edge.toId === selfId;
    if (!selfFrom && !selfTo) continue;
    const otherId = selfFrom ? edge.toId : edge.fromId;
    let role = "relative";
    if (edge.type === "spouse_of") role = "spouse";
    else if (edge.type === "sibling_of") role = "sibling";
    else if (edge.type === "parent_of") role = selfTo ? "parent" : "child";
    else if (edge.type === "child_of") role = selfFrom ? "parent" : "child";
    relatives.push({ role, id: otherId, name: namesById.get(otherId) || otherId, gender: knownGender({ kind: kindsById.get(otherId) }, edge) });
  }
  return relatives;
}

export function alignPredicate(subjectType, predicate, objectType) {
  const normalized = normalizeType(predicate);
  if (!normalized) return { reason: "unknown-predicate" };
  const from = normalized.reverse ? objectType : subjectType;
  const to = normalized.reverse ? subjectType : objectType;
  if (fits(normalized.type, from, to)) return { type: normalized.type, reverse: normalized.reverse };
  const inverse = inverseOf(normalized.type);
  if (inverse && inverse !== normalized.type && fits(inverse, from, to)) {
    return { type: inverse, reverse: normalized.reverse };
  }
  if (isPerson(subjectType) && wantsEventishSubject(normalized.type) && fits(inverse, subjectType, objectType)) {
    return { type: inverse, reverse: false };
  }
  return { reason: "bad-direction" };
}

export function applySupersession(existing, incoming) {
  const edges = existing.map((edge) => ({ ...edge }));
  const next = { ...incoming, validTo: incoming.validTo || null };
  const key = supersessionKey(next);
  if (!key) return edges.concat(next);
  const at = next.at || next.validFrom || null;
  for (const edge of edges) {
    if (supersessionKey(edge) !== key || edge.validTo) continue;
    if (normalizeName(edge.toName) === normalizeName(next.toName) && normalizeName(edge.fromName) === normalizeName(next.fromName)) continue;
    const edgeAt = edge.at || edge.validFrom || null;
    const incomingWins = Boolean(next.correction) || !edgeAt || !at || String(at) >= String(edgeAt);
    if (incomingWins) edge.validTo = at || next.at || null;
    else next.validTo = edgeAt;
  }
  return edges.concat(next);
}

export function dedupeProposedNames(names) {
  const items = [];
  const seen = new Set();
  for (const name of names) {
    const text = String(name || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    items.push(describeName(text));
  }
  const parent = items.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    return cursor;
  };
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (!sameLocation(items[left], items[right])) continue;
      const overlap = tokenOverlap(items[left], items[right]);
      if (overlap < 0.7 && !(isLandish(items[left]) && isLandish(items[right]))) continue;
      parent[find(right)] = find(left);
    }
  }
  const groups = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(item);
    groups.set(root, group);
  });
  const map = new Map();
  for (const group of groups.values()) {
    const preferred = preferredName(group);
    for (const item of group) map.set(item.name, preferred);
  }
  return map;
}

export function groupSuggestions(edges, selfName = "") {
  const family = [];
  const assets = [];
  const relationships = [];
  for (const edge of edges || []) {
    if (edge.category === "family") family.push(edge);
    else if (edge.category === "ownership") assets.push(edge);
    else relationships.push(edge);
  }
  return {
    relationships,
    family: family.length ? {
      title: "Your family as DIRA understands it",
      people: family.map((edge) => familyPerson(edge, selfName)),
    } : null,
    assets: assets.length ? {
      title: "Your assets",
      items: assets.map((edge) => assetItem(edge, selfName)),
    } : null,
    count: relationships.length + (family.length ? 1 : 0) + (assets.length ? 1 : 0),
  };
}

export function isCorrectionEvent(event) {
  return event?.eventType === "correction" || /\bcorrection\b/i.test(String(event?.title || ""));
}

export function dropReason(triple, context = {}) {
  const subject = sideName(triple?.subject);
  const object = sideName(triple?.object);
  if (isIssued(triple?.predicate)) return "administrative";
  if (THIRD_PERSON.has(normalizeName(subject)) || THIRD_PERSON.has(normalizeName(object))) return "unresolved-pronoun";
  if (lifeFactOf(triple)) return "life-fact";
  if (unresolvedPlaceholder(subject, context) || unresolvedPlaceholder(object, context)) return "unresolved-kinship";
  if (isDateName(subject) || isDateName(object)) return "date-as-node";
  if (isMoneyName(subject) || isMoneyName(object)) return "amount-as-node";
  if (isQuantityName(subject) || isQuantityName(object)) return "quantity-as-node";
  if (isStatusName(subject) || isStatusName(object)) return "status-as-node";
  if (isGenericNode(subject) || isGenericNode(object)) return "generic-node";
  const aligned = alignPredicate(triple?.subject?.type, triple?.predicate, triple?.object?.type);
  if (aligned.reason) return aligned.reason;
  const evidence = `${triple?.evidence || ""} ${context.message || ""} ${context.sourceText || ""}`;
  if (possessiveMismatch(triple, aligned.type, evidence, context)) return "possessive-mismatch";
  if (categoryOf(aligned.type) === "family" && !KINSHIP_WORD.test(evidence) && !(aligned.type === "spouse_of" && MARRIAGE_WORD.test(evidence))) return "unsupported-family";
  if (subject && object && normalizeName(subject) === normalizeName(object)) return "same-node";
  return null;
}

export function prepareTriples(triples, context = {}) {
  const kept = [];
  const dropped = [];
  const entityFacts = [];
  const reviewQuestions = [];
  const selfSpellings = [];
  for (const raw of Array.isArray(triples) ? triples : []) {
    for (const triple of expandSale(raw)) {
      const rewritten = rewriteSelf(applyMarriageDate(triple), context, selfSpellings);
      const life = lifeFactOf(rewritten);
      if (life) {
        entityFacts.push(life);
        dropped.push({ ...rewritten, reason: "life-fact", silent: true });
        continue;
      }
      const reason = dropReason(rewritten, context);
      if (reason === "unresolved-kinship") {
        const word = placeholderWord(rewritten);
        dropped.push({ ...rewritten, reason });
        reviewQuestions.push(`Who is '${word}' in: ${clip(rewritten.evidence)}?`);
        continue;
      }
      if (reason) {
        dropped.push({ ...rewritten, reason, silent: reason === "administrative" || reason === "life-fact" });
        continue;
      }
      const aligned = alignPredicate(rewritten.subject?.type, rewritten.predicate, rewritten.object?.type);
      for (const concrete of materializePlaceholders(rewritten, context)) {
        kept.push({ ...concrete, predicate: aligned.type, _reverse: aligned.reverse });
      }
    }
  }
  return { kept, dropped, entityFacts, reviewQuestions, selfSpellings };
}

// Why a name cannot be a person: an amount, a date, a count, a status or a generic word.
export function notPersonReason(name) {
  if (isMoneyName(name)) return "amount-as-person";
  if (isDateName(name)) return "date-as-person";
  if (isQuantityName(name)) return "quantity-as-person";
  if (isStatusName(name) || isGenericNode(name)) return "generic-as-person";
  return null;
}

export function editDistance(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index]);
  for (let col = 1; col <= b.length; col += 1) rows[0][col] = col;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
    }
  }
  return rows[a.length][b.length];
}

function rewriteSelf(triple, context, spellings) {
  const next = {
    ...triple,
    subject: sideCopy(triple.subject),
    object: sideCopy(triple.object),
  };
  for (const side of [next.subject, next.object]) {
    if (!side) continue;
    const kind = selfMatchKind(side.name, context.selfAliases || []);
    if (!kind && side.type !== "self") continue;
    if (kind === "fuzzy") spellings.push(side.name);
    side.type = "self";
    side.name = context.selfName || side.name || "me";
  }
  return next;
}

function materializePlaceholders(triple, context) {
  const subjects = placeholderTargets(triple.subject, context);
  const objects = placeholderTargets(triple.object, context);
  const out = [];
  for (const subject of subjects) {
    for (const object of objects) {
      out.push({ ...triple, subject, object });
    }
  }
  return out.length ? out : [triple];
}

function placeholderTargets(side, context) {
  if (!side) return [side];
  const hit = resolvePlaceholder(side.name, context.relatives || []);
  if (!hit.placeholder || !hit.resolved.length) return [side];
  return hit.resolved.map((person) => ({ name: person.name, type: "person", entityId: person.id }));
}

function unresolvedPlaceholder(name, context) {
  const hit = resolvePlaceholder(name, context.relatives || []);
  return hit.placeholder && hit.resolved.length === 0;
}

function resolvePlaceholder(name, relatives) {
  const key = placeholderKey(name);
  const roles = PLACEHOLDER_ROLES[key];
  if (!roles) return { placeholder: false, resolved: [] };
  const gender = genderOf(key);
  return { placeholder: true, resolved: relatives.filter((person) => roles.includes(person.role) && fitsGender(gender, person.gender)) };
}

function placeholderKey(name) {
  return normalizeName(name).replace(/^(my|our|the)\s+/, "");
}

function placeholderWord(triple) {
  for (const side of [triple.subject, triple.object]) {
    if (PLACEHOLDER_ROLES[placeholderKey(side?.name)]) return placeholderKey(side.name);
  }
  return "family";
}

function expandSale(triple) {
  const predicate = String(triple?.predicate || "").trim().toLowerCase();
  if (!/^(sold|sold to|sale|sale of)$/.test(predicate)) return [triple];
  const date = triple.validFrom || triple.attributes?.date || dateIn(triple.evidence);
  const seller = sideCopy(triple.subject);
  const objectType = String(triple.object?.type || "").toLowerCase();
  const objectIsPerson = ["person", "self", "organisation"].includes(objectType);
  const asset = objectIsPerson ? namedSide(triple.attributes?.asset || triple.attributes?.item || triple.attributes?.property, "property") : sideCopy(triple.object);
  const buyer = objectIsPerson ? sideCopy(triple.object) : namedSide(triple.attributes?.buyer || triple.attributes?.to || triple.attributes?.purchaser, "person");
  if (!buyer || !asset) return [{ ...triple, predicate: "sold_to" }];
  return [
    { ...triple, subject: buyer, predicate: "owns", object: asset, validFrom: date || null, validTo: null },
    { ...triple, subject: seller, predicate: "owns", object: asset, validFrom: null, validTo: date || null },
    { ...triple, subject: seller, predicate: "sold_to", object: buyer, validFrom: date || null, validTo: null },
  ];
}

function applyMarriageDate(triple) {
  const normalized = normalizeType(triple?.predicate);
  if (normalized?.type !== "spouse_of" || triple.validFrom) return triple;
  const date = dateIn(triple.evidence) || triple.attributes?.date || null;
  return date ? { ...triple, validFrom: date } : triple;
}

function possessiveMismatch(triple, type, evidence, context) {
  if (type !== "spouse_of") return false;
  if (!/\b(my|our)\s+(wife|husband)\b|\b(mke|mume)\s+wangu\b/i.test(evidence || "")) return false;
  return !sideIsSelf(triple?.subject, context) && !sideIsSelf(triple?.object, context);
}

function sideIsSelf(side, context) {
  if (!side) return false;
  if (String(side.type || "").toLowerCase() === "self") return true;
  const name = normalizeName(side.name);
  if (!name) return false;
  if (/^(i|me|myself|mimi|self)$/.test(name)) return true;
  if (context?.selfName && normalizeName(context.selfName) === name) return true;
  return (context?.selfAliases || []).some((alias) => normalizeName(alias) === name);
}

function lifeFactOf(triple) {
  const predicate = String(triple?.predicate || "").trim().toLowerCase();
  const name = sideName(triple?.subject);
  if (!name) return null;
  const date = dateIn(sideName(triple?.object)) || dateIn(triple?.evidence) || triple?.attributes?.date || triple?.validFrom || null;
  if (/^(died|passed away|alifariki|deathdate|death date|date of death)$/.test(predicate)) {
    return { name, deathDate: date };
  }
  if (/^(born|born on|birthdate|birth date|date of birth)$/.test(predicate)) {
    return { name, birthDate: date };
  }
  return null;
}

function isIssued(predicate) {
  return /^issued$/.test(String(predicate || "").trim().toLowerCase());
}

function supersessionKey(edge) {
  if (!edge?.type) return null;
  if (edge.type === "located_in" || edge.type === "lives_at") return `${edge.type}:${normalizeName(edge.fromName)}`;
  if (edge.type === "owns") return `owns:${normalizeName(edge.toName)}`;
  if (edge.type === "owned_by") return `owns:${normalizeName(edge.fromName)}`;
  return null;
}

function describeName(name) {
  const location = locationOf(name);
  return { name, location, tokens: tokensOf(name) };
}

function locationOf(name) {
  const match = String(name).match(/\bin\s+(.+)$/i);
  return match ? normalizeName(match[1]) : "";
}

function tokensOf(name) {
  return normalizeName(name).split(" ").filter((token) => token && !STOP_WORD.has(token));
}

function sameLocation(left, right) {
  if (!left.location || !right.location) return false;
  const rightTokens = right.location.split(" ").filter((token) => token.length > 3);
  const leftTokens = new Set(left.location.split(" "));
  return rightTokens.some((token) => leftTokens.has(token));
}

function tokenOverlap(left, right) {
  const a = new Set(left.tokens);
  const b = new Set(right.tokens);
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (Math.min(a.size, b.size) || 1);
}

function isLandish(item) {
  return item.tokens.some((token) => LAND_WORD[token]);
}

function preferredName(group) {
  if (group.length === 1) return group[0].name;
  let word = "";
  let score = 0;
  const shared = sharedPlace(group);
  for (const item of group) {
    for (const token of item.tokens) {
      if ((LAND_WORD[token] || 0) > score) {
        score = LAND_WORD[token];
        word = token;
      }
    }
  }
  if (shared && word) return `${titleWord(shared)} ${word}`;
  return group.slice().sort((a, b) => b.tokens.length - a.tokens.length)[0].name;
}

function sharedPlace(group) {
  const sets = group.map((item) => item.location.split(" ").filter((token) => token.length > 3));
  const first = sets[0] || [];
  return first.find((token) => sets.every((set) => set.includes(token))) || "";
}

function titleWord(value) {
  return String(value || "").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function familyPerson(edge, selfName) {
  const fromSelf = selfName && normalizeName(edge.fromName) === normalizeName(selfName);
  const name = fromSelf ? edge.toName : edge.fromName;
  return {
    edgeId: edge.id,
    name,
    relation: relationLabel(edge.type, fromSelf),
    evidence: edge.evidenceText || null,
  };
}

function assetItem(edge, selfName) {
  const asset = edge.type === "owned_by" ? edge.fromName : edge.toName;
  const owner = edge.type === "owned_by" ? edge.toName : edge.fromName;
  return {
    edgeId: edge.id,
    name: asset || edge.toName,
    owner: owner || selfName || edge.fromName,
    relation: String(edge.type || "").replaceAll("_", " "),
    evidence: edge.evidenceText || null,
  };
}

function relationLabel(type, fromSelf) {
  if (type === "spouse_of") return "spouse";
  if (type === "sibling_of") return "sibling";
  if (type === "parent_of") return fromSelf ? "child" : "parent";
  if (type === "child_of") return fromSelf ? "parent" : "child";
  return "relative";
}

function fits(type, fromType, toType) {
  const meta = typeMeta(type);
  if (!meta) return false;
  return allows(meta.from, fromType) && allows(meta.to, toType);
}

function allows(list, type) {
  const mapped = mapType(type);
  if (!mapped) return false;
  if (list.includes("entity") || list.includes(mapped)) return true;
  if (mapped === "vehicle" && (list.includes("asset") || list.includes("property"))) return true;
  if (mapped === "property" && list.includes("place")) return true;
  return false;
}

function wantsEventishSubject(type) {
  const from = typeMeta(type)?.from || [];
  return from.some((item) => ["event", "project", "vision"].includes(item)) && !from.includes("person");
}

function isPerson(type) {
  return mapType(type) === "person";
}

function mapType(type) {
  const text = String(type || "").toLowerCase();
  if (text === "self") return "person";
  if (["person", "place", "property", "project", "organisation", "asset", "vehicle", "document", "event", "vision"].includes(text)) return text;
  return text || "other";
}

function dateIn(value) {
  const text = String(value || "");
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const year = text.match(/\b(19|20)\d{2}\b/);
  return year ? `${year[0]}-01-01` : null;
}

function isGenericNode(name) {
  const text = String(name || "").trim();
  if (!text) return false;
  if (GENERIC_ACTIVITY.test(text) || MONEY_WORD.test(text)) return true;
  return /\b(tin|chassis|application)\b/i.test(text);
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

function sideName(side) {
  if (!side) return "";
  if (typeof side === "string") return side.trim();
  return String(side.name || "").trim();
}

function sideCopy(side) {
  if (!side || typeof side !== "object") return { name: sideName(side), type: "other" };
  return { ...side, name: sideName(side) };
}

function namedSide(value, type) {
  const name = String(value || "").trim();
  return name ? { name, type } : null;
}

function clip(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 180) : "this document";
}
