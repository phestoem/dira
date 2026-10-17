# fix/people-answers — progress

Last updated: 2026-10-17

## Current goal
2026-10-17 (Phesto): option (b), staged: rebuild DIRA's WHOLE knowledge
layer (not just family) as one ingestion path → one claim store → one
answer path. Design: docs/knowledge-layer.md. Now: phase 0 (tests first).

## Rebuild plan (Phesto, 2026-10-17)

### Scope: a whole life, family is one slice
- People and all relationships: family, work (colleague, supervisor,
  contractor, client, partner), social.
- Organisations and roles (works_at, founded, director_of).
- Places, properties, vehicles, documents and their details (plot
  numbers, registrations, expiry dates).
- Projects: status, costs, people involved, milestones.
- Money: payments, contributions, transfers, debts, by person, project,
  place and period.
- Time: events, deadlines, renewals, birthdays, plans.
- Visions, intentions, decisions ("I plan to…", "we decided…").
- Corrections and changes over time (sold, moved, ended, replaced).
Nothing may be designed so that it only works for family.
Out of scope for now (don't design them out): streaming and speed,
Swahili answer templates, timezone/currency settings.

### Design
1. One ingestion path `ingest(userId, text, source, ref)` for every input
   (chat, file, email, journal, queue, confirmed chips, relationship
   statements). The router decides only question vs statement; a mixed
   message does both. A statement is always stored and extracted.
2. One claim store: subject entity, predicate, object (entity or value),
   amount + currency, date with precision (day/month/year), status
   (stated/confirmed/rejected/superseded), evidence quote, source ref,
   extractor + model version. Closed core vocabulary across all domains,
   plus `related_to` with a free-text label and evidence.
3. One resolver for all entity types.
4. Derived in code, never extracted: in-laws, step/half relations,
   counts, sums, eldest/youngest, assets held on a date, project totals,
   what's due.
5. Answers: structured tools over claims (exact facts, lists, counts,
   sums, timelines, formatted by code) plus pgvector retrieval over
   source text (events.fullText, journal, documents) for open questions.
   The model writes open answers from both; meaning-based post-check.
   One answer path.
6. Relationship and other graph/UI views become tables materialised from
   claims, so the UI keeps working until phase 4.
Model: schema extractor + gpt-4.1, as a setting. Production untouched
until phase 5.

### Phases and exit criteria
- **Phase 0, tests first** (no engine code):
  synthetic LIFE set replacing the synthetic family (job, business,
  building project with contractors and payments, property bought and
  sold, vehicles, travel, plans, family), with expected claims and
  questions in every domain, a few in Swahili; non-family golden cases
  (projects cost/status, money by person/place/period, work relations,
  documents, what's due, plans/decisions, corrections, open/summary
  questions); claims scorer reporting per domain (people, work, money,
  projects, assets/documents, time, plans, open questions); hold-out 4
  written by a separate subagent (fresh context, no access to src/ or
  results), a stranger's whole life, used once at the gate.
  Exit: all sets committed; scorer runs on them; hold-out 4 shape-checked
  by script only (never read by the main session).
- **Phase 1, store and ingestion** behind a flag: Claim table and
  migration, one resolver for all entity types, `ingest()`, the
  question/statement/mixed router, Relationship materialised from claims.
  Exit: npm test green; old path unchanged with the flag off; on every
  set no statement is dropped at routing.
- **Cost estimate** (before phase 2): cost per save and for re-ingesting
  Phesto's account with gpt-4.1.
- **Phase 2, extraction into claims**: one schema extractor over the
  whole vocabulary, validation invariants, corrections → superseded;
  scorer reports claims recall/precision per domain.
  **Gate:** on hold-out 4, recall >= 85% overall, no domain < 70%,
  nothing dropped at routing. Otherwise stop and report to Phesto.
- **Phase 3, answers**: tools over claims, code derivations, pgvector
  retrieval, one answer path, post-check. Exit: per-domain answer scores
  on the life set and hold-outs 1–3, against the current rules engine.
- **Phase 4, switch entry points**: every input goes through `ingest()`;
  UI endpoints (cards, confirm/reject, /graph/family, suggestions,
  merge), bridge and digest read the materialised tables; old readers
  and writers removed. Exit: npm test, golden fixture, live readonly on
  dira_dev, contamination test.
- **Phase 5, migrate**: re-ingest dira_dev from events, parity runs on
  all sets, production migration plan for Phesto (not executed here).

## Done (with commit hashes)
Pushed to origin/fix/people-answers and merged to main (fast-forward):
- `5869c9c` dev isolation: dev can't reach production side effects.
- `b2e6d69` family/property answers from saved events; API enforces
  `X-DIRA-Readonly: 1` (api/src/readonly.js + Prisma write guard) and
  advertises `capabilities: ["readonly-header"]` on /health.
- `cde4129` CLAUDE.md working rules.
- `aef0960` connections need a named person; golden `--allow-prod-readonly`
  flag; tests exit by themselves.
- `07a2fe3` graphAutoExtract also gates per-event extraction (intake, email,
  journal, vision, fact chips, passive conversation). Relationship chips,
  relationship_add, /graph/relationships and /graph/facts stay ungated.
- `570df39` reset-gate resends the full introduction and asserts 12 family
  edges, 0 Zelda–Enock, 0 Careen–Zelda.

Pushed to origin/fix/people-answers on 2026-10-17 (first made on local
`main` by mistake, moved here; local main reset to origin/main):
- `beb392c` relationship cards show exactly what was saved; "my mother"/"my
  wife" need a relative of matching gender; pronouns are never nodes.
- `6359ed4` people facts come from structured extraction at save time
  (peopleFacts.js), validated by general invariants; answers read stored
  facts only; parser and phrase library removed; contamination test
  (api/test/contamination.test.js) fails if a golden sentence or personal
  name appears in src/.
- `9a68f4b` rules engine with one kin vocabulary; synthetic set
  (api/scripts/golden/sets/synthetic.json) and hold-out
  (api/test/holdout/holdout.json); runner gains `--set` and `--score-only`.
- `1806ca6` `PEOPLE_ENGINE=tools|rules` (default rules): schema extraction
  (peopleSchema.js) + tool-calling answers (peopleTools.js) with a
  names/dates post-check; fresh hold-out api/test/holdout/holdout2.json,
  written before the engine.
- `7d26524` `x-dira-metrics: 1` answer metrics (model calls, latency, answer
  path); tools-engine fallback goes through the post-check; no marriage date
  guessed from a bare year.

## In progress
- Nothing running. Extraction measurement finished 2026-10-17 19:29 UTC
  (tmux `extraction`, 72 seedings). Output: logs/extraction/ (per-run
  files; summary.txt; never read trace-*.jsonl or hold-out dumps).
  Summary: `node api/scripts/golden/extraction-summary.mjs`.
- Harness: `npm run golden -- --set <set> --extraction --trace <file>`
  scores the stored graph against api/test/extraction/<set>.expect.json
  (API must run with DIRA_EXTRACT_TRACE=<file>). Miss stages: routing,
  no-extraction, not-extracted:person|fact, validation:person|fact,
  kept-not-stored. Switches: PEOPLE_EXTRACTOR=rules|schema,
  GRAPH_EXTRACT_MODEL (extraction only).

## Latest scores
2026-10-17, extraction recall (facts stored / expected), 3 runs, mean
(min), at `40231d3`. Full table in docs/architecture-review.md §8.

| Set | rules mini (default) | rules 4.1 | schema 4o | schema 4.1 |
|---|---|---|---|---|
| Synthetic | 83% (80) | 90% (90) | 84% (80) | **99% (97)** |
| Hold-out 1 | 65% (65) | 71% (71) | 73% (71) | **88% (88)** |
| Hold-out 2 | 69% (69) | 64% (62) | 69% (69) | **77% (77)** |
| Hold-out 3 | 21% (21) | 21% (21) | 21% (21) | 18% (16) |

Hold-out 3 loses ~9 of 19 facts at routing in every combination (cap
~53%). Rules extractor is flat across models; schema scales with the
model. colleague, niece_nephew, parent_in_law: 0% everywhere.

Answer scores: 2026-10-17, step e, at `15dc8b1`, 3 runs per engine per set, mean (min).
dira_dev rebuilt with the rules extractor just before. Raw output:
logs/compare/ (summary.txt). Hold-outs are scores only.

| Set | Rules | Tools | Hybrid |
|---|---|---|---|
| Hold-out 3 /13 (decides) | **3.3 (3)** | 3.0 (3) | 2.7 (2) |
| Hold-out 2 /10 | **6.0 (6)** | 2.3 (2) | 4.0 (4) |
| Hold-out 1 /10 | **4.3 (4)** | 3.7 (2) | 3.3 (3) |
| Synthetic /15 | 11.0 (11) | 9.0 (9) | 12.7 (12)* |
| Family fixture /13 | **12.0 (10)** | 11.0 (10) | 10.0 (10) |
| Live readonly dira_dev /13 | 9.3 (9) | **12.0 (12)** | 9.0 (9) |

\* Hybrid was fixed against synthetic failures (allowed), so its synthetic
score is not a fair measure.

Cost per answer (median latency, model calls mean): rules 1.4–2.0 s,
1.3–1.9; tools 2.5–3.2 s, 3.1–3.5; hybrid 1.9–2.4 s, 2.1–2.8.

Where they fail (family/live only; may be inspected):
- rules live: children, children-follow-up, parents (3/3 runs),
  properties (2/3).
- tools live: properties (3/3). Note: tools reads the rules-built graph.
- hybrid family+live: wife (code list omits the marriage date), cars (no
  count by asset type; it lists every asset), properties (3/3);
  live children-count says 6: dira_dev has messy child entities ("older
  son", "Prisha - Neema", Presley unconfirmed) that the code counts as-is.

Earlier: 2026-10-16/17 at `7d26524` (rules / tools): hold-out 2 6.0 / 2.7,
hold-out 1 4.0 / 3.7, synthetic 10.0 / 8.0, family 12.0 / 12.0.

## Decisions made and why
- Engine is picked by hold-out score; stop adding rules for single cases
  (Phesto, 2026-10-16). Hold-outs are score-only: never inspect individual
  hold-out results or failures.
- Default stays `PEOPLE_ENGINE=rules`: it wins hold-out 2 in every run and
  costs about half the model calls. Tools stays in the code behind the flag.
- No personal data in src/: prompt examples use invented people and places;
  place names come from the user's own entities. Tests and golden cases may
  use the real family.
- 2026-10-17: by hold-out 3, rules stays the default (3.3 vs 3.0 vs 2.7
  /13). The spread is one question, so this is a tie, not a win; rules
  also leads both older hold-outs. Tools and hybrid stay behind the flag.
- Hybrid uses the rules extractor, and dira_dev holds one graph, so the
  tools engine's live runs answer over a rules-built graph.
- Post-check edge dates: a 1 January with no stored precision is shown as
  its year (a bare year was stored that way); never more precise than said.
- 2026-10-17 (Phesto): hybrid is parked: not deleted, no family-specific
  fixes (that is tuning to Phesto again). Its value is speed; revisit once
  extraction is fixed.
- 2026-10-17 (Phesto): live 12/13 for tools is Phesto's family, which the
  system has seen a lot; it doesn't count as evidence. Engines are judged
  on hold-outs.
- 2026-10-17 (Phesto): messy dira_dev child records ("older son",
  "Prisha - Neema") stay as a realistic test; the resolver must cope.
- Relationship chips count as explicit confirmation, so they are not gated
  by graphAutoExtract (Phesto confirmed).
- The "User has four sisters" event (8a58cc4c) in dira_dev was archived at
  Phesto's request.

- 2026-10-17 (Phesto): option (b), staged, scope = whole knowledge layer
  (see Rebuild plan). Reason: the extraction measurement showed hold-out 3
  capped at ~53% by routing for every extractor/model, and every fix
  under (a) lands in 2–5 duplicated places.

## Earlier plan (done)
Hybrid plan a–e, 2026-10-17: post-check audit (0 inventions : 30 wrong
removals), meaning-based post-check, hybrid engine (parked), hold-out 3,
re-score (rules 3.3, tools 3.0, hybrid 2.7 /13). Details in git history
of this file (`7240988`).

## Next steps
1. Phase 0: docs/knowledge-layer.md (claim shape + core vocabulary, so the
   test writers share it); hold-out 4 subagent; synthetic life set and
   expectations; non-family golden cases; per-domain claims scorer.
2. Phase 1 (see plan).

## Open questions for Phesto
- None open. (a) vs (b) decided 2026-10-17: (b), whole-life scope.
