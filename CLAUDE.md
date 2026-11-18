# DIRA — working rules
- Work only in /opt/qusaz/dira-dev, database dira_dev,
  API port 4801. Never touch /opt/qusaz/dira, the
  dira database, port 4800, or the dira-api/dira-web
  systemd services.
  Exceptions (Phesto, 2026-11-18):
  - Backup and restore test (ops/backup): may read the
    dira database and create/drop dira_restore_test.
  - Deploy: may run /opt/qusaz/dira/deploy.sh, which
    restarts dira-api and dira-web, only after Phesto
    has merged to main. Take a dira backup first; after
    it, check /health on 4800 and run the readonly
    golden check against prod. Never edit files in
    /opt/qusaz/dira or its .env by hand.
- Never print or copy secrets from .env.
- Commit to branch `personal`. Don't push to main;
  I merge after review. Before every commit, check that
  the current branch is the working branch, never main.
- One item per commit; run the family golden test
  (npm run golden, fixture mode) before each commit.
- Before saying something is fixed, prove it with
  npm run golden (fixture mode) and a live readonly
  run against dira_dev.

## Session continuity
- At the start of every session, read docs/PROGRESS.md
  before doing anything else.
- Keep docs/PROGRESS.md updated as you work: after each
  milestone, test run, decision, or before any long
  command. Sections: Current goal; Done (with commit
  hashes); In progress (what is running, how to check it
  finished, where its output is); Latest scores; Decisions
  made and why; Next steps; Open questions for Phesto.
- Long runs (>5 min) go inside a tmux session or nohup
  with output written to logs/<name>.log, and the log
  path recorded in PROGRESS.md.
- Commit PROGRESS.md with each milestone commit.

## Personal scope (Phesto, 2026-11-18)
DIRA serves only Phesto. Goal: stability and low cost,
not general extraction. Plan: docs/PERSONAL_SCOPE.md.
- Personal data lives in the database only: never in
  prompts, source code, tests' src fixtures or docs.
- People are records: the model may suggest, nothing is
  saved without Phesto's confirmation.
- People questions are answered by code from records;
  open questions get one model call with a compact
  profile and a few relevant notes, never full history.
- Nothing is removed; paused features sit behind flags.
- The general knowledge layer is parked on
  `fix/people-answers` (to become `park/knowledge-layer`);
  hold-out 5 there stays sealed.
