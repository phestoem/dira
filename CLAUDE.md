# DIRA — working rules
- Work only in /opt/qusaz/dira-dev, database dira_dev,
  API port 4801. Never touch /opt/qusaz/dira, the
  dira database, port 4800, or the dira-api/dira-web
  systemd services.
- Never print or copy secrets from .env.
- Commit to branch fix/people-answers. Don't push to
  main; I merge after review.
- Before saying something is fixed, prove it with
  npm run golden (fixture mode) and a live readonly
  run against dira_dev.
