// Summarises logs/extraction/: per extractor × model × set, recall and precision (mean and min over runs), where
// missed facts were lost, routing, validation drops, and per relation type P/R pooled over runs.
// Reads only each run's "extraction:" totals line, so hold-out items are never touched.
// Usage: node scripts/golden/extraction-summary.mjs [dir]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] || new URL("../../../logs/extraction/", import.meta.url).pathname;
const groups = new Map();
for (const file of readdirSync(dir).filter((name) => /-\d+\.txt$/.test(name))) {
  const line = readFileSync(join(dir, file), "utf8").split("\n").find((text) => text.startsWith("extraction: "));
  if (!line) continue;
  const run = JSON.parse(line.slice("extraction: ".length));
  const [extractor, ...rest] = file.replace(/-\d+\.txt$/, "").split("-");
  const model = rest.slice(0, -1).join("-");
  const key = `${extractor}|${model}|${run.set}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(run);
}

const pct = (value) => (value == null ? "  –" : `${Math.round(value * 100)}%`.padStart(4));
const add = (into, from) => Object.entries(from || {}).forEach(([key, value]) => { into[key] = (into[key] || 0) + value; });
const sets = ["synthetic", "holdout", "holdout2", "holdout3"];

console.log("extractor | model | set | runs | recall mean (min) | precision mean | people recall | lost (per run) | routing (per run) | validation drops (per run)");
const rows = [...groups.entries()].sort(([a], [b]) => {
  const [ea, ma, sa] = a.split("|");
  const [eb, mb, sb] = b.split("|");
  return ea.localeCompare(eb) || ma.localeCompare(mb) || sets.indexOf(sa) - sets.indexOf(sb);
});
const byType = new Map();
for (const [key, runs] of rows) {
  const [extractor, model, set] = key.split("|");
  const recalls = runs.map((run) => run.totals.tp / run.facts);
  const precisions = runs.map((run) => (run.totals.tp + run.totals.fp ? run.totals.tp / (run.totals.tp + run.totals.fp) : null)).filter((value) => value != null);
  const people = runs.map((run) => run.people.tp / (run.people.tp + run.people.fn));
  const lost = {};
  const routing = {};
  const drops = {};
  for (const run of runs) { add(lost, run.lost); add(routing, run.routing); add(drops, run.validationDrops); }
  const perRun = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, value]) => `${name} ${(value / runs.length).toFixed(1)}`).join(", ") || "none";
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
  console.log(`${extractor} | ${model} | ${set} | ${runs.length} | ${pct(mean(recalls))} (${pct(Math.min(...recalls)).trim()}) | ${pct(mean(precisions))} | ${pct(mean(people))} | ${perRun(lost)} | ${perRun(routing)} | ${perRun(drops)}`);
  const pooled = byType.get(`${extractor}|${model}`) || {};
  for (const run of runs) for (const [type, value] of Object.entries(run.byType)) {
    const into = (pooled[type] ||= { tp: 0, fp: 0, fn: 0 });
    into.tp += value.tp; into.fp += value.fp; into.fn += value.fn;
  }
  byType.set(`${extractor}|${model}`, pooled);
}

console.log("\nper relation type, pooled over all sets and runs: recall / precision (tp fp fn)");
const types = [...new Set([...byType.values()].flatMap((pooled) => Object.keys(pooled)))].sort();
const columns = [...byType.keys()];
console.log(`type | ${columns.map((column) => column.replace("|", " ")).join(" | ")}`);
for (const type of types) {
  const cells = columns.map((column) => {
    const value = byType.get(column)[type];
    if (!value) return "–";
    const recall = value.tp + value.fn ? value.tp / (value.tp + value.fn) : null;
    const precision = value.tp + value.fp ? value.tp / (value.tp + value.fp) : null;
    return `${pct(recall).trim()} / ${pct(precision).trim()} (${value.tp} ${value.fp} ${value.fn})`;
  });
  console.log(`${type} | ${cells.join(" | ")}`);
}
