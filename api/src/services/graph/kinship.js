// Kinship words carry gender. "My mother" may only resolve to a woman the graph already knows as a mother,
// never to the father just because he is the only confirmed parent.
const FEMALE = new Set(["mother", "mum", "mom", "mama", "sister", "dada", "wife", "mke", "daughter", "binti", "female", "woman", "grandmother", "aunt", "niece"]);
const MALE = new Set(["father", "dad", "baba", "brother", "kaka", "husband", "mume", "son", "male", "man", "grandfather", "uncle", "nephew"]);

export function genderOf(word) {
  const text = String(word || "").trim().toLowerCase();
  for (const key of [text, text.replace(/s$/, ""), text === "wives" ? "wife" : ""]) {
    if (FEMALE.has(key)) return "female";
    if (MALE.has(key)) return "male";
  }
  return null;
}

// What the graph knows about a relative's gender: the entity's kind first, then the edge label.
export function knownGender(entity, edge) {
  return genderOf(entity?.kind) || genderOf(edge?.label) || null;
}

// A wanted gender needs a positive match; a person whose known role contradicts it, or whose role is unknown, is skipped.
export function fitsGender(wanted, known) {
  return !wanted || known === wanted;
}

// "they" can refer to anyone; "she" and "he" only to someone of that gender. None of them ever means the self.
export const THIRD_PERSON = new Set(["she", "he", "they", "her", "him", "them", "hers", "his", "their", "yeye"]);
export const SELF_PRONOUNS = new Set(["i", "me", "my", "myself", "mimi", "yangu", "wangu"]);

export function pronounFits(pronoun, kind) {
  const word = String(pronoun || "").toLowerCase();
  if (word === "they" || word === "yeye") return true;
  const gender = genderOf(kind);
  if (word === "she" || word === "her") return gender === "female";
  if (word === "he" || word === "him") return gender === "male";
  return false;
}

// Kinds that only restate the entity type say nothing about the person's role and may be replaced by one that does.
export function isGenericKind(kind) {
  return !kind || /^(person|place|property|project|organisation|organization|asset|vehicle|document|other|relative|unknown)$/i.test(String(kind).trim());
}
