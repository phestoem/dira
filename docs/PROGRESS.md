# fix/people-answers — progress

Last updated: 2026-10-17

## Current goal
2026-10-17 (Phesto): option (b), staged: rebuild DIRA's WHOLE knowledge
layer (not just family) as one ingestion path → one claim store → one
answer path. Design: docs/knowledge-layer.md. Phases 0 and 1 done.
Phase 2 gate FAILED on 2026-10-17 (hold-out 4 mean recall 62%); stopped,
waiting for Phesto's decision (see open questions).

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
- Phase 2 runs (tmux `phase2`, `api/scripts/golden/phase2.sh <label>
  <runs> <sets…>`): logs/phase2/<label>/summary.txt, finished when it ends
  with "== … done". Running now: v4 (life, synthetic, hold-outs 1–3) then
  v4b (life again, for variance).
- Phase 2 tuning on the life set only (misses inspected there; hold-outs
  1–3 score-only):
  | version | life recall | precision | change |
  |---|---|---|---|
  | v1 | 61% | 66% | first prompt |
  | v2 | 80% | 82% | direction examples, one entity per project, codes as identifiers, located_in, no arithmetic |
  | v3 | 82% | 86% | resolver: a thing keeps its name (longer phrase = alias; this was splitting projects); reuse known names; short names; no today-stamped dates; year-not-in-text check |
  | v4 | 85% / 85% | 88–90% | end-of-prompt checklist; has_client alias stored as client_of; joint decisions → me (assets 68 / 60%) |
  | v5 | 87% / 86% | 87–89% | mention `place` → located_in in code; insurance policies as documents; today-stamp check. Every domain ≥ 76% in both runs (assets 80%) |
  Rescored with the final scorer (fixed name ranking: an entity holding
  every expected word beats a place named inside the expected name; the
  new place entities had been stealing project matches). v4 rescored:
  88 / 87%. Hold-outs 1–3 with v5 (people/time only): 69 / 92 / 78%.
- Gate readiness met on v5 (life ≥ 85% and every domain ≥ 70% in both
  runs). Gate (Phesto, 2026-10-17): hold-out 4 seeded 3 times in one
  session, score-only, judged on the mean per domain and overall
  (≥ 85%, no domain < 70%, 0 dropped at routing).
- GATE RESULT 2026-10-17 21:41 UTC (claims-v5, gpt-4.1, logs/phase2/gate/,
  totals only, hold-out 4 items never read): FAIL.
  | domain | run1 | run2 | run3 | mean | bar |
  |---|---|---|---|---|---|
  | overall | 63% | 61% | 63% | 62% (296/474) | 85% |
  | people | 54 | 62 | 69 | 62% | 70 |
  | work | 72 | 72 | 66 | 70% | 70 |
  | assets | 60 | 56 | 44 | 53% | 70 |
  | money | 63 | 60 | 70 | 64% | 70 |
  | projects | 25 | 25 | 25 | 25% | 70 |
  | time | 71 | 67 | 71 | 70% | 70 |
  | plans | 80 | 73 | 87 | 80% | 70 |
  Dropped at routing: 0 in all runs (that criterion passes). Precision
  68–71%. Life set on the same code: 87% / 86%. The 25-point drop from
  the tuning set to the hold-out means v2–v5 were fitted to the life set
  and/or to my own expectation conventions (entity naming, predicate
  choice), which the separate writer did not share. Which of the two it
  is cannot be told from totals.
  Scorer equivalences (documented in docs/knowledge-layer.md): plans /
  intends / decided one family; owns met by bought (also a superseded
  one) or, with until, by sold; a missing context is not wrong. Life
  expectation change: the hospital payments lost their context (the
  model's "Mum's hospital bill" is as valid as the mother).
- Credits were out for a while on 2026-10-17 (429); added back by Phesto.
- Phase 1 exit check DONE (logs/phase1/, `api/scripts/golden/phase1.sh`):
  dropped at routing = 0 on life (34 seeds: 33 statement, 1 mixed),
  synthetic 11/11, hold-outs 1–3 10/10 each (hold-out 3 lost 4 of 10
  before). Old engine after the prompt-example renames: family fixture
  13/13; reset/mother gates failed once (9 of 12 edges) then passed 2/2
  (model variance); live readonly dira_dev 9/13, same four failures as
  step e. Hold-out 4 not seeded (used once, at the gate).
- Phase 2 started: api/src/services/knowledge/extractor.js (claims-v1:
  one gpt-4.1 JSON-schema call, whole vocabulary, known records as
  context, today's date for relative dates) and validate.js (evidence in
  text, names from text or records, amounts the text states). Default
  extractor of ingest(). KNOWLEDGE_TRACE=<file> logs raw/dropped/skipped
  per source (never read hold-out lines). /home/input takes a `source`
  field and, with DIRA_ALLOW_AS_OF=1 (dev only), X-DIRA-As-Of; the runner
  sends both from the set. Hold-outs 1–3 and synthetic expectations now
  carry converted `claims` (scripts/golden/facts-to-claims.mjs).
  First claims numbers (claims-v1, during the routing check: all seeds as
  chat, no asOf): life 65% recall (people 67, work 74, assets 44, money
  63, projects 33, time 100, plans 67); synthetic 78%; hold-outs 1–3
  75 / 67 / 61% (people/time only; their property facts have no
  expectations, so precision there is understated).
- Phase 1 (2026-10-17), behind `KNOWLEDGE_LAYER=claims` (off by default):
  - Claim table (migration 20261017220000_claims, additive), applied to
    dira_dev only.
  - api/src/services/knowledge/: `ingest.js` (one path; chat routed,
    other sources are statements; every statement saved as an Event
    (eventType "note", fullText) and extracted in a per-user queue so
    corrections land in order; `setExtractor` is where phase 2 plugs in),
    `router.js` (question / statement / mixed; when unsure → statement;
    model failure → punctuation fallback that never drops a statement),
    `resolver.js` (one resolver for all entity types: exact name/alias,
    then a unique same-type partial; several partials → new entity with
    mergeCandidates; longer names win and keep the short one as alias),
    `store.js` (shape checks, dates with precision, exact repeats skipped,
    corrections supersede), `materialize.js` (Relationship rows with
    source "claims" + person birth/death dates, so the UI keeps working),
    `settings.js` (flag; KNOWLEDGE_ROUTER_MODEL default gpt-4o-mini,
    KNOWLEDGE_EXTRACT_MODEL default gpt-4.1), `model.js` (JSON-schema call).
  - /home/input: with the flag on, text goes through ingest(); statements
    answer "Saved."; questions and mixed messages are answered by the old
    advisor until phase 3 (mixed responses carry result.saved = true).
  - The hourly old-graph catch-up is skipped when the flag is on.
  - Runner: `npm run golden -- --set <set> --claims [--score-only]` waits
    for every event to be extracted, then scores stored claims per domain
    and prints the gate; routing drops are counted per seed.
  - Tests: api/test/knowledge.test.js (fake extractor, temp user).
  - Exit check still open (needs credits): run the API with
    KNOWLEDGE_LAYER=claims and seed every set; dropped at routing must be
    0 everywhere.
- Phase 0 (2026-10-17):
  - docs/knowledge-layer.md: claim shape, core vocabulary (7 domains),
    derivations, test-set format. Vocabulary in code:
    api/src/services/knowledge/vocabulary.js (domain of every predicate).
  - Synthetic LIFE set api/scripts/golden/sets/life.json (Kenyan narrator,
    34 seeds incl. email/journal/file and 2 Swahili, asOf 2026-06-15, 58
    questions in 8 domains) + api/test/extraction/life.expect.json (108
    claims). It replaces synthetic.json for the new layer; synthetic.json
    stays for the old engines until phase 4.
  - Non-family golden cases live in the life set: cases.js stays Phesto's
    real family because live mode checks it against dira_dev.
  - Hold-out 4 (written by a separate subagent with only the design doc):
    api/test/holdout/holdout4.json + api/test/extraction/holdout4.expect.json.
    Sealed: never read. Shape check, counts only:
    `node api/scripts/golden/check-set.mjs <set> <expect>` → 38 seeds, 158
    claims (people 26, work 29, assets 25, money 30, projects 12, time 21,
    plans 15), 39 questions (4–5 per domain), 0 problems. Its generator
    script was deleted unread.
  - Claims scorer api/scripts/golden/claims.js (`scoreClaims`, `gate`):
    per-domain recall/precision; inverses (received_from = paid),
    symmetric predicates, dates at stated precision, amounts ±0.5%,
    corrections must be marked superseded. Tests: api/test/claims-score.test.js.
  - Runner: seeds may be { text, source }; questions carry a domain and
    print "domains: …" per run; `amounts` expectation (mentionsAmount in
    cases.js); sets `life` and `holdout4` registered. asOf is read but the
    API does not use it yet (phase 3).
  - Contamination test covers life + holdout4 and prints "<hold-out
    text>" instead of any hold-out word. Old prompt examples used
    Portuguese/Peruvian invented names that clashed with hold-out 4; they
    are now Icelandic invented names (no other change to the prompts).
- Earlier: extraction measurement finished 2026-10-17 19:29 UTC. Extraction measurement finished 2026-10-17 19:29 UTC
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

## Cost estimate (2026-10-17, before phase 2)
Assumptions, to be re-measured once the phase 2 prompt exists: extraction
prompt ~3,500 tokens (instructions + vocabulary + schema) + the text;
output ~400 tokens for a chat message; OpenAI list prices as last known
(gpt-4.1 $2.00/M input, $0.50/M cached input, $8.00/M output; gpt-4o-mini
$0.15/M in, $0.60/M out). Check the pricing page before relying on them.
- Per save: about $0.010 (≈ $0.005 when the fixed prompt is cached);
  router about $0.0001.
- Re-ingesting Phesto's account as it is in dira_dev (50 events, 22k
  characters, one 13k-character document): about 180k input + 25k output
  tokens ≈ $0.55. An account 20× larger ≈ $11.
- Harness: one claims run of the life set (34 seeds) ≈ $0.35; hold-out 4
  (38 seeds) ≈ $0.40; three runs over all sets ≈ $5 plus answers.
The model is a setting (KNOWLEDGE_EXTRACT_MODEL).
Measured on the life set (claims-v1 trace): 2,330 input + 270 output
tokens per source ≈ $0.007 per save with gpt-4.1; the account re-ingest
estimate drops to about $0.40.

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
1. When credits are back: re-run the family golden fixture (prompt
   example renames) and the phase 1 routing check on all sets.
2. Phase 2: the claims extractor (schema, gpt-4.1, whole vocabulary,
   related_to escape hatch), validation invariants, corrections; score
   on the life set and hold-outs 1–3 (old expectations need claims
   versions), then the gate on hold-out 4.

## Open questions for Phesto
- Hold-out 4 diagnosis (2026-10-17, one inspectable run, logs/phase2/diag4/):
  58 misses. Scorer bug: an expected owns used up the sold claim in the
  direct pass (2 sales lost). Two-writer conventions: contractor_for vs
  works_on doubled (5), descriptive value on costs (5), milestone text in
  value vs label (3), relative_of direction, expires_on/renews_on,
  happened/scheduled, differently worded entity names and contexts. Real
  extraction failures: codes in names (lot, plates: 9 claims), kin words
  stored as relative_of instead of parent_of, a birth as a date on the
  parent claims, moves, employers of boss/colleague, paid vendors not
  contractors, co-owned lot reversed, client_of reversed, correction
  without its start year. Rescored with the fixed scorer: 63% → 77%
  (people 85, work 69, assets 60, money 90, projects 83, time 71,
  plans 87). Fixes: scorer families + sharing (docs/knowledge-layer.md),
  extractor v6, and a "Conventions" section in the design doc that every
  writer and the extractor follow.
- Running: v6 (tmux `phase2`, logs/phase2/v6/): life, hold-out 4 ×2 (dev),
  hold-outs 1–3. Subagents writing: hold-out 5 (sealed, culture not used
  before), dev2 (India), dev3 (Germany), from the design doc only.
- DECIDED 2026-10-17 (Phesto): option 1. Hold-out 4 is now a diagnostic
  set (may be read); hold-out 5 + 2 dev sets by fresh subagents after the
  diagnosis and any design-doc clarification.
- (was) Phase 2 gate failed (62% vs 85%). Process says stop. Options:
  (1) hold-out 4 is now spent as a gate: use it as a diagnostic set
  (read its misses to separate convention mismatches from real
  extraction failures), have a fresh subagent write hold-out 5 for the
  next gate, and add 2–3 more whole-life dev sets written by separate
  subagents so tuning is not fitted to one life and one author;
  (2) stop the rebuild here. Recommendation: (1).
- OpenAI credits ran out (429 "no credits remaining"). Model-dependent
  work (golden runs, extraction, cost check) waits until they're added.
- Live non-family check: the golden live run can only test facts that
  are true in your account. If you give 5–10 true facts/questions about
  your projects, money and documents (e.g. the Kisarawe renovation),
  they become live cases; until then non-family is tested only on the
  synthetic life set and hold-outs.
