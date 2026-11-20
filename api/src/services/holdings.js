import { prisma } from "../prisma.js";
import { formatDay } from "./savedSummary.js";

// "Which properties do I own?" is answered by code from the saved records, not by a model list (a model list
// left places out). Each holding is found in the text of saved events: a plot number, "land/plot/house in
// <Place>", "<Place> land", "<Name> is our place". Mentions of the same plot or place are one holding; each
// holding lists its earliest dated record.

// Lower or capitalised ("Land in …" in a title); no case-insensitive flag, which would let \p{Lu} match lower case.
const anyCase = (words) => words.map((word) => `[${word[0]}${word[0].toUpperCase()}]${word.slice(1)}`).join("|");
const KIND_WORDS = anyCase(["plots?", "land", "house", "farm", "shamba", "kiwanja", "viwanja", "nyumba", "property", "place"]);
// "our place in <Region>" names the region of a holding named on its own ("Quiet Harbour is our place"), not another.
const KIND_IN = anyCase(["plots?", "land", "house", "farm", "shamba", "kiwanja", "viwanja", "nyumba", "property"]);
const PLACE = "[\\p{Lu}][\\p{L}'’-]+(?:\\s+[\\p{Lu}][\\p{L}'’-]+){0,2}";
const NOT_PLACE = new Set(["the", "our", "my", "a", "this", "that", "these", "his", "her", "their", "we", "i", "it", "plot", "plots", "land", "house", "certificate", "occupancy", "purchase", "payment", "second", "first", "new"]);
const HOLDING_TEXT = /\b(plots?|land|house|farm|shamba|kiwanja|viwanja|nyumba|property|place|certificate of occupancy|title deed|mauziano)\b/i;

export const PROPERTY_LIST_QUESTION = /\b(?:what|which|list|show|name|how many|tell me)\b[^?]*\b(propert(?:y|ies)|plots|lands|houses|real estate|viwanja|mali)\b|\b(?:do i|i)\s+(?:have|own)\b[^?]*\b(propert(?:y|ies)|plots|lands|houses)\b/i;

export function isPropertyListQuestion(text) {
  return PROPERTY_LIST_QUESTION.test(String(text || ""));
}

function placeKey(raw) {
  const words = String(raw || "").trim().split(/\s+/).filter((word) => !NOT_PLACE.has(word.toLowerCase()));
  return words.length ? words.join(" ") : null;
}

function kindOf(word) {
  const value = String(word || "").toLowerCase();
  if (/^(plots?|kiwanja|viwanja)$/.test(value)) return "plot";
  if (/^(house|home|nyumba)$/.test(value)) return "house";
  if (/^(land|farm|shamba)$/.test(value)) return "land";
  return "place";
}

// [{ key, label, kind, place }] holdings one text names.
export function holdingMentions(text) {
  const value = String(text || "").replace(/\s+/g, " ");
  const found = [];
  const add = (mention) => {
    if (!mention.key || found.some((item) => item.key === mention.key)) return;
    found.push(mention);
  };
  const plotPlace = value.match(new RegExp(`\\bplots?\\s+(?:in|at)\\s+(${PLACE})`, "u"))?.[1] || value.match(new RegExp(`\\b(${PLACE})\\s+[Pp]lot\\s+P\\d`, "u"))?.[1];
  for (const match of value.matchAll(/\bP\d{3,6}\b/g)) {
    const place = placeKey(plotPlace);
    add({ key: `plot:${match[0]}`, label: `Plot ${match[0]}${place ? `, ${place}` : ""}`, kind: "plot", place });
  }
  const patterns = [
    [new RegExp(`(${PLACE})\\s+is\\s+(?:our|my)\\s+(${KIND_WORDS})\\b`, "gu"), 1, 2],
    [new RegExp(`\\b(${KIND_IN})\\b(?:\\s+[\\p{Ll}]+){0,2}\\s+(?:in|at)\\s+(${PLACE})`, "gu"), 2, 1],
    [new RegExp(`\\b(${PLACE})\\s+([Ll]and|[Hh]ouse|[Pp]lot|[Ff]arm)\\b`, "gu"), 1, 2],
  ];
  for (const [pattern, placeAt, kindAt] of patterns) {
    for (const match of value.matchAll(pattern)) {
      const place = placeKey(match[placeAt]);
      if (!place) continue;
      const kind = kindOf(match[kindAt]);
      add({ key: `place:${place.toLowerCase()}`, label: place, kind, place });
    }
  }
  // Plots already listed by number cover "plots in <Place>".
  const plotPlaces = new Set(found.filter((item) => item.kind === "plot" && item.key.startsWith("plot:")).map((item) => String(item.place || "").toLowerCase()));
  return found.filter((item) => !(item.key.startsWith("place:") && plotPlaces.has(item.place.toLowerCase()) && item.kind === "plot"));
}

export function holdingsFromEvents(events) {
  const holdings = new Map();
  for (const event of events) {
    const text = [event.title, event.understoodMeaning, event.rawInput].filter(Boolean).join(". ");
    if (!HOLDING_TEXT.test(text)) continue;
    for (const mention of holdingMentions(text)) {
      const holding = holdings.get(mention.key) || { ...mention, records: [] };
      if (holding.kind === "place" && mention.kind !== "place") holding.kind = mention.kind;
      holding.records.push(event);
      holdings.set(mention.key, holding);
    }
  }
  // "Elmstead Westmark" (place then region) is the holding "Elmstead".
  for (const [key, holding] of holdings) {
    if (!key.startsWith("place:")) continue;
    const shorter = [...holdings.keys()].find((other) => other !== key && other.startsWith("place:") && key.startsWith(`${other} `));
    if (!shorter) continue;
    const target = holdings.get(shorter);
    for (const event of holding.records) if (!target.records.includes(event)) target.records.push(event);
    if (target.kind === "place" && holding.kind !== "place") target.kind = holding.kind;
    holdings.delete(key);
  }
  // Records that name a holding's place in their title count for it too ("Quiet Harbour fence project").
  for (const holding of holdings.values()) {
    if (!holding.key.startsWith("place:")) continue;
    const word = new RegExp(`\\b${holding.place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    for (const event of events) {
      if (!holding.records.includes(event) && word.test(event.title || "")) holding.records.push(event);
    }
  }
  return [...holdings.values()].map((holding) => {
    const dated = holding.records.filter((event) => event.occurredAt).sort((a, b) => new Date(a.occurredAt) - new Date(b.occurredAt));
    const first = dated[0] || holding.records[0];
    return { ...holding, first, count: holding.records.length };
  });
}

export async function loadHoldings(userId) {
  const events = await prisma.event.findMany({
    where: { userId, status: { not: "archived" } },
    orderBy: [{ occurredAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    select: { id: true, title: true, occurredAt: true, datePrecision: true, understoodMeaning: true, rawInput: true },
    take: 500,
  });
  return holdingsFromEvents(events);
}

const KIND_LABEL = { plot: "plot", land: "land", house: "house", place: "place" };

export function holdingsAnswer(holdings, question = "") {
  if (!holdings.length) return "No properties are recorded yet.";
  const order = { plot: 0, land: 1, house: 2, place: 3 };
  const sorted = holdings.slice().sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label));
  const lines = sorted.map((holding) => {
    const label = holding.kind === "plot" || holding.kind === "place" ? holding.label : `${KIND_LABEL[holding.kind]} in ${holding.label}`;
    const when = holding.first?.occurredAt ? `, ${formatDay(holding.first.occurredAt, holding.first.datePrecision)}` : "";
    const more = holding.count > 1 ? ` (+${holding.count - 1} more record${holding.count === 2 ? "" : "s"})` : "";
    return `- ${label[0].toUpperCase()}${label.slice(1)} — ${holding.first?.title || "recorded"}${when}${more}`;
  });
  const head = /\bhow many\b/i.test(question) ? `You have ${holdings.length === 1 ? "1 property" : `${holdings.length} properties`} on record:` : `Your ${holdings.length === 1 ? "property" : "properties"} on record (${holdings.length}):`;
  return `${head}\n${lines.join("\n")}`;
}
