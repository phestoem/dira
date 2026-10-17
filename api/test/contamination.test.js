import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CASES, MOTHER_SENTENCE, SEED_MESSAGES } from "../scripts/golden/cases.js";

// src/ must work for anyone: no golden sentence and no name, place or identifier from the owner's own records may
// appear in a prompt, regex, example or comment. Golden scores only mean something if the code never saw the answers.
const SRC = fileURLToPath(new URL("../src", import.meta.url));
// The synthetic family and the hold-out set must be as unseen as the owner's own records.
const SETS = ["../scripts/golden/sets/synthetic.json", "../scripts/golden/sets/life.json", "./holdout/holdout.json", "./holdout/holdout2.json", "./holdout/holdout3.json", "./holdout/holdout4.json", "./holdout/holdout5.json", "../scripts/golden/sets/dev2.json", "../scripts/golden/sets/dev3.json"]
  .map((path) => new URL(path, import.meta.url))
  .filter((url) => existsSync(url))
  .map((url) => {
    const set = JSON.parse(readFileSync(url, "utf8"));
    // Sets with expected claims name their people, places and things there; those names are what src/ must not hold.
    const expectUrl = new URL(`./extraction/${set.name}.expect.json`, import.meta.url);
    const claims = existsSync(expectUrl) ? JSON.parse(readFileSync(expectUrl, "utf8")).claims || [] : [];
    const names = [set.selfName, ...claims.flatMap((claim) => [claim.subject, claim.object, claim.context])].filter((name) => name && name !== "me");
    return { ...set, names, sealed: url.pathname.endsWith("/holdout5.json") };
  });
// A seed is chat text or { text, source }.
const SET_SEEDS = SETS.flatMap((set) => set.seeds.map((seed) => (typeof seed === "string" ? seed : seed.text)));
// Hold-out text must not reach the session that writes src/, so a hit on it is reported without the text.
const SEALED = SETS.filter((set) => set.sealed).flatMap((set) => [...set.seeds.map((seed) => (typeof seed === "string" ? seed : seed.text)), ...set.questions.flatMap((question) => question.turns)]);
const SEALED_WORDS = new Set(SEALED.flatMap((text) => text.toLowerCase().match(/[\p{L}\d'’-]+/gu) || []));
// Which unsealed sets a word comes from; a word only the sealed set uses is shown as "<hold-out text>".
const origin = (word) => SETS.filter((set) => !set.sealed && [...set.names, ...set.seeds.map((seed) => (typeof seed === "string" ? seed : seed.text))].some((text) => new RegExp(`(?<![\\p{L}])${String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(text))).map((set) => set.name);
const show = (text) => {
  const from = origin(text);
  if (from.length) return `${text}" (from ${from.join(", ")})`.replace(/"$/, "");
  return SEALED_WORDS.has(String(text).toLowerCase()) || SEALED.some((item) => item.toLowerCase().includes(String(text).toLowerCase())) ? "<hold-out text>" : text;
};
const SET_TURNS = SETS.flatMap((set) => set.questions.flatMap((question) => question.turns));

// Proper nouns from the golden seeds are found automatically; these words in them are ordinary English or brands.
const ORDINARY = new Set(["my", "she", "i", "i'm", "mum", "eur", "jina", "mama", "dada", "after", "in", "our", "her", "jeroen's", "eoin's", "marek's", "zofia's", "we", "our", "my", "is", "jan", "januari", "februari", "machi", "aprili", "mei", "juni", "julai", "agosti", "septemba", "oktoba", "novemba", "desemba", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "tsh", "toyota", "suzuki", "kes", "brl", "hotel", "insurance", "lake", "mrs", "association", "builders", "club", "general", "st", "nd", "rd", "th", "de", "fit", "dr", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);
// Personal identifiers that are not in the golden seeds.
const PERSONAL = ["Burton", "Ntagha", "Makoba", "Emmiliana", "Hassani", "Mrisho", "Juma Enock", "RZJ1200017194", "P9200", "Tent Camping Plans", "Dar es Salaam", "Finland", "Tanzania", "Arusha", "Nairobi"];

// Mail configuration, not record data: the digest's verified sender. Changing it needs a deploy-side setting.
const ALLOWED_LINES = [/^const FROM = "DIRA <[^>]+@qusaz\.com>";$/];

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(js|mjs|cjs|ts)$/.test(name) ? [path] : [];
  });
}

// Words the seeds also write in lower case are ordinary words, not names ("The", "No.", "Every").
const LOWER = new Set(SET_SEEDS.flatMap((text) => text.match(/(?<![\p{L}\d])[\p{Ll}][\p{L}\d'’]*/gu) || []));

function personalWords() {
  const words = new Set(PERSONAL);
  // Entity names from expected claims: the capitalised words in them that the seeds never write in lower case.
  for (const name of SETS.flatMap((set) => set.names)) {
    for (const word of String(name).match(/[\p{Lu}][\p{L}\d]+(?:-[\p{L}\d]+)*/gu) || []) {
      if (!ORDINARY.has(word.toLowerCase()) && !LOWER.has(word.toLowerCase())) words.add(word);
    }
  }
  // Older sets without claims: capitalised words in their seeds.
  const unnamed = SETS.filter((set) => !set.names.length || set.names.length === 1).flatMap((set) => set.seeds.map((seed) => (typeof seed === "string" ? seed : seed.text)));
  for (const message of [...SEED_MESSAGES, MOTHER_SENTENCE, ...unnamed]) {
    // A capital at the start of a line or sentence is grammar ("Date:", "Every month"), not a name.
    for (const match of message.matchAll(/\b[\p{Lu}][\p{L}\d]+(?:-[\p{L}\d]+)*\b/gu)) {
      const before = message.slice(0, match.index).trimEnd();
      if (SET_SEEDS.includes(message) && (!before || /[.!?:\n]$/.test(before) || /\n\s*$/.test(message.slice(0, match.index)))) continue;
      if (!ORDINARY.has(match[0].toLowerCase()) && !LOWER.has(match[0].toLowerCase())) words.add(match[0]);
    }
  }
  return [...words];
}

function fixtureSentences() {
  const sentences = [...SEED_MESSAGES, MOTHER_SENTENCE, ...CASES.flatMap((item) => item.turns), ...SET_SEEDS, ...SET_TURNS];
  // Whole messages, and each sentence of the longer ones.
  return [...new Set(sentences.flatMap((text) => [text, ...text.split(/(?<=[.!?])\s+/)]).map((text) => text.trim().replace(/\s+/g, " ")).filter((text) => text.length >= 12))];
}

test("src/ contains no golden sentence and no personal name", () => {
  const words = personalWords();
  const wordPattern = new RegExp(`\\b(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
  const sentences = fixtureSentences().map((text) => text.toLowerCase());
  const hits = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const flat = text.replace(/\s+/g, " ").toLowerCase();
    for (const sentence of sentences) if (flat.includes(sentence)) hits.push(`${relative(SRC, file)}: golden sentence "${show(sentence).slice(0, 60)}"`);
    text.split("\n").forEach((line, index) => {
      const match = line.match(wordPattern);
      if (match && !ALLOWED_LINES.some((allowed) => allowed.test(line.trim()))) hits.push(`${relative(SRC, file)}:${index + 1}: "${show(match[1])}"`);
    });
  }
  assert.deepEqual(hits, [], `personal data in src/:\n${hits.join("\n")}`);
});
