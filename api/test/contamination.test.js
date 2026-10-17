import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CASES, MOTHER_SENTENCE, SEED_MESSAGES } from "../scripts/golden/cases.js";

// src/ must work for anyone: no golden sentence and no name, place or identifier from the owner's own records may
// appear in a prompt, regex, example or comment. Golden scores only mean something if the code never saw the answers.
const SRC = fileURLToPath(new URL("../src", import.meta.url));
// The synthetic family and the hold-out set must be as unseen as the owner's own records.
const SETS = ["../scripts/golden/sets/synthetic.json", "./holdout/holdout.json", "./holdout/holdout2.json", "./holdout/holdout3.json"].map((path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")));
const SET_SEEDS = SETS.flatMap((set) => set.seeds);
const SET_TURNS = SETS.flatMap((set) => set.questions.flatMap((question) => question.turns));

// Proper nouns from the golden seeds are found automatically; these words in them are ordinary English or brands.
const ORDINARY = new Set(["my", "she", "i", "i'm", "mum", "eur", "jina", "mama", "dada", "after", "in", "our", "her", "jeroen's", "eoin's", "marek's", "zofia's", "we", "our", "my", "is", "jan", "januari", "februari", "machi", "aprili", "mei", "juni", "julai", "agosti", "septemba", "oktoba", "novemba", "desemba", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "tsh", "toyota", "suzuki"]);
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

function personalWords() {
  const words = new Set(PERSONAL);
  for (const message of [...SEED_MESSAGES, MOTHER_SENTENCE, ...SET_SEEDS]) {
    for (const word of message.match(/\b[\p{Lu}][\p{L}\d]+(?:-[\p{L}\d]+)*\b/gu) || []) {
      if (!ORDINARY.has(word.toLowerCase())) words.add(word);
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
    for (const sentence of sentences) if (flat.includes(sentence)) hits.push(`${relative(SRC, file)}: golden sentence "${sentence.slice(0, 60)}"`);
    text.split("\n").forEach((line, index) => {
      const match = line.match(wordPattern);
      if (match && !ALLOWED_LINES.some((allowed) => allowed.test(line.trim()))) hits.push(`${relative(SRC, file)}:${index + 1}: "${match[1]}"`);
    });
  }
  assert.deepEqual(hits, [], `personal data in src/:\n${hits.join("\n")}`);
});
