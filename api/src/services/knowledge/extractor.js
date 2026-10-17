// The claims extractor: one structured model call that turns a saved text into claims in the core vocabulary
// (docs/knowledge-layer.md), with what the user's records already hold as context so "the plot" or "my brother's
// wife" can be tied to known entities. Only stated facts; everything derived is computed later in code.
import { prisma } from "../../prisma.js";
import { getOrCreateSelf } from "../graph/entityResolver.js";
import { jsonCall } from "./model.js";
import { extractModel } from "./settings.js";
import { validateClaims } from "./validate.js";
import { ENTITY_TYPES, PREDICATES } from "./vocabulary.js";

export const EXTRACTOR_VERSION = "claims-v5";

// What each predicate means and its direction, for the prompt. Kept beside the vocabulary's domain table.
const MEANING = {
  parent_of: "subject is the PARENT, object the child (\"my son Kai\" → me parent_of Kai; \"Lena, my mother\" → Lena parent_of me); label step/adoptive/foster when said",
  spouse_of: "married or partners; date = wedding, until = divorce/separation/death of the marriage; label partner/fiancé(e)/ex when said",
  sibling_of: "brother/sister; label half or step when said",
  relative_of: "any other kin word whose chain is not stated (grandmother, uncle, cousin, sister-in-law, godmother…); label = the word used",
  friend_of: "friends",
  neighbour_of: "neighbours",
  knows: "any other acquaintance; label = how",
  works_at: "employed at an organisation; label = job title; date = start, until = left",
  colleague_of: "work colleagues",
  manages: "subject is the boss/supervisor of object",
  client_of: "subject is the client, object the business serving them; prefer has_client",
  has_client: "subject is the business, object its client or customer (\"Shop Z supplies Hotel X, our biggest client\" → Shop Z has_client Hotel X)",
  contractor_for: "subject (person or company) does paid work for object (person, organisation or project); label = trade",
  business_partner_of: "business partners",
  founded: "subject founded/started the organisation; date",
  director_of: "director, CEO, chair, board member; label = role",
  owns_share_of: "value = percentage owned of the organisation",
  member_of: "member of a group, association, church, savings group, club; date = since",
  studied_at: "studied at; label = course/degree; until = graduated",
  owns: "subject owns object (property, vehicle, asset, document) when ownership is stated without a purchase (inherited, a gift, \"I have\", \"our house\", someone renting it out); date = acquired, until = disposed; label inherited/gift/co-owned",
  rents: "subject rents the property; date = since, until = moved out",
  bought: "subject bought object; amount, date; context = the seller",
  sold: "subject (the seller) sold object (the thing); amount, date; context = the buyer",
  located_in: "object is the place where the subject is",
  identifier: "value = a number or code of the subject (plot number, registration, title number, policy number); label = what kind",
  expires_on: "value = ISO date the subject (document, policy, licence) expires",
  renews_on: "value = ISO date the subject is due for renewal",
  valued_at: "amount = what the subject is worth; date",
  issued_by: "the organisation that issued/insures the document or policy",
  paid: "subject paid money to object; amount, currency, date; context = what it was for (project, asset, person)",
  received_from: "subject received money from object; amount, date; context",
  contributed_to: "subject put money into object (project, group, person); amount, date; label monthly etc.",
  owes: "subject is the DEBTOR, object the lender (\"I lent Kai 50\" → Kai owes me 50; \"my loan from Lender Y\" → me owes Lender Y); amount; date = since; until = repaid",
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

// Predicates the model may use in their natural direction, turned into the stored one: "Shop Z has_client Hotel X"
// is stored as "Hotel X client_of Shop Z" (models reliably reverse client_of when asked for it directly).
const EXTRACTION_ALIASES = { has_client: "client_of" };
// A mention's place becomes its own located_in claim (once per thing and place), with the same evidence.
export function withPlaces(claims) {
  const out = [];
  const seen = new Set();
  for (const claim of claims) {
    out.push(claim);
    for (const entity of [claim.subject, claim.object, claim.context]) {
      if (!entity || entity === "me" || entity.type === "person" || entity.type === "place" || !String(entity.place || "").trim()) continue;
      const key = `${entity.name}|${entity.place}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ subject: { name: entity.name, type: entity.type }, predicate: "located_in", object: { name: entity.place.trim(), type: "place" }, value: null, label: null, amount: null, currency: null, context: null, date: null, until: null, evidence: claim.evidence, corrects: false });
    }
  }
  return out;
}

export function fromAlias(claim) {
  const stored = EXTRACTION_ALIASES[claim.predicate];
  return stored ? { ...claim, predicate: stored, subject: claim.object, object: claim.subject } : claim;
}

const mention = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["name", "type", "place"],
  properties: {
    name: { type: "string" },
    type: { type: "string", enum: [...ENTITY_TYPES, "self"] },
    // Where a thing is, when the text says ("the farm in X" → "X"); code turns it into a located_in claim.
    place: { type: ["string", "null"] },
  },
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
          predicate: { type: "string", enum: [...Object.keys(PREDICATES), ...Object.keys(EXTRACTION_ALIASES)] },
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
- subject, object, context: entities as { name, type, place }. The narrator is { "name": "me", "type": "self", "place": null }. place is where a thing (property, vehicle, organisation, project, asset, event) is when the text says so, also when the place is part of how it is called ("the farm in X", "our house near Y", "the Z outlet" → the town); null for people and when unknown. Use the fullest name the text or the known records give (a known name when it is the same person or thing). A thing without a proper name gets a short name built from the text, e.g. "lake plot", "boat licence", "tuition fees", "eye test appointment".
- predicate: one of the predicates below, in the direction given.
- value: for value predicates (dates, identifiers, statuses, plans, percentages); otherwise null.
- label, amount (a number in major units, no separators), currency (ISO 4217 code), date, until: when stated, else null.
- Dates are ISO and never more precise than the text: "in 2019" → "2019", "May 2019" → "2019-05", "3 May 2019" → "2019-05-03". Resolve relative dates against today's date at the precision the words carry: "yesterday" → a day, "last week" / "this September" / "next month" → a month, "next year" → a year.
- evidence: the shortest exact quote from the text that states the fact.
- corrects: true when the text corrects an earlier statement ("actually", "correction", "I meant"); the claim uses the same subject, predicate and object as the claim it corrects and carries the corrected value.
- date is when the fact happened or starts, only if the text gives it. Never use today's date unless the text says "today"; a target or deadline inside a plan belongs in the plan's value or date only when stated.

Predicates:
${[...Object.keys(PREDICATES), ...Object.keys(EXTRACTION_ALIASES)].map((name) => `- ${name}: ${MEANING[name]}`).join("\n")}

Rules:
- Only facts the text states. Never add what follows from other facts: no child/grandchild/in-law claims worked out from chains, no sums, no ages, and never compute a date or amount from an age, a duration or other numbers (only relative dates are resolved, see above).
- Every person the text names with a role gets that role claim, even when the same sentence says more about them.
- "X's <role> Y" is a claim between Y and X in the role's direction: "Arni's sister Sola" → Sola sibling_of Arni; "Arni's son Bo" → Arni parent_of Bo.
- Kin and role words in any language count like the English ones.
- Before naming anything, look in Known records: if it is the same person or thing, or a task or part of a known project, use the known name exactly.
- Names are short (one to four words), the way the user would say them: "lake house", "garage build", "boat licence".
- Names: call a thing what the user calls it ("the lake plot", "the garage build"). Numbers and codes (plot numbers, registrations, title or policy numbers) never go into a name; they are identifier claims.
- Project state: work going on now → status active; decided or planned but not started → status planned; finished → done. A target finish date ("hope to finish by June") is due_on.
- A project is one entity for the whole undertaking (a build, a renovation, a launch). Trades, tasks, quotes, payments and milestones attach to that project (contractor_for, costs, paid with context, milestone); never make an entity per task.
- Documents, policies, licences and certificates are their own entities (type document), e.g. "car insurance policy"; their issuer, number and expiry are claims about the document. "The boat is insured with Z; the policy expires D" → "boat insurance policy" issued_by Z and expires_on D, and nothing about the boat itself.
- Where a thing is goes in its mention's place (no separate located_in needed); where a person lives is a lives_in claim. An organisation's town is not an employer: works_at needs an organisation.
- Plans and decisions: value is the whole intention or decision in a few words ("move the family to the countryside"), never one word. "We agreed/decided" → decided; "I plan/will/want to" → plans or intends.
- Ended employment: "after N years at X" or "I left X" → works_at X with until.
- A kin word ties people only as the text says: "Arni's wife Sola" is spouse_of between Sola and Arni, not a claim about the narrator. "My sister-in-law Sola" with no chain is relative_of Sola → me, label "sister-in-law".
- "Our children" names both parents when the other parent is known from the text or records.
- When the text says a state ended (sold, moved, left a job, divorced, repaid, quit), give the ended claim with until, plus the new state.
- Money: every payment, contribution, debt, income, price, budget and quote is its own claim with amount and currency; context says what it was for.
- Ignore questions in the text; extract only what it tells.
- Text in any language: claims are in English, names and quotes as written.
- If a fact fits no predicate, use related_to with a label in the user's words. Never drop a stated fact.
- Something done or decided together ("Ana and I decided", "we bought") → one claim with subject me; name the others in a separate claim only when the text gives them their own part.
- No facts → an empty list.

Before answering, check the text once more: every named person has their role claim; every thing described with a place ("the flat in X", "our farm near Y") has that place in its mention; every amount is in a claim; every date is in a claim; every ended state has until; every contractor or company working on something has contractor_for; every plan or decision is there.`;

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
  const raw = withPlaces((json.claims || []).map(fromAlias).map((claim) => ({ ...claim, subject: claim.subject?.type === "self" ? "me" : claim.subject, object: claim.object?.type === "self" ? "me" : claim.object, context: claim.context?.type === "self" ? "me" : claim.context })));
  const { kept, dropped } = validateClaims(raw, text, { known: entities.map((entity) => [entity.name, ...(entity.aliases || [])]).flat(), selfName: self.name, today });
  return { claims: kept, dropped, raw, usage, extractor: EXTRACTOR_VERSION, model };
}
