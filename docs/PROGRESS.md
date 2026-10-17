# fix/people-answers — progress

Last updated: 2026-10-17

## Current goal
DIRA answers questions about the user's people (family, dates, relations)
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
Nothing running. The dev API is up on 4801 (started by hand with
`node src/index.js` from api/, rules engine). Check with
`curl -s http://127.0.0.1:4801/health`.

## Latest scores
Engine comparison, 2026-10-16/17 at `7d26524`, fixture mode, 3 runs per
engine per set. Mean (min). Raw output was in the 2026-10-16 session
scratchpad (`compare/`, temporary); future runs go to logs/.

| Set | Rules | Tools |
|---|---|---|
| Hold-out 2 (decides) | 6.0/10 (6) | 2.7/10 (2) |
| Hold-out 1 | 4.0/10 (4) | 3.7/10 (2) |
| Synthetic | 10.0/15 (9) | 8.0/15 (7) |
| Family fixture | 12.0/13 (10) | 12.0/13 (12) |

Cost per answer: rules median 1.1–2.4 s, 1.3–1.9 model calls (max 5);
tools median 2.7–3.4 s, 3.1–3.5 model calls (max 6). Tools fell back to the
old advisor in 1 of 147 answers.

Live readonly on dira_dev (family set): 7/13 at `6359ed4`, 9/13 at
`9a68f4b` (single runs). Misses are facts the old pipeline never stored;
needs a re-extraction of dira_dev. Not re-run since `7d26524`.

## Decisions made and why
- Engine is picked by hold-out score; stop adding rules for single cases
  (Phesto, 2026-10-16). Hold-outs are score-only: never inspect individual
  hold-out results or failures.
- Default stays `PEOPLE_ENGINE=rules`: it wins hold-out 2 in every run and
  costs about half the model calls. Tools stays in the code behind the flag.
- No personal data in src/: prompt examples use invented people and places;
  place names come from the user's own entities. Tests and golden cases may
  use the real family.
- Relationship chips count as explicit confirmation, so they are not gated
  by graphAutoExtract (Phesto confirmed).
- The "User has four sisters" event (8a58cc4c) in dira_dev was archived at
  Phesto's request.

## Hybrid plan (Phesto, 2026-10-17)
Long jobs run in tmux with logs in logs/.
- [ ] d. Write hold-out 3 first (a different culture again, before any
  engine changes), score-only.
- [ ] a. Post-check audit (synthetic only, never the hold-outs): sample 30
  removed claims, classify each as a true invention or a wrongly removed
  fact, report the ratio.
- [ ] b. Post-check compares meaning, not text: dates normalised (any
  format → ISO; year-only stays year-only), people compared by resolved
  entity id or alias, not exact string.
- [ ] c. Hybrid engine (`PEOPLE_ENGINE=hybrid`): the model only picks a tool
  and its arguments. List, count, date and family-tree tools return the
  final answer formatted by code from stored facts; the model doesn't
  rewrite it. Open questions ("how is X connected to Y", "tell me about my
  family") get a model-written answer from tool results, post-checked.
- [ ] e. Re-score rules, tools (fixed post-check) and hybrid on family
  fixture, synthetic, hold-outs 1–3, plus live readonly on dira_dev after
  the rebuild. 3 runs each. Pick by hold-out 3.

## Next steps
1. Rebuild the dira_dev graph (approved 2026-10-17); a backup of the first
   forced rebuild exists from 2026-10-16.
2. Hybrid plan above, in the order d, a, b, c, e.
3. Look at why both engines fail synthetic `sister-in-law` and `owned-now`.
4. Later: timezone and default currency become user settings.

## Open questions for Phesto
- None yet.
