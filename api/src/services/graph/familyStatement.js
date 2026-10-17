import { KIN_PATTERN } from "./kinship.js";

const ORDINAL_WORDS = "firstborn|first-born|eldest|oldest|youngest|last-born";
import { isPeopleQuestion } from "./peopleGrounding.js";

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};


export function isRelationshipStatement(text) {
  const value = String(text || "").trim();
  if (!value || value.includes("?") || /^(who|how|what|where|when|why)\b/i.test(value) || isPeopleQuestion(value)) return false;
  const lower = value.toLowerCase();
  if (/\b(no longer|not my|sold the|amehama|si tena)\b/.test(lower)) return false;
  return STATES_ROLE.test(lower) && namesPersonWithRole(value);
}

// "my stepfather", "is our youngest", "I have two brothers", "mama yangu", "supervises": a role stated about someone.
const STATES_ROLE = new RegExp(`\\b((?:my|our)\\s+(?:late\\s+|dear\\s+)?(?:${KIN_PATTERN}|${ORDINAL_WORDS})|is (?:my|our)\\s+(?:\\w+\\s+)?(?:${KIN_PATTERN})|(?:i|we) have (?:\\w+ )?(?:${KIN_PATTERN})|(?:${KIN_PATTERN})\\s+(?:yangu|wangu|wetu)|supervises|anasimamia)\\b`, "i");

const ROLE_WORD = new RegExp(`\\b(${KIN_PATTERN}|${ORDINAL_WORDS}|in-laws?|supervis\\w*|caretaker|fundi|wangu|yangu|anasimamia)\\b`, "i");
const NOT_A_NAME = new Set([
  "i", "i'm", "i've", "my", "our", "your", "we", "he", "she", "they", "it", "his", "her", "their", "the", "a", "an", "this", "that", "these",
  "today", "yesterday", "tomorrow", "tonight", "and", "but", "so", "then", "also", "please", "when", "after", "before", "on", "in",
  "father", "mother", "mum", "mom", "dad", "mama", "baba", "dada", "kaka", "sister", "brother", "wife", "husband", "son", "daughter", "family",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", ...Object.keys(MONTHS),
]);

// A connection to save needs someone named and what they are to you: "My sister Sigrún", "Gunnar supervises the farm".
// Feelings, counts and "my family" on their own never qualify.
export function namesPersonWithRole(text) {
  const value = String(text || "");
  if (!ROLE_WORD.test(value)) return false;
  return (value.match(/[\p{Lu}][\p{L}'’-]+/gu) || []).some((word) => !NOT_A_NAME.has(word.toLowerCase()));
}

export function describeRelationshipLine({ type, from, to, selfId, attributes }) {
  const left = from || { name: "Someone" };
  const right = to || { name: "someone" };
  const selfIsFrom = selfId && left.id === selfId;
  const selfIsTo = selfId && right.id === selfId;
  const other = selfIsFrom ? right : left;
  if (type === "lives_at") return `${left.name} — lives in ${right.name}`;
  if (type === "parent_of" && selfIsTo) return `${other.name} — your ${parentWord(other)}${passed(other)}`;
  if (type === "parent_of" && selfIsFrom) return `${other.name} — your ${childWord(other)}${eldest(other, attributes)}`;
  if (type === "sibling_of" && !selfIsFrom && !selfIsTo) return `${left.name} — ${siblingWord(left)} of ${right.name}`;
  if (type === "sibling_of") return `${other.name} — your ${siblingWord(other)}`;
  if (type === "spouse_of" && !selfIsFrom && !selfIsTo) {
    const hint = right?.kind === "father" ? " (your father)" : right?.kind === "mother" ? " (your mother)" : "";
    return `${left.name} — ${spouseWord(left)} of ${right.name}${hint}`;
  }
  if (type === "spouse_of") return `${other.name} — your ${spouseWord(other)}`;
  if (!selfIsFrom && !selfIsTo && type === "parent_of") return `${left.name} — parent of ${right.name}`;
  return `${left.name} — ${String(type || "related").replaceAll("_", " ")} — ${right.name}`;
}

function parentWord(person) {
  if (person?.kind === "mother") return "mother";
  if (person?.kind === "father") return "father";
  return "parent";
}

function childWord(person) {
  if (person?.kind === "daughter") return "daughter";
  if (person?.kind === "son") return "son";
  return "child";
}

function siblingWord(person) {
  if (person?.kind === "sister") return "sister";
  if (person?.kind === "brother") return "brother";
  return "sibling";
}

function spouseWord(person) {
  if (person?.kind === "wife") return "wife";
  if (person?.kind === "husband") return "husband";
  return "spouse";
}

function eldest(person, attributes) {
  const order = Number(attributes?.birthOrder || person?.attributes?.birthOrder);
  return order === 1 ? " (eldest)" : "";
}

function passed(person) {
  if (!person?.deathDate) return "";
  const date = new Date(person.deathDate);
  if (Number.isNaN(date.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return ` (passed ${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()})`;
}
