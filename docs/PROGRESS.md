# personal — progress

Last updated: 2026-11-18

## Current goal
DIRA for Phesto only: stability and low cost (docs/PERSONAL_SCOPE.md).
Order (Phesto, 2026-11-18): backup → keys → graceful model failure →
personal data out of main's source into the database → the rest of the
plan. One item per commit, family golden test before each commit.

## Done (with commit hashes)
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
2. Keys (Phesto creates; dev .env updated here).
3. Graceful model failure.
4. Personal data out of main's source into the database.

## Open questions for Phesto
- None yet.
