import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CASES, SEED_MESSAGES, SELF_NAME } from "../scripts/golden/cases.js";
import { PERSONAL } from "../scripts/golden/personal.js";

// Personal data lives in the database only: no name, place, plot number or golden sentence from the owner's records may
// appear in a prompt, regex, example, comment, UI text or test fixture in api/src, api/test or web/. The golden
// cases (api/scripts/golden, exempt) are the source of those words, as the owner's real records, plus identifiers
// the cases do not mention (personal.js there).
const ROOTS = [fileURLToPath(new URL("../src", import.meta.url)), fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../../web", import.meta.url))];
const SKIP_DIRS = new Set(["node_modules", ".next", "public", "out", "dist"]);
// Capitalised words in the cases that are ordinary words, months, brands or units.
const ORDINARY = new Set(["my", "i", "i'm", "she", "he", "her", "his", "our", "we", "is", "in", "after", "the", "and", "tsh", "toyota", "suzuki", "prado", "jimny", "dar", "es", "salaam", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "who", "what", "when", "how", "list", "show", "tell", "do", "does", "which", "where"]);

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(js|mjs|cjs|ts|tsx|jsx)$/.test(name) ? [path] : [];
  });
}

function personalWords() {
  const words = new Set([...PERSONAL, ...SELF_NAME.split(" ")]);
  const texts = [...SEED_MESSAGES, ...CASES.flatMap((item) => item.turns)];
  for (const text of texts) {
    for (const match of text.matchAll(/(?<![\p{L}\d])[\p{Lu}][\p{L}\d]+(?:-[\p{L}\d]+)*/gu)) {
      // A capital at the start of a sentence is grammar, not a name.
      const before = text.slice(0, match.index).trimEnd();
      if (!before || /[.!?:]$/.test(before)) continue;
      if (!ORDINARY.has(match[0].toLowerCase())) words.add(match[0]);
    }
  }
  return [...words].filter((word) => word.length >= 3);
}

function sentences() {
  const texts = [...SEED_MESSAGES, ...CASES.flatMap((item) => item.turns)];
  return [...new Set(texts.flatMap((text) => [text, ...text.split(/(?<=[.!?])\s+/)]).map((text) => text.trim().replace(/\s+/g, " ").toLowerCase()).filter((text) => text.length >= 24))];
}

test("api/src, api/test and web/ contain no personal name, place, identifier or golden sentence", () => {
  const words = personalWords();
  const pattern = new RegExp(`(?<![\\p{L}\\d])(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\d])`, "iu");
  const golden = sentences();
  const hits = [];
  for (const root of ROOTS) {
    for (const file of files(root)) {
      const text = readFileSync(file, "utf8");
      const flat = text.replace(/\s+/g, " ").toLowerCase();
      for (const sentence of golden) if (flat.includes(sentence)) hits.push(`${relative(root, file)}: golden sentence "${sentence.slice(0, 50)}"`);
      text.split("\n").forEach((line, index) => {
        const match = line.match(pattern);
        if (match) hits.push(`${relative(join(root, ".."), file)}:${index + 1}: "${match[1]}"`);
      });
    }
  }
  assert.deepEqual(hits, [], `personal data in source:\n${hits.join("\n")}`);
});
