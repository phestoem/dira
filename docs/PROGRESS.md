# personal — progress

Last updated: 2026-11-18

## Current goal
DIRA for Phesto only: stability and low cost (docs/PERSONAL_SCOPE.md).
Order (Phesto, 2026-11-18): backup → keys → graceful model failure →
personal data out of main's source into the database → the rest of the
plan. One item per commit, family golden test before each commit.

## Done (with commit hashes)
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
3. Personal data out of main's source into the database.

## Open questions for Phesto
- None yet.
