import { isIsoDate, mentionsDate } from "./dates.js";
import { normalizeName } from "./entityResolver.js";
import { notPersonReason, selfMatchKind } from "./graphQuality.js";
import { genderOf, kinOf, SELF_PRONOUNS, THIRD_PERSON } from "./kinship.js";

// PEOPLE_ENGINE=tools extraction: the model returns typed people, relations and dates against a JSON schema. Code
// checks invariants only; every name, date and evidence quote must appear in the source text as written. Working
// out who "she", "we" or "Ana's husband" is belongs to the model, and is judged by its verbatim evidence.
export const RELATIONS = [
  "parent", "child", "sibling", "half_sibling", "step_parent", "step_child", "step_sibling",
  "spouse", "former_spouse", "partner", "grandparent", "grandchild", "aunt_uncle", "niece_nephew", "cousin",
  "parent_in_law", "child_in_law", "sibling_in_law", "godparent", "godchild", "friend", "neighbour", "colleague", "other_relative",
];

// relation → [group, female word, male word, neutral word]. The group decides the edge; the word is the role shown.
const ROLE = {
  parent: ["parent", "mother", "father", "parent"],
  child: ["child", "daughter", "son", "child"],
  sibling: ["sibling", "sister", "brother", "sibling"],
  half_sibling: ["sibling", "half-sister", "half-brother", "half-sibling"],
  step_parent: ["relative", "stepmother", "stepfather", "step-parent"],
  step_child: ["relative", "stepdaughter", "stepson", "stepchild"],
  step_sibling: ["relative", "stepsister", "stepbrother", "step-sibling"],
  spouse: ["spouse", "wife", "husband", "spouse"],
  former_spouse: ["spouse", "wife", "husband", "spouse"],
  partner: ["spouse", "partner", "partner", "partner"],
  grandparent: ["grandparent", "grandmother", "grandfather", "grandparent"],
  grandchild: ["grandchild", "granddaughter", "grandson", "grandchild"],
  aunt_uncle: ["relative", "aunt", "uncle", "aunt or uncle"],
  niece_nephew: ["relative", "niece", "nephew", "niece or nephew"],
  cousin: ["relative", "cousin", "cousin", "cousin"],
  parent_in_law: ["relative", "mother-in-law", "father-in-law", "parent-in-law"],
  child_in_law: ["relative", "daughter-in-law", "son-in-law", "child-in-law"],
  sibling_in_law: ["relative", "sister-in-law", "brother-in-law", "sibling-in-law"],
  godparent: ["social", "godmother", "godfather", "godparent"],
  godchild: ["social", "goddaughter", "godson", "godchild"],
  friend: ["social", "friend", "friend", "friend"],
  neighbour: ["social", "neighbour", "neighbour", "neighbour"],
  colleague: ["social", "colleague", "colleague", "colleague"],
  other_relative: ["relative", "relative", "relative", "relative"],
};

export function roleWord(relation, gender) {
  const row = ROLE[relation];
  if (!row) return null;
  return gender === "female" ? row[1] : gender === "male" ? row[2] : row[3];
}

export function roleGroup(relation) {
  return ROLE[relation]?.[0] || null;
}

const text = (description) => ({ type: "string", description });
export const PEOPLE_SCHEMA = {
  name: "people_facts",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["people", "relations", "dates", "places"],
    properties: {
      people: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["name", "gender"], properties: { name: text("full name as written"), gender: { type: "string", enum: ["female", "male", "unknown"] } } },
      },
      relations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["person", "relation", "of", "evidence"],
          properties: { person: text("name"), relation: { type: "string", enum: RELATIONS }, of: text('"narrator" or another person\'s name'), evidence: text("exact quote from the text") },
        },
      },
      dates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["person", "kind", "date", "as_written", "with", "evidence"],
          properties: {
            person: text("name, or \"narrator\""),
            kind: { type: "string", enum: ["birth", "death", "marriage", "divorce"] },
            date: text("YYYY-MM-DD, or YYYY when only the year is written"),
            as_written: text("the date exactly as it appears in the text"),
            with: text('for marriage/divorce: "narrator" or the other spouse\'s name; otherwise ""'),
            evidence: text("exact quote from the text"),
          },
        },
      },
      places: {
        type: "array",
        items: { type: "object", additionalProperties: false, required: ["person", "place", "evidence"], properties: { person: text("name"), place: text("town, city, region or country as written"), evidence: text("exact quote from the text") } },
      },
    },
  },
};

export const PEOPLE_SCHEMA_PROMPT = `Extract the people in the text and what it states about them, for the narrator's family records.
- people: everyone named or referred to who is not the narrator; gender only if the text states it (a word like mother, son, she) — never from the name.
- relations: "person is <relation> of <of>". of is "narrator" for the narrator (I, me, my, we, our, mimi, yangu, or "you/your" in a note addressed to the narrator), otherwise another person's name. former_spouse for an ended marriage.
- dates: births, deaths, marriages and divorces actually stated. as_written is the date copied exactly from the text.
- places: where a person lives now.
- evidence: an exact, contiguous quote from the text that states the fact.
Work out who "she", "he", "they", "we", "our" and "X's wife" refer to; when the text names someone only by role, use their name from the known people. Use names exactly as written. State nothing the text does not say. Any language.
Example — text: "Elena, my mother, still lives in Cusco. She married my stepfather Bruno on 2 May 1998." →
people: Elena (female), Bruno (male); relations: Elena parent of narrator ("Elena, my mother"), Bruno step_parent of narrator ("my stepfather Bruno"), Bruno spouse of Elena ("She married my stepfather Bruno"); dates: marriage of Bruno with Elena, 1998-05-02, as_written "2 May 1998"; places: Elena, Cusco.`;

const SELF_WORDS = new Set(["narrator", "self", "the narrator", "the user", "the speaker", "the individual", "you"]);

function contains(source, quote) {
  const flat = (value) => String(value || "").normalize("NFC").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  const needle = flat(quote);
  return needle.length > 0 && flat(source).includes(needle);
}

// Invariants only. Returns kept facts and every drop with its reason.
export function validateSchemaFacts(raw, { text: source = "", selfName = "", selfAliases = [], known = [] } = {}) {
  const dropped = [];
  const drop = (reason, item) => dropped.push({ reason, item });
  const aliases = [selfName, ...selfAliases].filter(Boolean);
  const isNarrator = (name) => SELF_WORDS.has(normalizeName(name)) || SELF_PRONOUNS.has(normalizeName(name)) || selfMatchKind(name, aliases) != null;
  const knownBy = (name) => (known || []).find((item) => normalizeName(item.name) === normalizeName(name)) || null;
  // A fact's evidence must name the person. The one exception is a person already known, whom the model may
  // recognise by role or pronoun ("we got married", "my late dad"); its evidence still has to be in the text.
  const nameOk = (name, evidence) => (contains(source, name) && contains(evidence, name)) || (knownBy(name) && contains(source, evidence));
  // The other side of a relation ("his wife", "Ana's son") may be referred to; it must be written in the text or known.
  const otherOk = (name) => contains(source, name) || Boolean(knownBy(name));
  const personProblem = (name) => {
    const key = normalizeName(name);
    if (!key) return "no-name";
    if (THIRD_PERSON.has(key)) return "pronoun";
    if (kinOf(key)) return "kinship-word";
    return notPersonReason(name);
  };

  const genders = new Map();
  for (const person of Array.isArray(raw?.people) ? raw.people : []) {
    if (person?.name && ["female", "male"].includes(person.gender)) genders.set(normalizeName(person.name), person.gender);
  }

  const relations = [];
  for (const item of Array.isArray(raw?.relations) ? raw.relations : []) {
    const person = String(item?.person || "").trim();
    const of = String(item?.of || "").trim();
    if (!ROLE[item?.relation]) { drop("unknown-relation", item); continue; }
    if (!contains(source, item?.evidence)) { drop("evidence-not-in-text", item); continue; }
    if (isNarrator(person)) { drop("narrator-as-person", item); continue; }
    const problem = personProblem(person);
    if (problem) { drop(problem, item); continue; }
    if (!nameOk(person, item.evidence)) { drop("name-not-in-text", item); continue; }
    const ofNarrator = !of || isNarrator(of);
    if (!ofNarrator && (personProblem(of) || !otherOk(of))) { drop("other-not-in-text", item); continue; }
    if (!ofNarrator && normalizeName(of) === normalizeName(person)) { drop("self-loop", item); continue; }
    const stated = genders.get(normalizeName(person)) || null;
    const recorded = genderOf(knownBy(person)?.kind);
    if (stated && recorded && stated !== recorded) { drop("gender-mismatch", item); continue; }
    relations.push({ person, relation: item.relation, of: ofNarrator ? "narrator" : of, gender: stated || recorded || null, evidence: item.evidence });
  }

  const dates = [];
  for (const item of Array.isArray(raw?.dates) ? raw.dates : []) {
    const person = String(item?.person || "").trim();
    const value = String(item?.date || "").trim();
    if (!contains(source, item?.evidence)) { drop("evidence-not-in-text", item); continue; }
    if (!contains(source, item?.as_written)) { drop("date-not-in-text", item); continue; }
    const full = isIsoDate(value);
    const year = /^\d{4}$/.test(value);
    if (!full && !year) { drop("bad-date", item); continue; }
    // The ISO date must be what the written date says.
    if (full ? !mentionsDate(item.as_written, value) : !String(item.as_written).includes(value)) { drop("date-mismatch", item); continue; }
    if (year && item.kind !== "divorce") { drop("year-only", item); continue; }
    const narrator = isNarrator(person);
    if (!narrator && (personProblem(person) || !nameOk(person, item.evidence))) { drop("name-not-in-text", item); continue; }
    const withName = String(item?.with || "").trim();
    const withNarrator = !withName || isNarrator(withName);
    if (["marriage", "divorce"].includes(item.kind) && !withNarrator && !otherOk(withName)) { drop("other-not-in-text", item); continue; }
    dates.push({ person: narrator ? "narrator" : person, kind: item.kind, date: value, with: withNarrator ? "narrator" : withName, evidence: item.evidence });
  }
  // One birth date (and one death date) per person: two different ones keep neither.
  for (const kind of ["birth", "death"]) {
    const byPerson = new Map();
    for (const item of dates.filter((entry) => entry.kind === kind)) byPerson.set(normalizeName(item.person), [...(byPerson.get(normalizeName(item.person)) || []), item]);
    for (const [, items] of byPerson) {
      if (new Set(items.map((entry) => entry.date)).size > 1) for (const item of items) { drop(`conflicting-${kind}`, item); dates.splice(dates.indexOf(item), 1); }
    }
  }
  for (const death of dates.filter((entry) => entry.kind === "death")) {
    const birth = dates.find((entry) => entry.kind === "birth" && normalizeName(entry.person) === normalizeName(death.person));
    if (birth && death.date < birth.date) { drop("death-before-birth", death); dates.splice(dates.indexOf(death), 1); }
  }

  const places = [];
  for (const item of Array.isArray(raw?.places) ? raw.places : []) {
    const person = String(item?.person || "").trim();
    if (!contains(source, item?.evidence) || !contains(source, item?.place)) { drop("place-not-in-text", item); continue; }
    if (isNarrator(person) || personProblem(person) || !nameOk(person, item.evidence)) { drop("name-not-in-text", item); continue; }
    places.push({ person, place: String(item.place).trim(), evidence: item.evidence });
  }
  return { relations, dates, places, dropped };
}

const EDGE = { parent: ["parent_of", "up"], child: ["parent_of", "down"], sibling: ["sibling_of", "side"], spouse: ["spouse_of", "side"], grandparent: ["grandparent_of", "up"], grandchild: ["grandparent_of", "down"], relative: ["relative_of", "side"], social: ["knows", "side"] };
const NARRATOR_SIDE = { name: "me", type: "self" };

// Checked facts → entity facts and triples for the shared commit path. validated marks them as already judged by
// evidence, so the commit's wording checks (which belong to the rules engine) do not run on them.
export function schemaFactsToGraph({ relations, dates, places }, selfName) {
  const side = (name) => (name === "narrator" ? NARRATOR_SIDE : { name, type: "person" });
  const triples = [];
  const facts = new Map();
  const fact = (name) => {
    const key = name === "narrator" ? selfName : name;
    if (!facts.has(key)) facts.set(key, { name: key, birthDate: null, deathDate: null, kind: null, birthOrder: null });
    return facts.get(key);
  };
  for (const item of relations) {
    const [predicate, direction] = EDGE[roleGroup(item.relation)];
    const person = { ...side(item.person), kind: item.of === "narrator" ? roleWord(item.relation, item.gender) : null };
    const other = side(item.of);
    const [subject, object] = direction === "down" ? [other, person] : [person, other];
    const role = roleWord(item.relation, item.gender);
    triples.push({
      subject, predicate, object, validFrom: null, validTo: null, confidence: 0.9, evidence: item.evidence, validated: true,
      attributes: { ...(["relative", "social"].includes(roleGroup(item.relation)) ? { kind: role } : {}), ...(item.relation === "former_spouse" ? { ended: true } : {}) },
    });
    if (item.of === "narrator") fact(item.person).kind = role;
  }
  for (const item of dates) {
    if (item.kind === "birth") fact(item.person).birthDate = item.date;
    else if (item.kind === "death") fact(item.person).deathDate = item.date;
    else {
      // A marriage or divorce date is about the spouse edge between the two people.
      const divorce = item.kind === "divorce";
      triples.push({
        subject: side(item.person), predicate: "spouse_of", object: side(item.with), confidence: 0.9, evidence: item.evidence, validated: true,
        validFrom: divorce ? null : item.date,
        validTo: divorce ? (item.date.length === 4 ? `${item.date}-01-01` : item.date) : null,
        attributes: divorce ? { ended: true, ...(item.date.length === 4 ? { endPrecision: "year" } : {}) } : {},
      });
    }
  }
  for (const item of places) {
    triples.push({ subject: side(item.person), predicate: "lives_at", object: { name: item.place, type: "place" }, validFrom: null, validTo: null, attributes: {}, confidence: 0.85, evidence: item.evidence, validated: true });
  }
  return { triples, entityFacts: [...facts.values()] };
}
