// One resolver for every entity type: a mention ({ name, type } or "me") becomes an entity id. Exact name or alias
// first, then a unique partial match ("Ada" ↔ "Ada Lindqvist"; "the Oslo house" ↔ "Oslo house"); several
// partial matches create a new entity with merge candidates instead of guessing. Nothing is merged silently.
import { prisma } from "../../prisma.js";
import { getOrCreateSelf, normalizeName } from "../graph/entityResolver.js";
import { ENTITY_TYPES } from "./vocabulary.js";

const FILLER = new Set(["the", "a", "an", "my", "our", "his", "her", "their", "of", "in", "at", "on", "for", "s"]);
const SELF_WORDS = new Set(["me", "i", "myself", "mimi", "narrator", "self"]);

export const words = (name) => normalizeName(name).split(" ").filter((word) => word && !FILLER.has(word));

const typeOf = (type) => (ENTITY_TYPES.includes(type) ? type : null);
// Types that can be confused for one another without the text being wrong: a plot is a place and a property.
const compatible = (a, b) => !a || !b || a === b || (["place", "property"].includes(a) && ["place", "property"].includes(b));

function names(entity) {
  return [entity.name, ...(entity.aliases || [])].map((name) => words(name)).filter((list) => list.length);
}

// How a mention fits an entity: "exact", "partial" (one word list inside the other; people must share the first
// word, since a surname alone is not a person), or null.
export function fit(mention, entity) {
  const want = words(mention.name);
  if (!want.length || !compatible(typeOf(mention.type), entity.entityType)) return null;
  let partial = false;
  // A partial match needs the same type: "Oslo" the place is not "Oslo plot" the property.
  const sameType = !mention.type || !typeOf(mention.type) || mention.type === entity.entityType || entity.entityType === "other";
  for (const have of names(entity)) {
    if (have.join(" ") === want.join(" ")) return "exact";
    if (!sameType) continue;
    const [short, long] = want.length <= have.length ? [want, have] : [have, want];
    const person = (mention.type || entity.entityType) === "person";
    if (person && short[0] !== long[0]) continue;
    if (short.every((word) => long.includes(word))) partial = true;
  }
  return partial ? "partial" : null;
}

// A resolver bound to one user and one write: it loads the user's entities once and keeps new ones in view.
export async function createResolver(userId, client = prisma) {
  const self = await getOrCreateSelf(userId);
  const entities = await client.entity.findMany({ where: { userId, status: { not: "archived" }, mergedIntoId: null, isSelf: false } });
  const selfWords = new Set(names(self).map((list) => list.join(" ")));

  async function create(mention, mergeCandidates = []) {
    const entity = await client.entity.create({
      data: {
        userId,
        name: String(mention.name).trim(),
        entityType: typeOf(mention.type) || "other",
        normalizedName: normalizeName(mention.name),
        attributes: mergeCandidates.length ? { mergeCandidates } : {},
      },
    });
    entities.push(entity);
    return entity;
  }

  // A longer name replaces a shorter one and keeps it as an alias; a different spelling becomes an alias.
  async function learn(entity, mention) {
    const said = String(mention.name).trim();
    const known = [entity.name, ...(entity.aliases || [])].some((name) => normalizeName(name) === normalizeName(said));
    if (known) return entity;
    const longer = words(said).length > words(entity.name).length;
    const data = longer
      ? { name: said, normalizedName: normalizeName(said), aliases: [...new Set([...(entity.aliases || []), entity.name])] }
      : { aliases: [...new Set([...(entity.aliases || []), said])] };
    const updated = await client.entity.update({ where: { id: entity.id }, data });
    entities.splice(entities.indexOf(entity), 1, updated);
    return updated;
  }

  async function resolve(mention) {
    if (!mention) return null;
    const name = typeof mention === "string" ? mention : mention.name;
    const said = { name, type: typeof mention === "string" ? null : mention.type };
    const flat = words(name).join(" ");
    if (!flat) return null;
    if (SELF_WORDS.has(normalizeName(name)) || selfWords.has(flat)) return self.id;
    const exact = entities.filter((entity) => fit(said, entity) === "exact");
    if (exact.length) return (exact.find((entity) => entity.entityType === said.type) || exact[0]).id;
    const partial = entities.filter((entity) => fit(said, entity) === "partial");
    if (partial.length === 1) return (await learn(partial[0], said)).id;
    return (await create(said, partial.map((entity) => entity.id))).id;
  }

  return { selfId: self.id, resolve, entities };
}
