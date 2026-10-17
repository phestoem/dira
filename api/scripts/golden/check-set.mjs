// Shape check for a set and its expected claims that prints counts only, so a sealed hold-out can be validated
// without anyone reading it. Usage: node scripts/golden/check-set.mjs <set.json> <expect.json>
import { readFileSync } from "node:fs";
import { DOMAINS, PREDICATES } from "../../src/services/knowledge/vocabulary.js";

const [setPath, expectPath] = process.argv.slice(2);
const set = JSON.parse(readFileSync(setPath, "utf8"));
const expect = JSON.parse(readFileSync(expectPath, "utf8"));
const problems = { unknownPredicate: 0, seedOutOfRange: 0, entityWithoutObject: 0, badDateValue: 0, badDate: 0, questionWithoutExpect: 0, unknownQuestionDomain: 0 };
const claims = Object.fromEntries(DOMAINS.map((domain) => [domain, 0]));
const iso = /^\d{4}(-\d{2}){0,2}$/;
for (const fact of expect.claims) {
  const spec = PREDICATES[fact.predicate];
  if (!spec) { problems.unknownPredicate += 1; continue; }
  claims[fact.predicate === "related_to" && DOMAINS.includes(fact.domain) ? fact.domain : spec.domain] += 1;
  if (!(fact.seed >= 0 && fact.seed < set.seeds.length)) problems.seedOutOfRange += 1;
  if (spec.object === "entity" && !fact.object) problems.entityWithoutObject += 1;
  if (spec.object === "date" && !iso.test(String(fact.value))) problems.badDateValue += 1;
  for (const key of ["date", "until"]) if (fact[key] && !iso.test(String(fact[key]))) problems.badDate += 1;
}
const questions = {};
for (const question of set.questions) {
  questions[question.domain] = (questions[question.domain] || 0) + 1;
  if (![...DOMAINS, "open"].includes(question.domain)) problems.unknownQuestionDomain += 1;
  if (!question.expect || !Object.keys(question.expect).length) problems.questionWithoutExpect += 1;
}
const sources = {};
for (const seed of set.seeds) sources[typeof seed === "string" ? "chat" : seed.source] = (sources[typeof seed === "string" ? "chat" : seed.source] || 0) + 1;
console.log(JSON.stringify({ name: set.name, asOf: Boolean(set.asOf), seeds: set.seeds.length, sources, claims: expect.claims.length, claimsByDomain: claims, questions: set.questions.length, questionsByDomain: questions, problems }));
