import { isIsoDate, mentionsDate } from "./dates.js";
import { normalizeName } from "./entityResolver.js";
import { notPersonReason, selfMatchKind } from "./graphQuality.js";
import { isOrdinalKin, kinOf, normalizeKin, SELF_PRONOUNS, THIRD_PERSON } from "./kinship.js";

// Structured people extraction at save time. Every event, message and journal entry goes through this once; answers
// then read the stored facts. The prompt's examples use invented people so no real record is ever in the prompt.
export const PEOPLE_EXTRACT_PROMPT = `List every person the text mentions and only what it states about them.
Return JSON only:
{ "people": [{ "name": "", "relation": null, "relationOf": "narrator", "gender": "unknown", "birthDate": null, "deathDate": null, "marriageDate": null, "ended": false, "endDate": null, "livesIn": null, "notChildOf": [], "evidence": "" }] }
Fields:
- name: the person's name exactly as written, every word of it. A family name written once after a list of given names ("my brothers Diego, Mateo and Lucas Quispe") belongs to each of them. Never a pronoun, a kinship word, an amount, a date, or the narrator. When the text names a known person only by role ("my wife", "my late dad"), use their name from the known people.
- relation: the role word for what this person is to relationOf, as the text says it: father, mother, son, daughter, child, brother, sister, half-brother, half-sister, husband, wife, partner, grandmother, grandfather, grandson, granddaughter, uncle, aunt, cousin, nephew, niece, stepfather, stepmother, stepson, stepdaughter, brother-in-law, sister-in-law, mother-in-law, father-in-law, friend, neighbour, colleague, godfather, godmother. "firstborn", "eldest", "youngest" mean child. null when the text does not state it. A shared family name is not a relation.
- relationOf: "narrator" when the text says my/our/I have/we have/mimi/yangu/wangu (or, in a saved note addressed to the narrator, your/you); otherwise the name of the other person ("Ana's son" → "Ana").
- gender: female or male only when a kinship word or the text says so; never from the name. Otherwise unknown.
- birthDate, deathDate, marriageDate: YYYY-MM-DD only when the full date is stated for this person; otherwise null. marriageDate is when this person married relationOf.
- ended / endDate: a marriage or partnership that ended (divorced, separated, "my ex-wife"): ended true, endDate as YYYY-MM-DD or YYYY when stated.
- livesIn: the town, city, region or country where this person lives now ("Cusco", not "our house in Cusco"); otherwise null.
- notChildOf: names the text says this person is not the child of.
- evidence: the shortest exact quote that states these facts.
Resolve she, he and they to the person they refer to. The narrator ("I", "me", "my") is never listed; facts about the narrator go on an entry with name "narrator".
Work in English or Swahili. At most 30 people.
Example text: "My father Rafael Quispe died on 2 March 1999; my mother Elena lives in Cusco with my stepfather Bruno Silva. Diego Quispe is my brother. Ana is Diego's wife, and their son Tomás was born on 8 July 2015. My ex-husband Iker and I divorced in 2011."
Example output: { "people": [
 { "name": "Rafael Quispe", "relation": "father", "relationOf": "narrator", "gender": "male", "deathDate": "1999-03-02", "evidence": "My father Rafael Quispe died on 2 March 1999" },
 { "name": "Elena", "relation": "mother", "relationOf": "narrator", "gender": "female", "livesIn": "Cusco", "evidence": "my mother Elena lives in Cusco" },
 { "name": "Bruno Silva", "relation": "stepfather", "relationOf": "narrator", "gender": "male", "livesIn": "Cusco", "evidence": "with my stepfather Bruno Silva" },
 { "name": "Diego Quispe", "relation": "brother", "relationOf": "narrator", "gender": "male", "evidence": "Diego Quispe is my brother" },
 { "name": "Ana", "relation": "wife", "relationOf": "Diego Quispe", "gender": "female", "evidence": "Ana is Diego's wife" },
 { "name": "Tomás", "relation": "son", "relationOf": "Diego Quispe", "gender": "male", "birthDate": "2015-07-08", "evidence": "their son Tomás was born on 8 July 2015" },
 { "name": "Iker", "relation": "husband", "relationOf": "narrator", "gender": "male", "ended": true, "endDate": "2011", "evidence": "My ex-husband Iker and I divorced in 2011" } ] }`;

// First-person words, and the ways a saved note or a document refers to the narrator.
const FIRST_PERSON = /\b(i|me|my|our|we|us|mimi|yangu|wangu|wetu|tuna|nina|you|your|yours)\b|\bthe (speaker|user|narrator|individual|author)\b/i;
// Paraphrases and documents name the narrator by role; any of these is the narrator, never another person.
const NARRATOR = new Set(["narrator", "self", "the narrator", "the individual", "individual", "the user", "user", "the speaker", "speaker", "the author", "author", "you"]);

// The general invariants every extracted person must satisfy before anything is saved. Pure, so tests can feed it
// any model output: a fact survives only if the text supports it.
export function validatePeople(raw, { text = "", selfName = "", selfAliases = [], knownGender = () => null, known = [] } = {}) {
  const kept = [];
  const dropped = [];
  const source = ` ${normalizeName(text)} `;
  const isNarrator = (name) => NARRATOR.has(normalizeName(name)) || SELF_PRONOUNS.has(normalizeName(name)) || selfMatchKind(name, [selfName, ...selfAliases].filter(Boolean)) != null;
  for (const item of Array.isArray(raw) ? raw.slice(0, 30) : []) {
    const name = String(item?.name || "").replace(/\s+/g, " ").trim();
    const drop = (reason, extra = {}) => dropped.push({ name, reason, ...extra });
    if (!name) { drop("no-name"); continue; }
    const key = normalizeName(name);
    if (THIRD_PERSON.has(key)) { drop("pronoun"); continue; }
    if (kinOf(key) || isOrdinalKin(key)) { drop("kinship-word"); continue; }
    const notPerson = notPersonReason(name);
    if (notPerson) { drop(notPerson); continue; }
    const narrator = isNarrator(name);
    const relationWord = relationOfItem(item);
    const kin = relationWord ? kinOf(relationWord) : null;
    // Every word of the name must be in the text; the model may not invent or complete a name. The one exception
    // is a known person the text names by role ("my wife"), with a role that fits what the graph already knows.
    if (!narrator && !key.split(" ").every((word) => source.includes(` ${word} `)) && !namedByRole(name, kin, text, known)) { drop("name-not-in-text"); continue; }

    const person = { name: narrator ? "narrator" : name, isNarrator: narrator, relation: null, relationOf: null, group: null, gender: null, birthDate: null, deathDate: null, marriageDate: null, ended: false, endDate: null, livesIn: null, notChildOf: [], evidence: String(item?.evidence || "").slice(0, 300) };
    for (const field of ["birthDate", "deathDate", "marriageDate"]) {
      const value = String(item?.[field] || "").trim();
      // A date counts only if the text states it; a year alone or a computed date is not a stated date.
      if (value && isIsoDate(value) && mentionsDate(text, value)) person[field] = value;
      else if (value) drop(`${field}-not-in-text`, { value });
    }
    if (person.birthDate && person.deathDate && person.deathDate < person.birthDate) {
      drop("death-before-birth");
      person.deathDate = null;
    }

    const relationOf = String(item?.relationOf || "").trim();
    const notChildOf = (Array.isArray(item?.notChildOf) ? item.notChildOf : []).map(String);
    if (relationWord && !kin) {
      drop("unknown-relation", { relation: relationWord });
    } else if (kin && !narrator) {
      const ofNarrator = !relationOf || isNarrator(relationOf);
      // Possessive → narrator: a relation to the narrator needs a first-person word where the text states it.
      if (ofNarrator && !FIRST_PERSON.test(person.evidence) && !sentencesNaming(text, name).some((sentence) => FIRST_PERSON.test(sentence))) {
        drop("relation-without-narrator-possessive", { relation: relationWord });
      } else if (!ofNarrator && !source.includes(` ${normalizeName(relationOf).split(" ")[0]} `)) {
        drop("relation-of-unknown-person", { relation: relationWord });
      } else if (!ofNarrator && !["parent", "child", "sibling", "spouse", "grandparent", "grandchild"].includes(kin.group)) {
        drop("relation-of-other-not-kept", { relation: relationWord });
      } else if (kin.group === "child" && notChildOf.some((other) => !ofNarrator && normalizeName(other) === normalizeName(relationOf))) {
        drop("contradicts-not-child-of", { relation: relationWord });
      } else {
        // Gender-consistent kinship: the kinship word, the stated gender and what the graph knows must agree.
        const stated = ["female", "male"].includes(String(item?.gender)) ? item.gender : null;
        const knownValue = knownGender(name);
        const clash = [stated, knownValue].find((value) => value && kin.gender && value !== kin.gender);
        if (clash) {
          drop("gender-mismatch", { relation: relationWord, gender: clash });
        } else {
          person.relation = kin.ex ? kin.word.replace(/^ex-/, "") : kin.word.replace(/s$/, "");
          person.group = kin.group;
          person.relationOf = ofNarrator ? "narrator" : relationOf;
          person.gender = kin.gender || stated || knownValue || null;
          if (kin.group === "spouse") {
            const endDate = String(item?.endDate || "").trim();
            if (/^\d{4}$/.test(endDate) && source.includes(` ${endDate} `)) person.endDate = endDate;
            else if (endDate && isIsoDate(endDate) && mentionsDate(text, endDate)) person.endDate = endDate;
            else if (endDate) drop("endDate-not-in-text", { value: endDate });
            person.ended = Boolean(kin.ex || item?.ended || person.endDate);
          }
        }
      }
    } else if (["female", "male"].includes(String(item?.gender))) {
      person.gender = item.gender;
    }
    if (typeof item?.livesIn === "string" && item.livesIn.trim()) {
      const place = item.livesIn.trim();
      if (normalizeName(place).split(" ").every((word) => source.includes(` ${word} `))) person.livesIn = place;
      else drop("place-not-in-text", { value: place });
    }
    person.notChildOf = notChildOf.filter((other) => source.includes(` ${normalizeName(other).split(" ")[0]} `));
    kept.push(person);
  }
  return { people: mergeSamePerson(kept, dropped), dropped };
}

function relationOfItem(item) {
  const word = normalizeKin(item?.relation || "");
  if (!word || word === "null") return "";
  return isOrdinalKin(word) ? "child" : word;
}

// "my wife" with no name in this text, where the graph already knows that person in that role.
function namedByRole(name, kin, text, known) {
  if (!kin) return false;
  const person = (known || []).find((item) => normalizeName(item.name) === normalizeName(name));
  const role = person ? kinOf(person.kind) : null;
  if (!role || role.group !== kin.group || (role.gender && kin.gender && role.gender !== kin.gender)) return false;
  return new RegExp(`\\b(my|our|your)\\s+(?:late\\s+|dear\\s+|ex[- ]?)?${kin.base}`, "i").test(text);
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
    if (!same.relation && person.relation) Object.assign(same, { relation: person.relation, relationOf: person.relationOf, group: person.group, gender: person.gender });
    same.ended = same.ended || person.ended;
    same.endDate = same.endDate || person.endDate;
    same.livesIn = same.livesIn || person.livesIn;
    same.notChildOf = [...new Set([...same.notChildOf, ...person.notChildOf])];
    same.evidence = [same.evidence, person.evidence].filter(Boolean).join(" … ").slice(0, 300);
  }
  return out;
}

const NARRATOR_SIDE = { name: "me", type: "self" };
// Each role group becomes one edge type; "up" means the person is the parent/grandparent of relationOf.
const EDGE = {
  parent: ["parent_of", "up"],
  child: ["parent_of", "down"],
  sibling: ["sibling_of", "side"],
  spouse: ["spouse_of", "side"],
  grandparent: ["grandparent_of", "up"],
  grandchild: ["grandparent_of", "down"],
  relative: ["relative_of", "side"],
  social: ["knows", "side"],
};

// Validated people become entity facts (dates, role) and triples for the usual commit path.
export function peopleToGraph(people) {
  const triples = [];
  const entityFacts = [];
  for (const person of people) {
    const toNarrator = person.relationOf === "narrator";
    const side = person.isNarrator ? NARRATOR_SIDE : { name: person.name, type: "person", kind: toNarrator ? person.relation : null };
    if (!person.isNarrator) {
      entityFacts.push({ name: person.name, birthDate: person.birthDate, deathDate: person.deathDate, kind: toNarrator ? person.relation : null, birthOrder: null });
    }
    if (person.relation && EDGE[person.group]) {
      const [predicate, direction] = EDGE[person.group];
      const other = toNarrator ? NARRATOR_SIDE : { name: person.relationOf, type: "person" };
      const [subject, object] = direction === "down" ? [other, side] : [side, other];
      const ended = person.group === "spouse" && person.ended;
      triples.push({
        subject,
        predicate,
        object,
        validFrom: person.group === "spouse" ? person.marriageDate : null,
        validTo: ended && person.endDate ? (person.endDate.length === 4 ? `${person.endDate}-01-01` : person.endDate) : null,
        attributes: {
          ...(["relative", "social"].includes(person.group) ? { kind: person.relation } : {}),
          ...(ended ? { ended: true, ...(person.endDate?.length === 4 ? { endPrecision: "year" } : {}) } : {}),
        },
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
