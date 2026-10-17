// The claims extractor: one structured model call that turns a saved text into claims in the core vocabulary
// (docs/knowledge-layer.md), with what the user's records already hold as context so "the plot" or "my brother's
// wife" can be tied to known entities. Only stated facts; everything derived is computed later in code.
import { prisma } from "../../prisma.js";
import { getOrCreateSelf } from "../graph/entityResolver.js";
import { jsonCall } from "./model.js";
import { extractModel } from "./settings.js";
import { validateClaims } from "./validate.js";
import { ENTITY_TYPES, PREDICATES } from "./vocabulary.js";

export const EXTRACTOR_VERSION = "claims-v1";

// What each predicate means and its direction, for the prompt. Kept beside the vocabulary's domain table.
const MEANING = {
  parent_of: "subject is a parent of object; label step/adoptive/foster when said",
  spouse_of: "married or partners; date = wedding, until = divorce/separation/death of the marriage; label partner/fiancé(e)/ex when said",
  sibling_of: "brother/sister; label half or step when said",
  relative_of: "any other kin word whose chain is not stated (grandmother, uncle, cousin, sister-in-law, godmother…); label = the word used",
  friend_of: "friends",
  neighbour_of: "neighbours",
  knows: "any other acquaintance; label = how",
  works_at: "employed at an organisation; label = job title; date = start, until = left",
  colleague_of: "work colleagues",
  manages: "subject is the boss/supervisor of object",
  client_of: "subject is a client/customer of object",
  contractor_for: "subject (person or company) does paid work for object (person, organisation or project); label = trade",
  business_partner_of: "business partners",
  founded: "subject founded/started the organisation; date",
  director_of: "director, CEO, chair, board member; label = role",
  owns_share_of: "value = percentage owned of the organisation",
  member_of: "member of a group, association, church, savings group, club; date = since",
  studied_at: "studied at; label = course/degree; until = graduated",
  owns: "subject owns object (property, vehicle, asset, document); date = acquired, until = disposed; label inherited/gift/co-owned/bought when said",
  rents: "subject rents the property; date = since, until = moved out",
  bought: "subject bought object; amount, date; context = the seller",
  sold: "subject sold object; amount, date; context = the buyer",
  located_in: "object is the place where the subject is",
  identifier: "value = a number or code of the subject (plot number, registration, title number, policy number); label = what kind",
  expires_on: "value = ISO date the subject (document, policy, licence) expires",
  renews_on: "value = ISO date the subject is due for renewal",
  valued_at: "amount = what the subject is worth; date",
  issued_by: "the organisation that issued/insures the document or policy",
  paid: "subject paid money to object; amount, currency, date; context = what it was for (project, asset, person)",
  received_from: "subject received money from object; amount, date; context",
  contributed_to: "subject put money into object (project, group, person); amount, date; label monthly etc.",
  owes: "subject owes object money (debt, loan); amount; date = since; until = repaid",
  earns: "subject's income; object = employer or source when named; amount; label per month/per year/salary/rent",
  costs: "subject (project, asset, event) costs or is budgeted at amount; label budget/quote/total/estimate",
  status: "value = planned | active | paused | done | cancelled; date",
  works_on: "subject takes part in the project; label = role",
  part_of: "subject is part of / built on object",
  milestone: "something reached in a project; label = what happened; date",
  born: "value = ISO birth date of the subject",
  died: "value = ISO date of death",
  happened: "value = ISO date an event took place; context = place",
  visited: "subject travelled to the place; date = from, until = back",
  lives_in: "subject lives in the place; date = since, until = moved away",
  scheduled: "value = ISO date of a planned event or appointment (the subject)",
  due_on: "value = ISO deadline of the subject (payment, fees, task, project); amount when stated",
  plans: "value = what the subject plans to do, in a few words; date = target when said",
  decided: "value = what was decided, in a few words; date; context = what it is about",
  intends: "value = a wish, hope, intention or vision",
  related_to: "anything stated that fits nothing above; label = the relation in the user's words",
};

const mention = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["name", "type"],
  properties: { name: { type: "string" }, type: { type: "string", enum: [...ENTITY_TYPES, "self"] } },
};
const nullable = (type) => ({ type: [type, "null"] });

export const CLAIMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "predicate", "object", "value", "label", "amount", "currency", "context", "date", "until", "evidence", "corrects"],
        properties: {
          subject: { ...mention, type: "object" },
          predicate: { type: "string", enum: Object.keys(PREDICATES) },
          object: mention,
          value: nullable("string"),
          label: nullable("string"),
          amount: nullable("number"),
          currency: nullable("string"),
          context: mention,
          date: nullable("string"),
          until: nullable("string"),
          evidence: { type: "string" },
          corrects: { type: "boolean" },
        },
      },
    },
  },
};

export const CLAIMS_PROMPT = `You turn what a person tells their personal record keeper into claims: one claim per fact the text states.

Claim fields:
- subject, object, context: entities as { name, type }. The narrator is { "name": "me", "type": "self" }. Use the fullest name the text or the known records give (a known name when it is the same person or thing). A thing without a proper name gets a short name built from the text, e.g. "lake plot", "boat licence", "tuition fees", "eye test appointment".
- predicate: one of the predicates below, in the direction given.
- value: for value predicates (dates, identifiers, statuses, plans, percentages); otherwise null.
- label, amount (a number in major units, no separators), currency (ISO 4217 code), date, until: when stated, else null.
- Dates are ISO and never more precise than the text: "in 2019" → "2019", "May 2019" → "2019-05", "3 May 2019" → "2019-05-03". Resolve relative dates ("last month", "this September") against today's date, at the precision they imply.
- evidence: the shortest exact quote from the text that states the fact.
- corrects: true when the text corrects an earlier statement ("actually", "correction", "I meant"); the claim carries the corrected value.

Predicates:
${Object.keys(PREDICATES).map((name) => `- ${name}: ${MEANING[name]}`).join("\n")}

Rules:
- Only facts the text states. Never add what follows from other facts: no child/grandchild/in-law claims worked out from chains, no sums, no ages.
- A kin word ties people only as the text says: "Arni's wife Sola" is spouse_of between Sola and Arni, not a claim about the narrator. "My sister-in-law Sola" with no chain is relative_of Sola → me, label "sister-in-law".
- "Our children" names both parents when the other parent is known from the text or records.
- When the text says a state ended (sold, moved, left a job, divorced, repaid, quit), give the ended claim with until, plus the new state.
- Money: every payment, contribution, debt, income, price, budget and quote is its own claim with amount and currency; context says what it was for.
- Ignore questions in the text; extract only what it tells.
- Text in any language: claims are in English, names and quotes as written.
- If a fact fits no predicate, use related_to with a label in the user's words. Never drop a stated fact.
- No facts → an empty list.`;

function knownLines(self, entities, claims) {
  const name = new Map(entities.map((entity) => [entity.id, entity]));
  const roles = new Map();
  for (const claim of claims) {
    const other = claim.subjectId === self.id ? claim.objectId : claim.objectId === self.id ? claim.subjectId : null;
    if (!other || !name.has(other)) continue;
    const direction = claim.subjectId === self.id ? "me →" : "→ me";
    const role = `${claim.predicate}${claim.label ? ` (${claim.label})` : ""} ${direction}`;
    roles.set(other, [...(roles.get(other) || []), role]);
  }
  return entities
    .filter((entity) => !entity.isSelf)
    .slice(-150)
    .map((entity) => `- ${entity.name} (${entity.entityType})${entity.aliases?.length ? ` aka ${entity.aliases.join(", ")}` : ""}${roles.has(entity.id) ? `: ${roles.get(entity.id).join("; ")}` : ""}`);
}

export async function extractClaims(text, { userId, asOf = null, source = "chat" } = {}) {
  const self = await getOrCreateSelf(userId);
  const [entities, claims] = await Promise.all([
    prisma.entity.findMany({ where: { userId, status: { not: "archived" }, mergedIntoId: null }, orderBy: { createdAt: "asc" } }),
    prisma.claim.findMany({ where: { userId, status: { in: ["stated", "confirmed"] } }, select: { subjectId: true, objectId: true, predicate: true, label: true } }),
  ]);
  const known = knownLines(self, entities, claims);
  const today = (asOf ? new Date(asOf) : new Date()).toISOString().slice(0, 10);
  const user = [
    `Today: ${today}`,
    `Narrator: ${self.name}`,
    `Source: ${source}`,
    known.length ? `Known records:\n${known.join("\n")}` : "Known records: none yet",
    `Text:\n${text}`,
  ].join("\n\n");
  const model = extractModel();
  const { json, usage } = await jsonCall({ model, name: "claims", schema: CLAIMS_SCHEMA, system: CLAIMS_PROMPT, user, timeoutMs: 60000 });
  const raw = (json.claims || []).map((claim) => ({ ...claim, subject: claim.subject?.type === "self" ? "me" : claim.subject, object: claim.object?.type === "self" ? "me" : claim.object, context: claim.context?.type === "self" ? "me" : claim.context }));
  const { kept, dropped } = validateClaims(raw, text, { known: entities.map((entity) => [entity.name, ...(entity.aliases || [])]).flat(), selfName: self.name });
  return { claims: kept, dropped, raw, usage, extractor: EXTRACTOR_VERSION, model };
}
