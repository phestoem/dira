# fix/people-answers — progress

Last updated: 2026-10-17

## Current goal
2026-10-17 (afternoon): measure extraction on its own. All engines score
~3/13 on hold-out 3; extraction is the suspected bottleneck. Per seed:
routing (intake / relationship_add / journal / question / dropped), what
was extracted, what survived validation; scored against expected people,
relations and dates (precision/recall per relation type, dropped at
routing, dropped at validation). Hold-outs: totals only. Then compare a
stronger extraction model (gpt-4o / gpt-4.1 vs gpt-4o-mini) on recall.
Next scoring round adds a 4th combination: rules extraction + tools
answering, judged on the hold-outs.

Background goal: DIRA answers questions about the user's people (family, dates, relations)
and property only from facts it actually stored, and it generalises: the
engine is chosen by hold-out score, not by fixes for single golden cases.
Phesto merges after review; nothing goes to main from here.

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
- Extraction measurement, restarted 2026-10-17 17:55 UTC in tmux session
  `extraction`: `api/scripts/golden/extraction.sh 3` = extractors rules
  and schema × models gpt-4o-mini, gpt-4o, gpt-4.1 × synthetic and
  hold-outs 1–3 × 3 runs (72 fixture seedings, expect ~2.5 h). Progress:
  logs/extraction/summary.txt, one line per run; finished when it ends
  with "== ... done". Driver log: logs/extraction.log. Per-run files:
  logs/extraction/<extractor>-<model>-<set>-<run>.txt (hold-outs: score
  and totals JSON only). Traces logs/extraction/trace-*.jsonl contain
  hold-out items: never read them; aggregate from the per-run files.
- Harness: `npm run golden -- --set <set> --extraction --trace <file>`
  scores the stored graph against api/test/extraction/<set>.expect.json
  (expected facts written 2026-10-17 from seed sentences only; Phesto OK'd
  reading hold-out 1–2 seeds for this). The API must run with
  DIRA_EXTRACT_TRACE=<file>. Each miss gets a stage: routing,
  no-extraction, not-extracted:person|fact, validation:person|fact,
  kept-not-stored. Each run also dumps what it scored to
  logs/extraction/dumps/ (for re-scoring; hold-out dumps never read).
  First attempt (17:47) stopped after 3 runs: its attribution counted a
  person kept without their relation as kept-not-stored; output in
  logs/extraction-aborted-1/.
- New switches: PEOPLE_EXTRACTOR=rules|schema (independent of
  PEOPLE_ENGINE), GRAPH_EXTRACT_MODEL (extraction only).

## Latest scores
2026-10-17, step e, at `15dc8b1`, 3 runs per engine per set, mean (min).
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

## Hybrid plan (Phesto, 2026-10-17)
Long jobs run in tmux with logs in logs/.
- [x] d. (2026-10-17, Korean family, api/test/holdout/holdout3.json, 13
  questions; `--set holdout3`) Write hold-out 3 first (a different culture again, before any
  engine changes), score-only.
- [x] a. Post-check audit (synthetic only, never the hold-outs): sample 30
  removed claims, classify each as a true invention or a wrongly removed
  fact, report the ratio.
  Result (2026-10-17, tools engine at `d55e031`, 3 synthetic runs = 45
  answers): 3 post-checks removed anything, 57 claims, all from "show my
  family tree". Random sample of 30 (seed 20261017): 0 true inventions, 30
  wrongly removed (0:30). Every one was a Markdown heading or role label
  whose meaning was in the tool output ("Parents", "Stepfather",
  "Half-sister", "Former Spouse"); each removal wiped the whole tree,
  because the check split on .!? only, so a whole list was one sentence.
  Audit data: logs/postcheck-audit.jsonl (DIRA_POSTCHECK_AUDIT).
- [x] b. Post-check compares meaning, not text: dates normalised (any
  format → ISO; year-only stays year-only), people compared by resolved
  entity id or alias, not exact string.
  Done: datesIn reads ISO, d/m/y (either order kept ambiguous), d.m.y,
  Korean/Japanese, month names in 18 languages from Intl, "March 2019" as
  a month; a claim must match at the stored precision. Names resolve
  through snapshot aliases; role words, month words and the results' own
  labels are vocabulary; checked per line so lists survive. Replaying the
  3 audited trees: 57 removals → 0. Edge dates stored from a bare year
  (1 January, no precision) are shown as the year.
- [x] c. Hybrid engine (`PEOPLE_ENGINE=hybrid`): the model only picks a tool
  and its arguments. List, count, date and family-tree tools return the
  final answer formatted by code from stored facts; the model doesn't
  rewrite it. Open questions ("how is X connected to Y", "tell me about my
  family") get a model-written answer from tool results, post-checked.
  Done: api/src/services/graph/peopleHybrid.js. Tools: list_people,
  count_people, person_dates, family_tree, who_is, owned_assets (code
  formatted) and open_question (→ tools agent + post-check). who_is with no
  direct link, and owned_assets with no ownership edges, also go open.
  Uses the rules extractor. In-laws derived from the graph; a role word
  passed as a name reads stored roles. Replies are English (code wording).
- [x] e. Re-score rules, tools (fixed post-check) and hybrid on family
  fixture, synthetic, hold-outs 1–3, plus live readonly on dira_dev after
  the rebuild. 3 runs each. Pick by hold-out 3.
  Done 2026-10-17: rules 3.3, tools 3.0, hybrid 2.7 out of 13. Default
  stays rules (see decisions and scores).

## Next steps
1. All engines score at most 4/13 on hold-out 3, and Phesto's questions
   below decide what comes next. Extraction is the likely common cause:
   every engine reads the same kind of stored graph, and the synthetic
   misses that remain are missing entities and edges, not wording.
2. Hybrid gaps seen on the family set (not fixed, pending a decision):
   marriage date in spouse lists, counting assets by type, messy child
   entities on dira_dev.
3. Both engines still miss synthetic `owned-now` (flat and field have no
   ownership edges after extraction).
4. Later: timezone and default currency become user settings.

## Open questions for Phesto
- None yet.
