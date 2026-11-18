# DIRA personal scope: plan

2026-11-18. Plan; Phesto's decisions of 2026-11-18 are folded in (see "Decisions" at the end). DIRA serves one person (Phesto). The goal is stability and low cost,
not general extraction. Personal data lives only in the database, never in prompts, source code or docs.

## 1. Base

**What runs where**
- Prod (`/opt/qusaz/dira`, port 4800) runs `main` at `570df39`. The local merge `30b61fe` on top of it only differs
  in two package-lock files. Since then prod has seen no saves (no events, diary entries, visions or queue items since
  18 Oct). Credit errors hit users on 23 Oct and 18 Nov 13:36, when a question got a 503.
- `fix/people-answers` is 36 commits ahead of `main`. About 6 of them touch the people engine
  (rules / tools / hybrid); about 30 are the general knowledge layer (claim store, extractor v1–v11, test sets,
  scorer) and its docs.

**Proposal: build the personal version on `main`, in a new branch `personal`.**
`main` is what prod has run for a month. The branch's people and engine changes were validated on golden sets and
hold-outs but never in prod, and the knowledge layer is the general direction we are leaving.

The one big thing the branch fixed is personal data in source. `main` still has about 37 occurrences of family
names, places and plot names in 8 files (prompt examples, regexes, two web components). On `main` that is a scrub
(item 2 in the order), not a cherry-pick: the branch did it inside large refactors.

**Commits worth bringing over**

| Commit | What | How |
|---|---|---|
| `beb392c` | relationship cards show exactly what was saved; "my mother"/"my wife" need a relative of matching gender; pronouns never become people | cherry-pick (first branch commit, sits on `main`) |
| `7d26524` (part) | `api/src/metrics.js` + its hook in `index.js`: per-request model calls, latency, answer path (`x-dira-metrics`) | cherry-pick those two files only |
| dira-b4's step 4 (uncommitted on the branch) | per-call token counts (input / cached / output / reasoning, input split into instruction / context / message) | port `callTokens()` from `knowledge/model.js` and wrap `main`'s model calls with it |
| `6359ed4` (part) | `api/test/contamination.test.js`: fails if a golden sentence or a personal name is in `src/` | take the test file, adapt the set list to `main` |
| `d5346b9` (part) | `graph/dates.js` `datesIn`: one date grammar (ISO, d/m/y, month names in 18 languages via Intl) | take the file if item 9 needs to read dates in questions; otherwise skip |
| `fbc2490` | catch-up for saves whose extraction failed | idea only: it belongs to the claim store. With automatic extraction paused it is not needed; item 6 covers failed calls |
| date precision | the branch shows year-only dates as a year (peopleTools `edgeDay`); `main` stores a bare year as 1 January | small new change on `main`: keep `startPrecision`/`endPrecision` in relationship and entity attributes and print at that precision |

The golden harness on the branch (`scripts/golden/run.js` with `--score-only`, metrics, amounts) is test tooling,
not deployed code. Its family cases (`cases.js`) can come over with the contamination test.

## 2. People as records

**Today on `main`**
- People are `Entity` rows (`entityType` "person", `birthDate`, `deathDate`, `aliases`, `kind`). Family links are
  `Relationship` rows (`parent_of`, `spouse_of`, `sibling_of`…) with `status` suggested / confirmed / rejected and
  `validFrom`/`validTo` for marriages.
- Chat statements like "my sister X was born…" go through `relationship_add` to a relationship card, and only
  "Confirm" saves them as confirmed (`/home/confirm`).
- The API already has the edits a people page needs:
  - `PATCH /graph/entities/:id` (name, aliases, kind, birthDate, deathDate)
  - `PATCH /graph/relationships/:id` (type, label, status, validFrom, validTo, attributes)
  - confirm, reject, merge, separate
- `/family` shows the tree and can add a member, but cannot edit or confirm. `/entities/[id]` can confirm, reject
  and merge.

**Proposal**
- **One "My people" page** replacing `/family`: one row per person with relation, birth/death dates (at their
  precision), aliases and status. Edit in place; confirm or reject suggested links; merge duplicates; add a person.
  It needs no new API, and it gives one place to clean up the messy child records in dira_dev and prod.
- **The model may suggest, never save.** Every model-made fact (cards from chat, any extraction) is a suggestion:
  either a card in chat or a "Suggested" section on My people. Only Phesto's confirm or edit makes it a record.
  Answers read confirmed records first, and say when they use an unconfirmed suggestion.
- **Code only works on records.** No names in code: kinship words map to relation types through the generic
  vocabulary, and everything specific comes from the database.

## 3. Answer path

**People questions: code, no model call.** Who is my X, list my children, when was X born, how old is X, eldest or
youngest, how many, family tree, who is married to whom. A small code router decides "people question" from the
kin vocabulary plus names of confirmed people in the database (no name lists in source). The answer is formatted
from confirmed records with dates at their stated precision. If the records do not hold the answer, it says so.

**Open questions: one model call with small context.**
- A compact profile, built by code: self, close family, current projects and assets, about 250 tokens.
- The top 5 relevant notes from Postgres full-text search over event titles, text and journal (`simple`
  dictionary, so English and Swahili both work). No embeddings are needed to start; the pgvector columns exist if
  search turns out weak.
- The last 4 turns and the question.
- Never the full history, never all events.

**Calls per message.** Today every message costs a 1.7k-token router call and a fact-chip call. In the personal
version, code routes clear questions and clear statements. A small model router (about 250 tokens) runs only when
code can't tell. Fact chips are paused (item 4).

**Estimated tokens per question.** Measured from `main`'s fixed prompt sizes and dira_dev data volumes, not from
runs. Item 6's logging will measure it for real.

| | `main` today | personal |
|---|---|---|
| People question | 2–3 calls, about 2.4k–3.2k input tokens (router 1.7k + fact chips 0.2k + people prompt and context 0.7k when not answered from records) | 0 calls (code); about 250 if the router falls back to the model |
| Open question | 3 calls, about 8k–10k input tokens (router 1.7k + fact chips 0.2k + advisor: 3.2k characters of instructions, 30 events, financial totals over all events, visions, journal, entities, family/graph lines, up to 16 turns; plus up to 40 property events for property questions); about 430 output tokens | 1 call, about 1.4k input tokens (instructions 250 + profile 250 + 5 notes about 600 + 4 turns about 300); about 250 output tokens |
| Saving a note | router 1.7k + understanding 1 call | understanding 1 call (code router); people suggestions only when asked |

That is roughly 85% fewer input tokens on open questions and no model at all for people questions.

## 4. Pause list (code kept, each behind a flag, default off)

| What | Today | Flag |
|---|---|---|
| Altimetrix bridge | **stays on** (decision), simplified, see below | `DIRA_BRIDGE` (default on) |
| Automatic extraction | per-user `graphAutoExtract` (off for Phesto) + `GRAPH_AUTO_EXTRACT` | keep both. Add `DIRA_AUTO_EXTRACT=off` as a global switch that also covers the passive conversation extraction (`looksRelational`) |
| Graph rebuilds | `/graph/rebuild`, rebuild after reset, hourly catch-up (runs only for users with auto-extract on) | `DIRA_GRAPH_REBUILD=off`: the endpoint returns 409, and the catch-up skips |
| Fact chips | `extractConversationalFacts` on every question; `detectSignificantFacts` on the advisor page | `DIRA_FACT_CHIPS=off`: no call, no chips |
| Digest, nudges | **stay on** (decision) | none for now |

**The bridge, simplified (decision)**
- DIRA → Altimetrix: events, journal and documents, as now.
- Altimetrix → DIRA: read-only context for answers. It never writes people records; anything it suggests about
  people arrives as a suggestion for Phesto to confirm.
- Only confirmed people records are shared, never unconfirmed ones.
- Async with retries; a bridge failure never blocks a save or an answer.
- Behind `DIRA_BRIDGE`, default on. Nothing is removed.

## 5. Park list

Branch `fix/people-answers` becomes `park/knowledge-layer` (tagged, never merged), with `LESSONS.md` at its root.

**What is parked**
- Claim store and `ingest()` (`api/src/services/knowledge/`, migration `20261017220000_claims`).
- Extractor v1–v11, the tools and hybrid engines, the schema people extractor.
- Test sets: life, dev2, dev3, hold-outs 1–4 (inspectable), and **hold-out 5, still sealed for a future general
  gate**.
- Claims scorer and phase scripts, architecture review, design doc.

**LESSONS.md, short**
- Routing dropped facts before any model saw them (hold-out 3 was capped at about 53%). One ingestion path fixed
  that.
- Tuning on one author's set does not generalise. The life set scored 87%, but a stranger's life scored 62%. A
  diagnosis split that gap into scorer and convention mismatches between two writers versus real extraction
  failures.
- Expectation conventions must be written down before anyone writes a set (the Conventions section).
- Model choice mattered more than prompt rules: gpt-4.1 at about 75% vs gpt-5.5 at about 85–90% on fresh-author
  sets.
- Generality bugs only showed on foreign data: lakh/crore amounts, German dates and names, corrections hitting
  several claims, postponed deadlines.
- Cost and operations: about 4.2k input tokens per save with gpt-5.5. Dev and prod shared one key and ran dry
  twice. A failed call must never lose a save.
- Hold-out discipline: seal, shape-check by script, use once, mask in tests.

## 6. Stability

- **Separate keys.** Dev and prod use the same OpenAI key and the same Groq key today (fingerprints match), so dev
  runs spend prod's credit. That is how prod failed on 18 Nov.
  - A prod key with its own monthly budget and an alert.
  - A dev key with a small hard limit.
  - Phesto creates the keys. I change only dev's `.env`; prod's is Phesto's.
- **Graceful model failure.**
  - Treat `insufficient_quota` (no credit) separately from rate limits. Today both look like "busy, retry".
  - People questions keep working: code needs no model.
  - Open questions answer "AI answers are unavailable right now" plus the matching profile lines and notes.
  - A save never depends on the model: if understanding fails, the text is stored as a note with a title taken
    from the text.
  - `/health` reports the last model error and when it happened.
- **Backups (decision): nightly `pg_dump` of `dira` to the other NUC, plus a nightly encrypted restic copy to
  Cloudflare R2; keep 7 daily + 4 weekly; monthly restore test into a scratch database.** The backup script is
  outside dira-dev, so I write the change and the restore test as a proposal and Phesto applies it.
- **Key limits (decision):** dev $25/month hard; prod $20/month with alerts at 50% and 80%. Phesto creates the keys.
- Background to the backup item:
  - The `dira` database is **not** in `/opt/qusaz/shared/postgres/backup.sh`. That script backs up fomu, jumuiya,
    estateiq, choirly_staging and nexus, so prod DIRA has no backup today.
  - Add `dira`, keep 7 days locally, and copy off the machine.
  - Weekly restore test: restore the newest dump into a scratch database (`dira_restore_test`), compare row counts
    per table against prod, run the family golden test read-only against it, then drop it.
  - The shared script is outside dira-dev, so it is Phesto's change, or done with explicit permission.
- **Family golden test before every deploy.** A deploy script refuses to deploy unless these pass:
  - `npm test` (including the contamination test);
  - `npm run golden` (fixture);
  - a live read-only run against dira_dev.
  After the deploy, it runs a read-only check against prod (`--allow-prod-readonly`).
- **Per-request token and latency logging.** One log line per request: path, number of model calls, per call
  model / input / cached / output / reasoning tokens, and latency. Built from item 1's `metrics.js` + `callTokens`.
  A daily total goes to the log (and optionally to `/health`).

## 7. Effort and order

One session is about half a day of work plus Phesto's review.

| # | Item | Effort | Why this order |
|---|---|---|---|
| 1 | Backup `dira` nightly + off-machine copy + restore test (needs Phesto: shared script) | 0.5 | no backup of prod today: biggest risk |
| 2 | Separate prod and dev keys with limits (Phesto in the dashboard; dev `.env` by me) | 0.25 | stops dev runs from draining prod |
| 3 | Branches: `personal` from `main`; park `fix/people-answers` as `park/knowledge-layer` + LESSONS.md | 0.5 | clean base |
| 4 | Scrub personal data from `main`'s src and web + contamination test | 0.5–1 | your rule; also keeps prompts small |
| 5 | Graceful model failure + `/health` model status | 0.5–1 | prod returned 503 today |
| 6 | Per-request token/latency logging (`metrics.js` + `callTokens`) | 0.5 | measure before and after the answer changes |
| 7 | Pause flags (bridge, auto extraction, rebuilds, fact chips; digest optional) | 0.5 | cuts calls and side effects at once |
| 8 | Cherry-pick `beb392c`; review the confirm cards so every model fact is a suggestion | 0.5 | |
| 9 | Code answers for people questions + date precision; measure `main`'s current coverage on the family golden first | 1–1.5 | biggest token cut |
| 10 | "My people" page (edit, confirm, merge, add) on existing endpoints | 1.5–2 | records you can fix |
| 11 | Open questions: compact profile + full-text top-5 notes, one call | 1–1.5 | second biggest token cut |
| 12 | Deploy script with the golden gate | 0.5 | locks in stability |

**Total: about 8–10 sessions.** Items 1, 2 and 5 can ship to prod first on their own. Items 9–11 should be measured
with item 6's logging, before and after, on the family golden plus 10 fixed open questions.

**Decisions (Phesto, 2026-11-18)**
- Base on `main`. Commit dira-b4's token logging and this plan on `fix/people-answers` first, then create
  `personal` from `main`.
- Bridge stays on, simplified (section 4). Digest and nudges stay. Nothing is removed.
- Backups and key limits as in section 6.
- Order: backup → keys → graceful model failure → move personal data out of `main`'s source into the database →
  the rest of the plan. One item per commit, family golden test before each commit.
