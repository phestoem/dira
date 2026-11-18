# personal — progress

Last updated: 2026-11-18 (evening)

## Current goal
DIRA for Phesto only: stability and low cost (docs/PERSONAL_SCOPE.md).
Order (Phesto, 2026-11-18): backup → keys → graceful model failure →
personal data out of main's source into the database → the rest of the
plan. One item per commit, family golden test before each commit.

## Done (with commit hashes)
- 2026-11-18 22:07: dira backup installed on this host (local copy only).
  - Scripts in /opt/qusaz/shared/backup/dira/; settings in
    /opt/qusaz/shared/backup/dira/dira-backup.env (600), not /etc/qusaz:
    no sudo. Cron passes DIRA_BACKUP_ENV. NUC_TARGET and
    RESTIC_REPOSITORY empty → skipped.
  - First backup: dira_20261118_220743.dump, 81741 bytes, 10 tables with
    data, ok (/opt/qusaz/backups/dira/last_status.json, backup.log).
  - Restore test SOURCE=local: PASS, every table's row count equal to
    live, 7 migrations, scratch db dropped (last_restore_test.json,
    restore-test.log).
  - Cron (qusaz): 02:30 daily backup; 04:00 on the 1st restore test with
    SOURCE=local (switch to r2 once R2 exists). Old crontab saved in the
    session scratchpad.
  - NUC key generated: ~/.ssh/dira_backup_ed25519 (public key to go on
    the NUC).
- 2026-11-18 `4fe1792`: journal sealed by default, per-entry "Share with Altimetrix"
  (Phesto: default off; only toggled entries go through the bridge;
  confirmed-people rule applies).
  - PATCH /journal/:id { sharedWithAltimetrix }; GET/POST return
    sharedWithAltimetrix + sentToAltimetrixAt. Journal page: a switch under
    each entry, "Sent to Altimetrix" once sent.
  - Migration 20261118210000_journal_share_sent adds
    diary_entries.sentToAltimetrixAt (applied to dira_dev; prod needs
    `prisma migrate deploy` on deploy).
  - sendJournalEntry: eventType "journal", sourceEventId journal:<id>
    (Altimetrix dedupes on it), title = first line (80), context = text
    (2000), unconfirmed people → "someone", people []. Sent after the
    answer with the bridge retries; a failure stays unsent and
    syncPendingEvents sends it later.
  - New flag DIRA_BRIDGE_JOURNAL (default on) is the global switch; off
    keeps the toggles but sends nothing.
  - Leak closed: a vision detected in a sealed journal entry used to ask
    Altimetrix for context with its tags and place (enrichVision). It now
    does that only for a shared entry, i.e. never at creation.
  - test/journal-share.test.js (stub Altimetrix + model), 7 checks; the
    vision check fails on the old code. npm test 38/38; golden fixture
    12/12 + reset gate (logs/golden-journal-fixture.log); live readonly
    11/12 twice, `properties` (known flake, answer path untouched)
    (logs/golden-journal-live*.log); zero 5xx.
- 2026-11-18: api/test fixtures synthetic (Phesto: golden cases stay real).
  - contamination test now scans api/src, api/test and web/; golden
    (api/scripts/golden) is exempt. The identifier list moved to
    api/scripts/golden/personal.js so the test file itself is clean, and
    gained a surname misspelling, a middle name, four Tanzanian names and
    one first name found in graph.test.js (all in dira_dev records).
    Helsinki is replaced in tests but not listed: Europe/Helsinki is the
    configured time zone in src.
  - graph.test.js: 664 name/place/plot replacements (same invented
    mapping as src), expected lists re-sorted, three generic questions
    reworded (they equalled golden turns), every year shifted back 3
    (except retry delays in ms). Day and month are unchanged.
  - npm test 31/31; golden fixture 12/12 + reset gate
    (logs/golden-fixtures-fixture.log). No src change.
- 2026-11-18 `c23e636`: saves never wait for Altimetrix(Phesto: "fetch it only when
  answering, or attach it in the background").
  - understandText/understandFile return as soon as the model (or the
    plain-note fallback) has understood; the context fetch starts in the
    background. attachAltimetrixContext(queueId, understood) adds it to
    the stored preview (queue row) when it arrives; the queue panel shows
    it from there. The first preview card no longer shows it.
  - Wired at the four places that store a preview (intake, home x2,
    email).
  - test/flags.test.js: Altimetrix holds the context request; the save
    still returns, and the context lands on the queue row after release.
  - npm test 31/31; golden fixture 12/12 + reset gate
    (logs/golden-ctx-fixture.log); live readonly 11/12 twice, `properties`
    (the known flake: the model's list left out one property; the answer
    path is not touched by this change) (logs/golden-ctx-live*.log).
- 2026-11-18 `034ae4f`: pause flags + simplified bridge.
  - api/src/services/flags.js: DIRA_BRIDGE (default on), DIRA_AUTO_EXTRACT,
    DIRA_GRAPH_REBUILD, DIRA_FACT_CHIPS (default off). on/off/true/false/
    1/0/yes/no; anything else keeps the default. Logged at startup and in
    /health (`flags`).
  - DIRA_AUTO_EXTRACT=off pauses automatic extraction for every user,
    whatever their graphAutoExtract setting; it covers saves, journal,
    visions and the passive conversation extraction (all go through
    autoExtractOn). Stated + confirmed connections still save.
  - DIRA_GRAPH_REBUILD=off: POST /graph/rebuild answers 409, the hourly
    catch-up skips. Reset still works.
  - DIRA_FACT_CHIPS=off: no model call, no chips (home and advisor).
  - Bridge: DIRA_BRIDGE=off makes bridgeConfig() null, so nothing goes
    out. When on, only confirmed people leave DIRA: a person record counts
    as confirmed when it is the self or has a confirmed entity–entity
    relationship. Other names are dropped from `people`/`entityNames`/
    topics and replaced by "someone" in title, context, hint and query.
    Names of places, projects etc. still go. Sends run after the save
    (setImmediate, as before), retry 3x on network/429/5xx (2 s, 4 s),
    8 s timeout each; on failure the event stays unsent for the next sync.
    The context fetch times out at 3 s instead of 8 s; so does the nudge. Altimetrix replies are only attached as
    context; nothing it returns writes records (it suggests no people
    today, so there is nothing to route to confirmation yet).
  - test/flags.test.js (local stub plays Altimetrix and the model).
    graph.test.js's per-user auto-extract test turns the global switch on.
  - npm test 30/30; golden fixture 12/12 + reset gate
    (logs/golden-flags-fixture.log); live readonly 12/12
    (logs/golden-flags-live.log); zero 5xx in the API log.
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
- Nothing running. Web deps installed in dev (web/node_modules, for tsc).
- Backup proposal written (ops/backup/), waiting for Phesto to apply it on
  the host: scripts to /opt/qusaz/shared/backup/dira/, /etc/qusaz/dira-backup.env,
  NUC ssh key, R2 bucket + token, restic install + init, two cron lines
  (02:30 daily, 04:00 on the 1st). Steps in ops/backup/README.md.

## Latest scores
2026-11-18 evening, `personal` + journal sharing, dev API on 4801:
- npm test: 38/38.
- Family golden fixture: 12/12 + reset gate (logs/golden-journal-fixture.log).
- Live readonly on dira_dev: 11/12 twice, `properties` (known flake).

Baseline: 2026-11-18, `personal` at 570df39 (= main = prod code), dev API on 4801:
- npm test: 17/17.
- Family golden fixture: 12/12 + reset gate (logs/golden-personal-baseline.log).
- Live readonly on dira_dev: 11/12, `properties` fails
  (logs/golden-personal-live.log).
For comparison, `fix/people-answers` today: fixture 10/13 (children
missing after the introduction), the same without its last change.

## Decisions made and why
- 2026-11-18 (Phesto): "for the backup and restore test, you may read the
  dira database and create/drop dira_restore_test". Not yet in CLAUDE.md
  (my edit was blocked by the permission check; Phesto to add it).
- 2026-11-18 (Phesto): base on `main`; bridge stays on, simplified;
  digest and nudges stay; nothing removed; backups to the other NUC +
  restic to Cloudflare R2 (7 daily + 4 weekly, monthly restore test);
  key limits dev $25/month hard, prod $20/month with alerts at 50% / 80%.
  Details in docs/PERSONAL_SCOPE.md.

## Next steps
Phesto (2026-11-18): before token logging, the backup + restore test and
the dev/prod key split must be done. Re-checked 2026-11-18 evening after
Phesto said both were applied: still not on this host, token logging held.
- Backup (later the same evening: installed, local only, see Done; NUC +
  R2 still missing). At the check: no /opt/qusaz/shared/backup/dira/, no
  /etc/qusaz/, no restic, no dira cron line. The only backup cron is the old
  /opt/qusaz/shared/postgres/backup.sh (02:00), and its dumps in
  /opt/qusaz/backups/ contain no dira database. No restore-test result.
- Keys: dira-dev/api/.env and dira/api/.env (prod EnvironmentFile) still
  share the OpenAI and the Groq fingerprints; both files unchanged since
  Oct 15/16; dira-api running since Nov 14.
Checked 2026-11-18 (read-only, earlier):
- Backup: NOT installed. No /opt/qusaz/shared/backup/dira/, no
  /etc/qusaz/dira-backup.env, no cron line, no restic. Needs Phesto
  (host, NUC ssh key, R2 bucket + token): ops/backup/README.md.
- Keys: NOT split. Dev and prod OpenAI keys have the same fingerprint, and
  so do the Groq keys. Needs Phesto to create the keys (dev $25/month hard
  limit; prod $20/month, alerts at 50%/80%); then I put the dev key in dev
  .env only.
1. Once backup + keys are done: the rest of the plan, in its order (docs/PERSONAL_SCOPE.md section 7):
   token/latency logging, cherry-pick beb392c, code answers
   for people questions + date precision, My people page, open-question
   path, deploy script.

## Open questions for Phesto
- Backup off-site: NUC hostname + backup user with the public key from
  ~/.ssh/dira_backup_ed25519.pub; R2 bucket dira-backups + token (put the
  values in the env file yourself); then I install restic (static binary,
  no sudo), restic init, an R2 restore test, and cron SOURCE=r2.
- Keys: still not split (same fingerprints dev/prod). Token logging waits.
- CLAUDE.md: add the backup exception for the dira database.
- Journal sharing masks only names that are person records and not
  confirmed. A name with no record at all goes out as written. Mask all
  capitalised names that are not confirmed people too (safer, mangles
  places)?
- Altimetrix has no delete: turning sharing off after a send stops
  nothing already sent. Want a delete endpoint on the Altimetrix side?
- The schema said diary rawContent "is stored encrypted"; it is plain
  text (decrypt() is a no-op). Comment corrected; encrypt at rest?
- When deploying: set DIGEST_FROM in prod .env (the digest sender was your
  own address in code; the default is now dira@qusaz.com).
