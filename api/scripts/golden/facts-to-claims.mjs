// Adds a "claims" list (docs/knowledge-layer.md) to the older people-only expectation files, converted from their
// "facts", so the claim store is scored on them too. Prints counts only: hold-out items are never shown.
// Usage: node scripts/golden/facts-to-claims.mjs synthetic holdout holdout2 holdout3
import { readFileSync, writeFileSync } from "node:fs";

const KIN_WORD = { grandparent: "grandparent", grandchild: "grandchild", aunt_uncle: "aunt/uncle", niece_nephew: "niece/nephew", cousin: "cousin", parent_in_law: "parent-in-law", child_in_law: "child-in-law", sibling_in_law: "sibling-in-law", godparent: "godparent", godchild: "godchild", other_relative: "relative" };

function relationClaim(person, relation, of) {
  const other = of || "me";
  if (relation === "parent" || relation === "step_parent") return { subject: person, predicate: "parent_of", object: other, ...(relation === "step_parent" ? { label: "step" } : {}) };
  if (relation === "child" || relation === "step_child") return { subject: other, predicate: "parent_of", object: person, ...(relation === "step_child" ? { label: "step" } : {}) };
  if (relation === "spouse" || relation === "former_spouse") return { subject: person, predicate: "spouse_of", object: other };
  if (["sibling", "half_sibling", "step_sibling"].includes(relation)) return { subject: person, predicate: "sibling_of", object: other, ...(relation !== "sibling" ? { label: relation.split("_")[0] } : {}) };
  if (["friend", "neighbour", "colleague"].includes(relation)) return { subject: person, predicate: `${relation}_of`, object: other };
  if (KIN_WORD[relation]) return { subject: person, predicate: "relative_of", object: other, label: KIN_WORD[relation] };
  return null;
}

for (const set of process.argv.slice(2)) {
  const path = new URL(`../../test/extraction/${set}.expect.json`, import.meta.url);
  const file = JSON.parse(readFileSync(path, "utf8"));
  const claims = [];
  const unconverted = [];
  for (const fact of file.facts) {
    if (fact.relation) {
      const claim = relationClaim(fact.person, fact.relation, fact.of);
      if (claim) claims.push({ seed: fact.seed, ...claim });
      else unconverted.push(fact.relation);
    }
  }
  // Wedding and divorce dates sit on the spouse claim; born/died are their own claims.
  const sameName = (a, b) => a.toLowerCase().split(" ")[0] === b.toLowerCase().split(" ")[0];
  for (const fact of file.facts) {
    if (fact.born || fact.died) claims.push({ seed: fact.seed, subject: fact.person, predicate: fact.born ? "born" : "died", value: fact.born || fact.died });
    if (fact.married || fact.divorced) {
      const spouse = claims.find((claim) => claim.predicate === "spouse_of" && claim.object === "me" && sameName(claim.subject, fact.person));
      const field = fact.married ? "date" : "until";
      if (spouse && !spouse[field]) spouse[field] = fact.married || fact.divorced;
      else claims.push({ seed: fact.seed, subject: fact.person, predicate: "spouse_of", object: "me", [field]: fact.married || fact.divorced });
    }
  }
  writeFileSync(path, `${JSON.stringify({ ...file, claims }, null, 1)}\n`);
  console.log(`${set}: ${file.facts.length} facts → ${claims.length} claims${unconverted.length ? `, ${unconverted.length} unconverted` : ""}`);
}
