# personal — progress

Last updated: 2026-11-19

## Current goal
Now (Phesto, 2026-11-18, from real use): 1 follow-ups attach to the last
save, 2 save confirmations show key fields, 3 link confirmed people by
name/alias without a model, 4 "what should I focus on" answers from dates
and upcoming events. One item per commit, golden before each.

DIRA for Phesto only: stability and low cost (docs/PERSONAL_SCOPE.md).
Order (Phesto, 2026-11-18): backup → keys → graceful model failure →
personal data out of main's source into the database → the rest of the
plan. One item per commit, family golden test before each commit.

## Done (with commit hashes)
- 2026-11-19: people answers read dates only from records.
  - Report for Phesto (read-only, prod dira, details in chat only): on
    records = own birth date, father's death date; nothing else. Only in
    event text = father's birth, 4 sisters' births, wife's birth, the
    marriage date, 5 children's births. The mother is no person record in
    the prod tree (named only in events). dira_dev differs (sisters, wife,
    3 children dated on records; no father record).
  - peopleGrounding: no date parsing from event text (collectDatedNames,
    marriage dates, death/birth fallbacks removed). Event text still gives
    names and roles. Birth/death from the person record; marriage from the
    confirmed spouse_of validFrom. Missing → "birth date not recorded" /
    "marriage date not recorded (yet)". Lists without recorded births keep
    record order.
  - services/graph/statedDates.js: a saved message that states a birth,
    death or marriage date for someone with a person record shows it in
    the save preview ("Also records on their pages: …"); confirm (home or
    /queue) writes it to empty fields only; a different recorded date is
    reported, never overwritten; birth on/after death skipped. Code only.
  - Tests updated to the rule (graph.test.js, death-dates.test.js), new
    test/stated-dates.test.js. npm test 62/62; golden fixture 12/12 +
    reset gate with all dates from records; live readonly on dira_dev
    10/12: family-tree (no father record in dira_dev: dates not recorded,
    as intended until filled) and `properties` (item 3)
    (logs/golden-recorddates-*.log).
- 2026-11-19 19:36: deployed 8225d06 (death-date fix) to prod. main
  fast-forwarded e49c70b..8225d06 (Phesto's go), pushed; prod merged it as
  a379352. Backup first (dira_20261119_193447.dump); no migration; both
  services active; /health ok. Readonly golden against prod 12/12 with
  the new date checks, father's dates right, no rows changed
  (logs/deploy-20261119b.log, logs/golden-prod-readonly-20261119b.log).
- 2026-11-19: prod family tree showed the father born on his death day.
  - Cause (read-only queries on dira, Phesto's go): his entity has no
    birthDate and is unchanged since 16 Oct; the endsAt migration only adds
    a column to events. Two review items (queued 15 Oct) confirmed on
    18 Nov 23:18 became new events; one summary reads "the passing of the
    father, <name>, on <date>". The "<name>, (on) <date>" pattern in
    collectDatedNames skipped only "passed away|died" before the name, so
    "passing" let the death date through as a birth claim, and birthOf
    takes the newest event's claim first. Not the people linking.
  - Fix: that pattern skips dates with a death word before the name
    (passing, late, funeral, buried, death, …) or "passed/died" right
    after the date; birthOf never returns a birth date on or after the
    death date. No prod data fix needed: the new code on prod records
    (read-only) gives the right dates.
  - Golden family-tree: the father's two dates, plus the rule that no
    person's birth date is on or after their death date (answer and
    person records).
  - test/death-dates.test.js (synthetic). npm test 60/60; golden fixture
    12/12 + reset gate; live readonly 11/12 twice, `properties` flake
    (logs/golden-deathdate-*.log).
- 2026-11-19 18:35: deployed to prod. personal fast-forwarded into main
  (8698d0e..e49c70b, Phesto's go), pushed; prod merged it as 86cbe62.
  Backup first (dira_20261119_183327.dump). Migration
  20261118233000_event_ends_at applied; dira-api and dira-web active;
  /health ok. Readonly golden against prod 12/12, no rows changed
  (logs/deploy-20261119.log, logs/golden-prod-readonly-20261119.log).
  - Found: the prod family-tree line now gives the father's birth date as
    his death date; yesterday's prod run and dev live (same code) give the
    right one, so it comes from prod data (own birthDate or a dated record
    matched to him). Golden does not check that date. Not investigated:
    needs a read of the dira database (Open questions).
- 2026-11-19: real-use 4/4, "what should I focus on" answers from dates.
  - services/focus.js: isFocusQuestion (focus on / prioritise / what's
    coming up / next steps / plan my week, two Swahili phrases; code, no
    router call). focusContext: overdue or due (dueAt, not completed),
    under way (started, endsAt ahead), coming up (next 60 days), last 14
    days, each record once in its most urgent section; queue items
    waiting; active visions. Each line is the saved summary + "starts in
    20 days" / "overdue, was due 3 days ago".
  - lifeAdvisor.chat: a focus question gets one model call with that
    context (last 4 turns, temperature 0.3); rules: 3–5 numbered actions,
    each naming the record and its date with days left, no invented
    dates, no generic advice, under 130 words. Without a model, code lists
    the same items as numbered actions.
  - dira_dev check: dated, concrete actions, no generic advice.
  - test/focus.test.js. npm test 57/57; golden fixture 12/12 + reset
    gate; live readonly 12/12.
  - Test hygiene: an earlier npm test run had hung for 18 h and orphaned
    Prisma engines held 50 dira_dev connections (half of the shared
    server's 100); killed (only PPID-1 dev engines), now 6.
  - Real dates from Phesto's examples taken out of src, tests and this
    file (contamination test caught one); the 973dc34 message reworded.
- 2026-11-18: real-use 3/4, confirmed people linked by name, no model.
  - services/peopleLinks.js: confirmed = person record (not self, not
    archived/merged) with a confirmed entity–entity relationship (the
    bridge's rule). Keys: full name, aliases, first name (3+ letters) when
    no other confirmed person shares it; whole words, case/accents folded.
  - Applied at createEventFromUnderstanding (home, /intake, /queue, email
    saves), the follow-up attach, and both journal saves (DiaryEntry.people).
    A plain name that is a confirmed person gets its entityId; people the
    text mentions are added; unknown names stay plain; no record is ever
    created. Linked events show on the person's page (entities.js).
  - dira_dev check (read-only, counts only): 11 confirmed people, 17 keys;
    13 of 44 existing events would link (27 links). Existing events are
    not backfilled.
  - test/people-links.test.js. npm test 52/52; golden fixture 12/12 +
    reset gate; live 11/12 twice, `properties` (model list left out one
    property; answer path untouched) (logs/golden-links-*.log).
- 2026-11-18 `973dc34`: real-use 2/4, save confirmations show key fields.
  - services/savedSummary.js reads the stored event back: "Saved: <title>,
    22 Dec 2026 → 5 Jan 2027, with A and B, 1,200 EUR." People = names +
    linked person records (projects/vehicles left out). Used by home
    confirm, the follow-up attach ("Added to <title> (…). Now: …"), the
    preview line ("This looks like …. Save it?") and /queue/:id/confirm
    (`savedMessage`, used by the web restore path).
  - Events get endsAt (migration 20261118233000_event_ends_at, applied to
    dira_dev; prod gets it on deploy). Understanding gains endDate; the
    model now gets today's date and rules for yearless dates and spans.
  - snapYearless (code): text without any year → start = occurrence
    nearest today, end = first on/after start. Real model before: "3
    November" → 2023, "4 March" appointment → past; after: all 5 checks
    right (a Dec→Jan trip, a November payment, a March appointment,
    visit 2–5 Oct 2026, a stated 2019 kept).
  - npm test 49/49; golden fixture 12/12 + reset gate; live 11/12
    (`properties` flake) then 12/12 (logs/golden-summary-*.log).
- 2026-11-18 `c7d4a9a`: real-use 1/4, follow-ups attach to the last save.
  - services/followUp.js: the last saved event per user (30 min, memory);
    looksLikeContinuation (opener word such as also/and/we'll/returning/
    it's, or a shared word of 4+ letters with the title; no model).
  - /home/input: an intake right after a save (lastAction.saved) that
    continues it returns a clarification "Add to “<title>”?" with
    [Add to <title>] [Save as new]. Add merges into the event: text
    appended, new people added, place/date/amount only if missing; the
    queue row points at the event; reply "Added to <title>: with X,
    1,200 EUR." New returns the preview already made (no second model
    call). Cancel dismisses the queued input.
  - Web: the clarification card shows the offer's question.
  - test/follow-up.test.js (stub understanding, code router). npm test
    45/45; golden fixture 12/12 + reset gate, live 12/12
    (logs/golden-followup-*.log).
- 2026-11-18 23:04: deployed to prod. personal fast-forwarded into main
  (570df39..8698d0e, Phesto's go), pushed; prod merged it as 8a8eaf2.
  - First run stopped at `git pull` (prod main had 25 local merge commits,
    lockfile-only, and no pull strategy); nothing changed. Phesto chose
    `git -C /opt/qusaz/dira config pull.rebase false` (how earlier pulls
    merged). logs/deploy-20261118.log.
  - Backup before: dira_20261118_230316.dump. Second run: merge, migration
    20261118210000_journal_share_sent applied, web build OK, dira-api and
    dira-web active (logs/deploy-20261118-2.log).
  - Prod DIGEST_FROM set by Phesto (a @qusaz.com address).
  - After: /health on 4800 ok, readonly-header, flags as defaults, tokens
    counting. Readonly golden against prod 12/12
    (logs/golden-prod-readonly.log), `properties` passed this time. Prod log
    since restart: zero 5xx, zero errors; 16 model calls, 0 failed.
- 2026-11-18 `660973b`: token + latency logging (Phesto: start before the key split).
  - api/src/metrics.js, measured at fetch (the OpenAI SDK v7 reads
    globalThis.fetch per client; Groq/file/extractor calls use fetch), so
    no call site changed. A model call = default provider host or under
    OPENAI_BASE_URL / GROQ_BASE_URL.
  - One `[tokens]` line per request that used a model: route pattern,
    status, ms, calls, input/cached/output/reasoning totals, then per call
    provider/model, calling function (async stack), tokens, ms, status.
    Calls after the answer (background work) get a `background after
    <route>` line. Requests without a model call are not logged (Fastify
    already logs every request with its time).
  - DIRA_TOKEN_LOG=<file>: the same as JSON lines. Daily totals
    (DIRA_TIME_ZONE, default Europe/Helsinki) logged at the day change and
    in /health `tokens` (today, yesterday, per model; since process start).
  - No content: no prompt, answer, ids in paths (route patterns only).
  - test/metrics.test.js (stub OpenAI/Groq): SDK + direct fetch, background
    line, failed call, Altimetrix on the same host not counted, JSONL,
    daily totals, no content. npm test 39/39; golden fixture 12/12 + reset
    gate (logs/golden-tokens-fixture.log); live readonly 11/12,
    `properties` (known flake) (logs/golden-tokens-live.log); zero 5xx.
  - Dev API now runs with DIRA_TOKEN_LOG=logs/tokens.jsonl.
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
Prod 2026-11-18 23:07 (main 8698d0e): readonly golden 12/12.

First measurement (2026-11-18, dev, both golden runs = 37 /home/input
requests): 55 calls, all gpt-4o-mini, 89,404 input (49,024 cached, 55%),
7,745 output; about 2.4k input per request. Router call 1.8–1.9k input
each (37 of 55 calls), matching the plan's 1.7k estimate.

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
- 2026-11-18 (Phesto): off-site backup parked: no NUC mirror, no R2 for
  now. The local nightly backup + monthly SOURCE=local restore test stay.
  The unused key ~/.ssh/dira_backup_ed25519 is kept. To resume: NUC host +
  backup user with that public key; R2 bucket dira-backups + token in the
  env file; then restic (static binary), restic init, an R2 restore test,
  cron SOURCE=r2.
- 2026-11-18 (Phesto): "for the backup and restore test, you may read the
  dira database and create/drop dira_restore_test". Now in CLAUDE.md.
- 2026-11-18 (Phesto): deploy exception in CLAUDE.md: I may run
  /opt/qusaz/dira/deploy.sh only after Phesto merged to main, with a
  backup first and /health + readonly golden against prod after.
  Passwordless sudo for the dira-api/dira-web restarts (and is-active,
  which deploy.sh also runs with sudo): /etc/sudoers.d/dira-deploy,
  added by Phesto 22:51; sudo -n is-active works for both (restart not
  exercised: it would restart prod).
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
  R2 parked by Phesto). At the check: no /opt/qusaz/shared/backup/dira/, no
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
   (token/latency logging done) cherry-pick beb392c, code answers
   for people questions + date precision, My people page, open-question
   path, deploy script.

## Open questions for Phesto
- Backfill: link confirmed people in the 44 existing dira_dev events
  (13 would get links) and in prod? A one-off script, dry run first.
- Two-letter first names ("Bo") do not link alone (false-match guard);
  add them as aliases if wanted.
- Keys: still not split (same fingerprints dev/prod). Token logging waits.
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
