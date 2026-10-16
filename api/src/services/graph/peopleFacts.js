import { isIsoDate, mentionsDate } from "./dates.js";
import { normalizeName } from "./entityResolver.js";
import { notPersonReason, selfMatchKind } from "./graphQuality.js";
import { genderOf, SELF_PRONOUNS, THIRD_PERSON } from "./kinship.js";

// Structured people extraction at save time. Every event, message and journal entry goes through this once; answers
// then read the stored facts. The prompt's examples use invented people so no real record is ever in the prompt.
export const PEOPLE_EXTRACT_PROMPT = `List every person the text mentions and only what it states about them.
Return JSON only:
{ "people": [{ "name": "", "relation": null, "relationOf": "narrator", "gender": "unknown", "birthDate": null, "deathDate": null, "marriageDate": null, "livesIn": null, "notChildOf": [], "evidence": "" }] }
Fields:
- name: the person's name exactly as written, every word of it. A family name written once after a list of given names ("my brothers Diego, Mateo and Lucas Quispe") belongs to each of them. Never a pronoun, a kinship word, an amount, a date, or the narrator.
- relation: what this person is to relationOf: father, mother, parent, brother, sister, sibling, husband, wife, spouse, son, daughter, child. null when the text does not state it. A shared family name is not a relation.
- relationOf: "narrator" when the text says my/our/I have/we have (or mimi/yangu/wangu); otherwise the name of the other person ("Ana's son" → "Ana").
- gender: female or male only when a kinship word or the text says so; never from the name. Otherwise unknown.
- birthDate, deathDate, marriageDate: YYYY-MM-DD only when the full date is stated for this person; otherwise null. marriageDate is when this person married relationOf.
- livesIn: the town, city, region or country where this person lives now ("Cusco", not "our house in Cusco"); otherwise null.
- notChildOf: names the text says this person is not the child of.
- evidence: the shortest exact quote that states these facts.
Resolve she, he and they to the person they refer to. The narrator ("I", "me", "my") is never listed; facts about the narrator go on an entry with name "narrator".
Work in English or Swahili. At most 30 people.
Example text: "My father Rafael Quispe died on 2 March 1999; my mother Elena lives in Cusco. Diego Quispe is my brother. Ana is Diego's wife, and their son Tomás was born on 8 July 2015."
Example output: { "people": [
 { "name": "Rafael Quispe", "relation": "father", "relationOf": "narrator", "gender": "male", "deathDate": "1999-03-02", "evidence": "My father Rafael Quispe died on 2 March 1999" },
 { "name": "Elena", "relation": "mother", "relationOf": "narrator", "gender": "female", "livesIn": "Cusco", "evidence": "my mother Elena lives in Cusco" },
 { "name": "Diego Quispe", "relation": "brother", "relationOf": "narrator", "gender": "male", "evidence": "Diego Quispe is my brother" },
 { "name": "Ana", "relation": "wife", "relationOf": "Diego Quispe", "gender": "female", "evidence": "Ana is Diego's wife" },
 { "name": "Tomás", "relation": "son", "relationOf": "Diego Quispe", "gender": "male", "birthDate": "2015-07-08", "evidence": "their son Tomás was born on 8 July 2015" } ] }`;

const RELATIONS = new Set(["father", "mother", "parent", "brother", "sister", "sibling", "husband", "wife", "spouse", "son", "daughter", "child"]);
const FIRST_PERSON = /\b(i|me|my|our|we|us|mimi|yangu|wangu|tuna|nina)\b/i;
// Paraphrases and documents name the narrator by role; any of these is the narrator, never another person.
const NARRATOR = new Set(["narrator", "self", "the narrator", "the individual", "individual", "the user", "user", "the speaker", "speaker", "the author", "author"]);

// The general invariants every extracted person must satisfy before anything is saved. Pure, so tests can feed it
// any model output: a fact survives only if the text supports it.
export function validatePeople(raw, { text = "", selfName = "", selfAliases = [], knownGender = () => null } = {}) {
  const kept = [];
  const dropped = [];
  const source = ` ${normalizeName(text)} `;
  const isNarrator = (name) => NARRATOR.has(normalizeName(name)) || SELF_PRONOUNS.has(normalizeName(name)) || selfMatchKind(name, [selfName, ...selfAliases].filter(Boolean)) != null;
  for (const item of Array.isArray(raw) ? raw.slice(0, 30) : []) {
    const name = String(item?.name || "").replace(/\s+/g, " ").trim();
    const drop = (reason) => dropped.push({ name, reason });
    if (!name) { drop("no-name"); continue; }
    const key = normalizeName(name);
    if (THIRD_PERSON.has(key)) { drop("pronoun"); continue; }
    if (RELATIONS.has(key) || genderOf(key)) { drop("kinship-word"); continue; }
    const notPerson = notPersonReason(name);
    if (notPerson) { drop(notPerson); continue; }
    const narrator = isNarrator(name);
    // Every word of the name must be in the text; the model may not invent or complete a name.
    if (!narrator && !key.split(" ").every((word) => source.includes(` ${word} `))) { drop("name-not-in-text"); continue; }

    const person = { name: narrator ? "narrator" : name, isNarrator: narrator, relation: null, relationOf: null, gender: null, birthDate: null, deathDate: null, marriageDate: null, livesIn: null, notChildOf: [], evidence: String(item?.evidence || "").slice(0, 300) };
    for (const field of ["birthDate", "deathDate", "marriageDate"]) {
      const value = String(item?.[field] || "").trim();
      // A date counts only if the text states it; a year alone or a computed date is not a stated date.
      if (value && isIsoDate(value) && mentionsDate(text, value)) person[field] = value;
      else if (value) dropped.push({ name, reason: `${field}-not-in-text`, value });
    }
    if (person.birthDate && person.deathDate && person.deathDate < person.birthDate) {
      dropped.push({ name, reason: "death-before-birth" });
      person.deathDate = null;
    }

    const relation = String(item?.relation || "").toLowerCase().trim();
    const relationOf = String(item?.relationOf || "").trim();
    const notChildOf = (Array.isArray(item?.notChildOf) ? item.notChildOf : []).map(String);
    if (relation && RELATIONS.has(relation) && !narrator) {
      const ofNarrator = !relationOf || isNarrator(relationOf);
      // Possessive → narrator: a relation to the narrator needs a first-person word where the text states it.
      if (ofNarrator && !FIRST_PERSON.test(person.evidence) && !sentencesNaming(text, name).some((sentence) => FIRST_PERSON.test(sentence))) {
        dropped.push({ name, reason: "relation-without-narrator-possessive", relation });
      } else if (!ofNarrator && !source.includes(` ${normalizeName(relationOf).split(" ")[0]} `)) {
        dropped.push({ name, reason: "relation-of-unknown-person", relation });
      } else if (PREDICATE[relation][1] === "down" && notChildOf.some((other) => !ofNarrator && normalizeName(other) === normalizeName(relationOf))) {
        dropped.push({ name, reason: "contradicts-not-child-of", relation });
      } else {
        // Gender-consistent kinship: the kinship word, the stated gender and what the graph knows must agree.
        const implied = genderOf(relation);
        const stated = ["female", "male"].includes(String(item?.gender)) ? item.gender : null;
        const known = knownGender(name);
        const clash = [stated, known].find((value) => value && implied && value !== implied);
        if (clash) {
          dropped.push({ name, reason: "gender-mismatch", relation, gender: clash });
        } else {
          person.relation = relation;
          person.relationOf = ofNarrator ? "narrator" : relationOf;
          person.gender = implied || stated || known || null;
        }
      }
    } else if (["female", "male"].includes(String(item?.gender))) {
      person.gender = item.gender;
    }
    if (typeof item?.livesIn === "string" && item.livesIn.trim()) {
      const place = item.livesIn.trim();
      if (normalizeName(place).split(" ").every((word) => source.includes(` ${word} `))) person.livesIn = place;
      else dropped.push({ name, reason: "place-not-in-text", value: place });
    }
    person.notChildOf = notChildOf.filter((other) => source.includes(` ${normalizeName(other).split(" ")[0]} `));
    kept.push(person);
  }
  return { people: mergeSamePerson(kept, dropped), dropped };
}

// The sentences of the text that contain the person's given name.
function sentencesNaming(text, name) {
  const first = normalizeName(name).split(" ")[0];
  return String(text || "").split(/(?<=[.!?;])\s+/).filter((sentence) => ` ${normalizeName(sentence)} `.includes(` ${first} `));
}

// One birth date per person: the same person twice with different dates keeps neither and says so.
function mergeSamePerson(people, dropped) {
  const out = [];
  for (const person of people) {
    const same = out.find((item) => normalizeName(item.name) === normalizeName(person.name));
    if (!same) {
      out.push(person);
      continue;
    }
    for (const field of ["birthDate", "deathDate", "marriageDate"]) {
      if (same[field] && person[field] && same[field] !== person[field]) {
        dropped.push({ name: person.name, reason: `conflicting-${field}`, value: [same[field], person[field]] });
        same[field] = null;
        same[`${field}Conflict`] = true;
      } else if (!same[`${field}Conflict`]) {
        same[field] = same[field] || person[field];
      }
    }
    if (!same.relation && person.relation) Object.assign(same, { relation: person.relation, relationOf: person.relationOf, gender: person.gender });
    same.livesIn = same.livesIn || person.livesIn;
    same.notChildOf = [...new Set([...same.notChildOf, ...person.notChildOf])];
    same.evidence = [same.evidence, person.evidence].filter(Boolean).join(" … ").slice(0, 300);
  }
  return out;
}

const NARRATOR_SIDE = { name: "me", type: "self" };
const PREDICATE = {
  father: ["parent_of", "up"], mother: ["parent_of", "up"], parent: ["parent_of", "up"],
  son: ["parent_of", "down"], daughter: ["parent_of", "down"], child: ["parent_of", "down"],
  brother: ["sibling_of", "side"], sister: ["sibling_of", "side"], sibling: ["sibling_of", "side"],
  husband: ["spouse_of", "side"], wife: ["spouse_of", "side"], spouse: ["spouse_of", "side"],
};

// Validated people become entity facts (dates, role) and family triples for the usual commit path.
export function peopleToGraph(people) {
  const triples = [];
  const entityFacts = [];
  for (const person of people) {
    const side = person.isNarrator ? NARRATOR_SIDE : { name: person.name, type: "person", kind: person.relationOf === "narrator" ? person.relation : null };
    if (!person.isNarrator) {
      entityFacts.push({
        name: person.name,
        birthDate: person.birthDate,
        deathDate: person.deathDate,
        kind: person.relationOf === "narrator" ? person.relation : null,
        birthOrder: null,
      });
    }
    if (person.relation) {
      const [predicate, direction] = PREDICATE[person.relation];
      const other = person.relationOf === "narrator" ? NARRATOR_SIDE : { name: person.relationOf, type: "person" };
      const [subject, object] = direction === "down" ? [other, side] : [side, other];
      triples.push({
        subject,
        predicate,
        object,
        validFrom: predicate === "spouse_of" ? person.marriageDate : null,
        validTo: null,
        attributes: {},
        confidence: 0.9,
        evidence: person.evidence,
      });
    }
    if (person.livesIn && !person.isNarrator) {
      triples.push({ subject: side, predicate: "lives_at", object: { name: person.livesIn, type: "place" }, validFrom: null, validTo: null, attributes: {}, confidence: 0.85, evidence: person.evidence });
    }
  }
  return { triples, entityFacts, narrator: people.find((person) => person.isNarrator) || null };
}
