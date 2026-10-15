import { isPeopleQuestion } from "./peopleGrounding.js";

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const SELF = { name: "me", type: "self" };

export function isRelationshipStatement(text) {
  const value = String(text || "").trim();
  if (!value || value.includes("?") || /^(who|how|what|where|when|why)\b/i.test(value) || isPeopleQuestion(value)) return false;
  const lower = value.toLowerCase();
  if (/\b(no longer|not my|sold the|amehama|si tena)\b/.test(lower)) return false;
  return /\b(my\s+(father|mother|mum|mom|dad|mama|baba|sisters?|brothers?|wife|husband|children|sons?|daughters?|family)|is my\s+(father|mother|son|daughter|sister|brother|wife|husband)|supervises|anasimamia)\b/.test(lower);
}

export function parseFamilyStatement(text) {
  const triples = [];
  const entityFacts = [];
  const seen = new Set();
  for (const sentence of String(text || "").split(/(?<=[.])\s+/)) {
    readList(sentence, triples, entityFacts, seen);
    for (const clause of sentence.split(/\s+\band\b\s+/i)) readPerson(clause, triples, entityFacts, seen);
  }
  return { triples, entityFacts };
}

export function describeRelationshipLine({ type, from, to, selfId, attributes }) {
  const left = from || { name: "Someone" };
  const right = to || { name: "someone" };
  const selfIsFrom = selfId && left.id === selfId;
  const selfIsTo = selfId && right.id === selfId;
  const other = selfIsFrom ? right : left;
  if (type === "lives_at") return `${left.name} — lives in ${right.name}`;
  if (type === "parent_of" && selfIsTo) return `${other.name} — ${parentWord(other)} of you${passed(other)}`;
  if (type === "parent_of" && selfIsFrom) return `${other.name} — your ${childWord(other)}${eldest(other, attributes)}`;
  if (type === "sibling_of") return `${other.name} — your ${siblingWord(other)}`;
  if (type === "spouse_of") return `${other.name} — your ${spouseWord(other)}`;
  return `${left.name} — ${String(type || "related").replaceAll("_", " ")} — ${right.name}`;
}

function readList(sentence, triples, facts, seen) {
  const sisters = sentence.match(/\bmy (sisters|brothers|sons|daughters|children) are\s+(.+?)\.?\s*$/i);
  if (sisters) {
    const role = sisters[1].toLowerCase();
    const people = shareSurname(splitPeople(sisters[2]).map(readNote));
    for (const person of people) {
      const kind = listKind(role, person.note);
      addFact(facts, person.name, { kind, birthOrder: birthOrder(person.note) });
      if (role === "children" || role === "sons" || role === "daughters") {
        addTriple(triples, seen, {
          subject: SELF,
          predicate: "parent_of",
          object: { name: person.name, type: "person", kind },
          evidence: sentence.trim(),
          attributes: birthOrder(person.note) ? { birthOrder: birthOrder(person.note) } : {},
          confidence: 0.9,
        });
      } else {
        addTriple(triples, seen, {
          subject: { name: person.name, type: "person", kind },
          predicate: "sibling_of",
          object: SELF,
          evidence: sentence.trim(),
          attributes: {},
          confidence: 0.9,
        });
      }
    }
  }
  const spouse = matchRole(sentence, /\bmy (wife|husband) is\s+/i);
  if (spouse) {
    const name = spouse.name;
    const kind = spouse.role.toLowerCase();
    addFact(facts, name, { kind });
    addTriple(triples, seen, {
      subject: { name, type: "person", kind },
      predicate: "spouse_of",
      object: SELF,
      evidence: sentence.trim(),
      attributes: {},
      confidence: 0.9,
    });
  }
}

function readPerson(clause, triples, facts, seen) {
  const named = matchNamedRole(clause);
  if (named) {
    const name = named.name;
    const role = named.role.toLowerCase();
    addFact(facts, name, { kind: role });
    const person = { name, type: "person", kind: role };
    if (role === "son" || role === "daughter") {
      addTriple(triples, seen, { subject: SELF, predicate: "parent_of", object: person, evidence: clause.trim(), attributes: {}, confidence: 0.9 });
    } else if (role === "father" || role === "mother") {
      addTriple(triples, seen, { subject: person, predicate: "parent_of", object: SELF, evidence: clause.trim(), attributes: {}, confidence: 0.9 });
    } else if (role === "sister" || role === "brother") {
      addTriple(triples, seen, { subject: person, predicate: "sibling_of", object: SELF, evidence: clause.trim(), attributes: {}, confidence: 0.9 });
    } else {
      addTriple(triples, seen, { subject: person, predicate: "spouse_of", object: SELF, evidence: clause.trim(), attributes: {}, confidence: 0.9 });
    }
    return;
  }
  const parent = matchRole(clause, /\bmy (father|mother|mum|mom|dad|mama|baba)\s+/i);
  if (!parent) return;
  const kind = ["mother", "mum", "mama"].includes(parent.role.toLowerCase()) ? "mother" : "father";
  const name = parent.name;
  const deathDate = spokenDate(clause);
  addFact(facts, name, { kind, deathDate });
  addTriple(triples, seen, {
    subject: { name, type: "person", kind },
    predicate: "parent_of",
    object: SELF,
    evidence: clause.trim(),
    attributes: {},
    confidence: 0.9,
  });
  if (/\blives in\b/i.test(clause)) {
    const place = placeFrom(clause);
    if (place) {
      addTriple(triples, seen, {
        subject: { name, type: "person", kind },
        predicate: "lives_at",
        object: { name: place, type: "place" },
        evidence: clause.trim(),
        attributes: {},
        confidence: 0.9,
      });
    }
  }
}

function matchRole(text, prefix) {
  const head = String(text || "").match(prefix);
  if (!head) return null;
  const name = properName(String(text).slice(head.index + head[0].length));
  if (!name) return null;
  return { role: head[1], name };
}

function matchNamedRole(text) {
  const marker = String(text || "").match(/\bis my (son|daughter|sister|brother|wife|husband|father|mother)\b/i);
  if (!marker) return null;
  const before = String(text).slice(0, marker.index).trim();
  const words = before.split(/\s+/);
  const nameWords = [];
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (!/^[\p{Lu}][\p{L}'’-]*$/u.test(words[index])) break;
    nameWords.unshift(words[index]);
  }
  if (!nameWords.length) return null;
  return { name: nameWords.join(" "), role: marker[1] };
}

function properName(text) {
  const match = String(text || "").match(/^([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)*)/u);
  return match ? match[1].trim() : "";
}

function splitPeople(text) {
  const items = [];
  let current = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === "," || text.slice(index, index + 5).toLowerCase() === " and ")) {
      if (current.trim()) items.push(current.trim());
      current = "";
      if (char !== ",") index += 4;
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim().replace(/[.]$/, ""));
  return items;
}

function readNote(item) {
  const match = String(item || "").trim().match(/^(.*?)\s*\((.*)\)\s*$/);
  if (!match) return { name: String(item || "").trim(), note: "" };
  return { name: match[1].trim(), note: match[2].trim() };
}

function shareSurname(people) {
  if (people.length < 2) return people;
  const last = people[people.length - 1].name.split(/\s+/).filter(Boolean);
  if (last.length < 2) return people;
  const single = people.slice(0, -1).every((person) => person.name.split(/\s+/).length === 1);
  if (!single) return people;
  const surname = last.slice(1).join(" ");
  return people.map((person) => (
    person.name.split(/\s+/).length === 1 ? { ...person, name: `${person.name} ${surname}` } : person
  ));
}

function listKind(role, note) {
  const lower = `${role} ${note}`.toLowerCase();
  if (/\bdaughter\b/.test(lower) || role === "daughters") return "daughter";
  if (/\bson\b/.test(lower) || role === "sons") return "son";
  if (role === "sisters" || /\bsister\b/.test(lower)) return "sister";
  if (role === "brothers" || /\bbrother\b/.test(lower)) return "brother";
  return null;
}

function birthOrder(note) {
  if (/\b(eldest|oldest|firstborn|first-born)\b/i.test(note || "")) return 1;
  return null;
}

function placeFrom(clause) {
  const matches = [...clause.matchAll(/\bin\s+([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+)*)/gu)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

function spokenDate(text) {
  const match = String(text || "").match(/\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{4})\b/i);
  if (!match) return null;
  const month = MONTHS[match[2].toLowerCase()];
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`;
}

function addTriple(triples, seen, triple) {
  const key = `${triple.subject.name}|${triple.predicate}|${triple.object.name}`;
  if (seen.has(key)) return;
  seen.add(key);
  triples.push(triple);
}

function addFact(facts, name, extra) {
  const existing = facts.find((fact) => fact.name === name);
  if (existing) {
    Object.assign(existing, Object.fromEntries(Object.entries(extra).filter(([, value]) => value)));
    return;
  }
  facts.push({ name, birthDate: null, deathDate: extra.deathDate || null, kind: extra.kind || null, birthOrder: extra.birthOrder || null });
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
