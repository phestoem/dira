// Re-scores saved --claims dumps with the current scorer, without seeding again (no model calls).
// Usage: node scripts/golden/rescore-claims.mjs <dump.json>...   (never pass hold-out dumps to read their misses)
import { readFileSync } from "node:fs";
import { scoreClaims } from "./claims.js";

for (const file of process.argv.slice(2)) {
  const dump = JSON.parse(readFileSync(file, "utf8"));
  const expect = JSON.parse(readFileSync(new URL(`../../test/extraction/${dump.set}.expect.json`, import.meta.url), "utf8"));
  const score = scoreClaims({ expect, entities: dump.entities, claims: dump.claims, selfId: dump.self?.id });
  const pct = (value) => (value == null ? "–" : `${Math.round(value * 100)}%`);
  console.log(`${dump.set} ${file.split("/").pop()}: ${score.total.tp}/${score.claims} (recall ${pct(score.total.recall)}, precision ${pct(score.total.precision)}) | ${Object.entries(score.byDomain).filter(([, v]) => v.tp + v.fn).map(([d, v]) => `${d} ${pct(v.recall)}`).join(" | ")}`);
  if (process.env.SHOW_MISSES) for (const fact of score.missed) console.log(`  MISS seed ${fact.seed} ${JSON.stringify(fact)}`);
}
