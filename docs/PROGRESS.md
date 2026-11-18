# personal — progress

Last updated: 2026-11-18

## Current goal
DIRA for Phesto only: stability and low cost (docs/PERSONAL_SCOPE.md).
Order (Phesto, 2026-11-18): backup → keys → graceful model failure →
personal data out of main's source into the database → the rest of the
plan. One item per commit, family golden test before each commit.

## Done (with commit hashes)
- 2026-11-18: personal data out of main's source.
  - test/contamination.test.js fails on any name, place, identifier or
    golden sentence from Phesto's records in api/src or web/ (words from
    the golden cases + a list of identifiers the cases do not mention).
    It found 57 lines in 10 files.
  - Place lists hardcoded in two regexes (command hints, Altimetrix
    topics) now come from the user's own place entities
    (src/services/userPlaces.js, cached 5 min). dira_dev has 28 places,
    covering 8 of the 10 old names.
  - Prompt examples and comments use invented names, places, dates and
    identifiers (none of them is executable logic).
  - Web examples (command bar, advisor) are generic.
  - Digest sender is DIGEST_FROM (default "DIRA <dira@qusaz.com>").
    **Prod .env needs DIGEST_FROM set to keep the old sender.**
  - Left as configuration: the Europe/Helsinki time zone of cron and
    digest (a later setting).
  - npm test 21/21; golden fixture 12/12 + reset gate; live readonly
    11/12. `properties` is flaky: the model-written answer sometimes
    omits one property, 1 of 2 re-runs passed; the same failure is in the
    baseline. Code answers (plan items 9/11) fix it.
- 2026-11-18: graceful model failure (see commit after be9fe57).
  - api/src/services/modelStatus.js tells no credit / rate limit / bad key /
    timeout / unavailable apart, gives the user-facing message, and keeps
    each provider's last success and failure for /health (`models`).
  - Advisor and router try Groq on every OpenAI failure (a credit error
    used to skip Groq and return 503 "busy").
  - Open questions answer with the reason + matching records instead of
    a 503; people questions already fall back to code.
  - A save never depends on the model: intake falls back to a plain note
    to confirm; relationship statements whose extraction fails go the
    same way.
  - Fact chips fail quietly.
  - OpenAI/Groq URLs are configurable (OPENAI_BASE_URL, GROQ_BASE_URL) for
    stub tests.
  - npm test now runs every test file (it ran graph.test.js only): 19/19,
    with test/model-failure.test.js (local stub: OpenAI out of credit,
    Groq down).
  - Dev API under that stub: golden fixture 11/12 + reset gate with no
    model at all (properties needs the model; it got the graceful reply),
    zero 5xx.
  - Real models: fixture 12/12 + reset gate, live readonly 12/12. A real
    OpenAI timeout + Groq network blip during the live run fell back to
    the heuristic router and the case still passed.
- 2026-11-18: backup proposal ops/backup/ (dira-backup.sh,
  dira-restore-test.sh, env example, README). Tested on dira_dev only:
  retention by count, weekly hard links, restore PASS with all row counts
  equal (pgvector from the dump), failure paths exit 1 with the local dump
  kept. NUC and R2 steps untested (no access). Golden before commit: 12/12
  + reset gate; npm test 17/17.
- 2026-11-18: branch `personal` created from `main` (570df39), upstream
  origin/personal (it had defaulted to origin/main; fixed).
- On `fix/people-answers` (parked line): `881b83f` per-save token logging
  (dira-b4), `f341992` PERSONAL_SCOPE.md + decisions.

## In progress
- Backup proposal written (ops/backup/), waiting for Phesto to apply it on
  the host: scripts to /opt/qusaz/shared/backup/dira/, /etc/qusaz/dira-backup.env,
  NUC ssh key, R2 bucket + token, restic install + init, two cron lines
  (02:30 daily, 04:00 on the 1st). Steps in ops/backup/README.md.

## Latest scores
2026-11-18, `personal` at 570df39 (= main = prod code), dev API on 4801:
- npm test: 17/17.
- Family golden fixture: 12/12 + reset gate (logs/golden-personal-baseline.log).
- Live readonly on dira_dev: 11/12, `properties` fails
  (logs/golden-personal-live.log).
For comparison, `fix/people-answers` today: fixture 10/13 (children
missing after the introduction), the same without its last change.

## Decisions made and why
- 2026-11-18 (Phesto): base on `main`; bridge stays on, simplified;
  digest and nudges stay; nothing removed; backups to the other NUC +
  restic to Cloudflare R2 (7 daily + 4 weekly, monthly restore test);
  key limits dev $25/month hard, prod $20/month with alerts at 50% / 80%.
  Details in docs/PERSONAL_SCOPE.md.

## Next steps
1. Phesto applies the backup proposal; first manual run + restore test
   from R2 should show ok/PASS.
2. Keys: skipped for now (Phesto, 2026-11-18).
3. The rest of the plan, in its order (docs/PERSONAL_SCOPE.md section 7):
   pause flags, token/latency logging, cherry-pick beb392c, code answers
   for people questions + date precision, My people page, open-question
   path, deploy script.

## Open questions for Phesto
- When deploying: set DIGEST_FROM in prod .env (the digest sender was your
  own address in code; the default is now dira@qusaz.com).
