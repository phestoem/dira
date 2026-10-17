# DIRA — working rules
- Work only in /opt/qusaz/dira-dev, database dira_dev,
  API port 4801. Never touch /opt/qusaz/dira, the
  dira database, port 4800, or the dira-api/dira-web
  systemd services.
- Never print or copy secrets from .env.
- Commit to branch fix/people-answers. Don't push to
  main; I merge after review.
- Before every commit, check that the current branch is
  the working branch, never main.
- Before saying something is fixed, prove it with
  npm run golden (fixture mode) and a live readonly
  run against dira_dev.

## Session continuity
- At the start of every session, read docs/PROGRESS.md
  before doing anything else.
- Keep docs/PROGRESS.md updated as you work: after each
  milestone, test run, decision, or before any long
  command. Sections:
  - Current goal
  - Done (with commit hashes)
  - In progress (what was running, how to check if it
    finished, where its output is)
  - Latest scores (date, engine, set, mean/min)
  - Decisions made and why
  - Next steps
  - Open questions for Phesto
- Long runs (>5 min) go inside a tmux session or nohup
  with output written to logs/<name>.log, and the log
  path recorded in PROGRESS.md.
- Commit PROGRESS.md with each milestone commit.
