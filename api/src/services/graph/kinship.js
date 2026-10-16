// Kinship words carry gender. "My mother" may only resolve to a woman the graph already knows as a mother,
// never to the father just because he is the only confirmed parent.
//
// One vocabulary of roles a person can have to the narrator. group decides the edge; gender comes from the word.
// Prefixes keep their meaning: half-X is an X, step-X and X-in-law are relatives, ex-X is an ended X.
const WORDS = {
  parent: [["father", "m"], ["dad", "m"], ["daddy", "m"], ["papa", "m"], ["baba", "m"], ["mother", "f"], ["mum", "f"], ["mom", "f"], ["mummy", "f"], ["mama", "f"], ["parent", null]],
  child: [["son", "m"], ["daughter", "f"], ["binti", "f"], ["child", null], ["kid", null], ["mtoto", null], ["mwana", null]],
  sibling: [["brother", "m"], ["kaka", "m"], ["sister", "f"], ["dada", "f"], ["sibling", null], ["twin", null]],
  spouse: [["husband", "m"], ["mume", "m"], ["wife", "f"], ["mke", "f"], ["spouse", null], ["partner", null], ["fiance", null], ["fiancé", null], ["fiancee", "f"], ["fiancée", "f"]],
  grandparent: [["grandfather", "m"], ["grandpa", "m"], ["granddad", "m"], ["babu", "m"], ["grandmother", "f"], ["grandma", "f"], ["granny", "f"], ["bibi", "f"], ["grandparent", null]],
  grandchild: [["grandson", "m"], ["granddaughter", "f"], ["grandchild", null], ["mjukuu", null]],
  relative: [["uncle", "m"], ["mjomba", "m"], ["aunt", "f"], ["auntie", "f"], ["shangazi", "f"], ["cousin", null], ["binamu", null], ["nephew", "m"], ["niece", "f"], ["relative", null]],
  social: [["friend", null], ["neighbour", null], ["neighbor", null], ["colleague", null], ["godfather", "m"], ["godmother", "f"], ["godparent", null], ["godson", "m"], ["goddaughter", "f"], ["godchild", null], ["landlord", null], ["tenant", null], ["boss", null]],
};
const BASE = new Map(Object.entries(WORDS).flatMap(([group, words]) => words.map(([word, gender]) => [word, { group, gender: gender === "m" ? "male" : gender === "f" ? "female" : null }])));
const ORDINAL = /^(firstborn|first-born|eldest|oldest|youngest|last-born|lastborn|baby|middle)$/;

// "Step father", "half sister", "sister in law", "ex wife", "late dad" → the vocabulary's own spelling.
export function normalizeKin(word) {
  return String(word || "").trim().toLowerCase()
    .replace(/^(?:my|our|your|the)\s+/, "")
    .replace(/^(?:late|dear|beloved|former)\s+/, (m) => (m.trim() === "former" ? "ex-" : ""))
    .replace(/^ex\s*-?\s*/, "ex-")
    .replace(/^step\s*-?\s*/, "step")
    .replace(/^half\s*-?\s*/, "half-")
    .replace(/^great\s*-?\s*/, "great-")
    .replace(/\s*-?\s*in\s*-?\s*law$/, "-in-law")
    .replace(/\s+/g, " ");
}

// { group, gender, base, step, half, inLaw, ex } for a kinship word, or null when it names no role.
export function kinOf(word) {
  let rest = normalizeKin(word);
  if (!rest) return null;
  const flags = { ex: false, step: false, half: false, inLaw: false, great: false };
  if (rest.startsWith("ex-")) { flags.ex = true; rest = rest.slice(3); }
  if (rest.startsWith("great-")) { flags.great = true; rest = rest.slice(6); }
  if (rest.startsWith("half-")) { flags.half = true; rest = rest.slice(5); }
  if (rest.startsWith("step") && BASE.has(rest.slice(4))) { flags.step = true; rest = rest.slice(4); }
  if (rest.endsWith("-in-law")) { flags.inLaw = true; rest = rest.slice(0, -7); }
  const singular = BASE.has(rest) ? rest : rest === "children" ? "child" : rest === "wives" ? "wife" : rest.replace(/s$/, "");
  const base = BASE.get(singular);
  if (!base) return null;
  let group = base.group;
  if (flags.step || flags.inLaw) group = "relative";
  if (flags.great && group === "relative") group = "relative";
  return { ...flags, base: singular, group, gender: base.gender, word: normalizeKin(word) };
}

export function isOrdinalKin(word) {
  return ORDINAL.test(normalizeKin(word));
}

// Every spelling the vocabulary knows, for regexes that look for a role word in text.
export const KIN_PATTERN = (() => {
  const words = [...BASE.keys()].sort((a, b) => b.length - a.length).map((word) => word.replace(/[-]/g, "\\-"));
  return `(?:ex[- ]?|step[- ]?|half[- ]|great[- ])?(?:${words.join("|")})(?:s|ren)?(?:[- ]in[- ]law)?`;
})();

export function genderOf(word) {
  const text = String(word || "").trim().toLowerCase();
  if (text === "female" || text === "woman") return "female";
  if (text === "male" || text === "man") return "male";
  return kinOf(text)?.gender || null;
}

// What the graph knows about a relative's gender: the entity's kind first, then the edge label.
export function knownGender(entity, edge) {
  return genderOf(entity?.kind) || genderOf(edge?.label) || null;
}

// A wanted gender needs a positive match; a person whose known role contradicts it, or whose role is unknown, is skipped.
export function fitsGender(wanted, known) {
  return !wanted || known === wanted;
}

// Third-person pronouns are resolved by the clause they sit in; none of them ever means the self.
export const THIRD_PERSON = new Set(["she", "he", "they", "her", "him", "them", "hers", "his", "their", "yeye"]);
export const SELF_PRONOUNS = new Set(["i", "me", "my", "myself", "mimi", "yangu", "wangu"]);

// Kinds that only restate the entity type say nothing about the person's role and may be replaced by one that does.
export function isGenericKind(kind) {
  return !kind || /^(person|place|property|project|organisation|organization|asset|vehicle|document|other|relative|unknown)$/i.test(String(kind).trim());
}

// A new role replaces the recorded one only when it says more about the same role: "sister" → "half-sister".
export function refinesKind(current, next) {
  if (!next || isGenericKind(next)) return false;
  if (isGenericKind(current)) return true;
  const was = kinOf(current);
  const now = kinOf(next);
  return Boolean(was && now && now.half && !was.half && was.base === now.base);
}
