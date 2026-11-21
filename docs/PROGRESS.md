# personal — progress

Last updated: 2026-11-21

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
- 2026-11-21 11:17: deployed a5aece7 (planned status, spending by kind,
  uploads in restore-into-dev, upload-keep guards) to prod. Full live
  readonly on dev first: 25/25. Backup dira_20261121_111707.dump +
  uploads tar first; both services active; /health ok; prod .env 600
  (logs/deploy-20261121d.log). Then the approved status change (2 events
  active → planned, dry run then apply). Prod golden readonly 25/25, no
  rows changed (logs/golden-prod-readonly-20261121d.log).
- 2026-11-21: (deployed 11:17, see the entry above)
  - restore-into-dev also restores the uploads archive of the same backup:
    checked against its checksum and manifest before dev is touched (a bad
    archive stops it), folder 700 / files 600, dev's previous uploads kept,
    paths in dira_dev rewritten to dev's folder, every referenced file
    checked. Run on the 10:34 prod backup (0 files) and on a synthetic
    backup with one file (644 → 600, path rewritten; tampered: stopped
    before any change). The monthly restore test now also checks that every
    upload the restored database references is in the archive (prod: PASS).
  - Events have a "planned" status (API, commands, focus). Vision answers
    sort by status and dates, never wording: planned, completed (Done),
    dormant (Paused), cancelled; active with a date ahead/behind → Planned
    /Done, without a date → "In progress or undated".
  - Recorded spending splits by kind (land / building / other, from title,
    text and item descriptions, Swahili words included); one sum per
    currency, never added ("… and 300 EUR (different currencies, not
    added)"); income is not spending.
  - Dismissing an upload keeps the file and its path (it already did; now
    guarded): a test fails on any file-removing call in api/src, a test
    dismisses a queued upload, and a fixture gate uploads a file through
    /home and dismisses it.
  - Golden: vision-planned-by-status (25 cases), vision-revisit checks the
    kinds, upload-keep-gate; fixture seeds a project like the one-off, the
    fence as a planned event, a building and an EUR payment.
  - The 2 planned events from the one-off: active → planned, approved by
    Phesto, applied on prod after the deploy (and on dev's copy).
  - npm test 105/105; golden fixture 25/25 + reset gate + upload-keep gate;
    live readonly 24/25, then the changed case 2/2 after updating its check
    (logs/golden-status-*-20261121-1055.log).
- 2026-11-21 10:34: deployed d3dd005 (uploads in a persistent folder,
  uploads in the backup) to prod; backup dira_20261121_103410.dump plus
  uploads_20261121_103410.tar (0 files) first; prod logs the new folder at
  start; both services active; /health ok (logs/deploy-20261121c.log).
  Prod golden readonly 23/24, no rows changed
  (logs/golden-prod-readonly-20261121c.log): the vision case expected the
  fence as a related vision, which the approved one-off archived; it is now
  a record of the project. Check updated: fixture and prod both pass that
  case. The vision answer on prod lists 3 records behind the recorded
  spending total.
- 2026-11-21: uploaded originals kept, and backed up.
  - Found: uploads went to /tmp/dira-uploads, emptied on 14 Nov (folder
    recreated 06:09). Prod references 13 files: all lost, nothing to copy;
    of the documents behind them only summaries remain (one CV kept its
    text). /opt/qusaz/dira-data/uploads made (700, qusaz).
  - uploadStore: one place writes uploads (home, intake, email): a
    persistent folder, never /tmp (refused at start), folder 700, files
    600, never overwritten. Default is prod's folder (prod .env not
    edited); dev sets DIRA_UPLOAD_DIR=/opt/qusaz/dira-dev/data/uploads
    (data/ in .gitignore). Checked on dev: a real upload lands there, 600.
  - Backup: each run also writes uploads_<stamp>.tar with MANIFEST.sha256
    inside, same retention, NUC mirror, restic when R2 is set up. Restore
    test unpacks it and checks every file (a changed file fails, tested).
    Installed; real run: 0 files, restore test PASS.
  - test/upload-store.test.js.
- 2026-11-21: one-off on prod, approved (backup dira_20261121_101730.dump,
  dry run, Phesto's yes): a project record linked to the eco-living
  vision; 10 events linked to it (8 existing, 2 new planned events from a
  dismissed note and from the fence vision's text, kept in full); one
  payment's date corrected (stored year misread; the message said
  "yesterday"); the fence vision archived, nothing deleted. Checked
  read-only after.
- 2026-11-21 10:20: deployed a6e85a1 (recorded spending, fixed people
  order) to prod; backup dira_20261121_102006.dump first; both services
  active, /health ok (logs/deploy-20261121b.log). Prod golden after the
  uploads change.
- 2026-11-21: vision answers say "Recorded spending" and name every
  record behind the total ("2 records: A (x TSH, date); B (…)"); events
  linked to a record the vision links to (its project) count as the
  vision's. Chain answers list people in a fixed order (you, then birth
  date, then name): a unit test failed on database order. Golden check for
  the stated-connections case fixed (see the deploy entry). npm test
  100/100; golden fixture 24/24 + reset gate; live readonly 24/24
  (logs/golden-order-*-20261121-0944.log). Not deployed.
- 2026-11-21 09:26: deployed 2fcea8a (pronoun follow-ups, gender
  filters, singular/plural, vision answers, vision progress card) to prod.
  main fast-forwarded 4477cd1..2fcea8a, pushed; prod merged it as f874483.
  Backup first (dira_20261121_092611.dump); no migration; both services
  active; /health ok; prod .env 600. Prod golden readonly 23/24, no rows
  changed (logs/deploy-20261121a.log, logs/golden-prod-readonly-20261121a.log).
  The one failure was the check, not the answer: after the confirmed card
  the statement answers "Already recorded … Left out, as you said: <the
  exception>", and the check read the exception's name in that sentence.
  Check fixed on dev (it now ignores the "Left out" sentence).
- 2026-11-21: progress statements on a vision (real-use 2 of 2).
  - A statement with progress ("one X complete, the second ~70%") that
    names a vision, or follows a question about one, gives a card instead
    of a plain save: it echoes the facts by code (visionReview.
    progressFacts: "x 1 complete; x 2 ~70%") and offers (a) save it as a
    progress update linked to the vision (connectedEvents) and (b) move the
    stage seed/forming/held -> active. Only the confirm writes; no date is
    invented. Works whatever the router calls the message (seen: intake,
    correction, relationship_change); a progress statement is never a yes
    to an earlier offer. Web: the card reuses the checkbox card.
  - Golden: vision-progress-statement, vision-progress-follow-up (24).
- 2026-11-21: vision questions answered from the vision and its records
  (real-use 1 of 2).
  - visionReview: a vision is named by the distinctive run of its title
    (a tie asks which; a title starting with the phrase wins); its events
    are the linked ones plus those that carry its name in title, text,
    tags or refs. Answer by code: stage, summary, Done, Spent, Planned,
    Also recorded, related visions, Not recorded. No offers. "revisit …
    vision" was routed as a command: review wording with a named vision is
    now a question.
  - Read-only check on prod (asked): 2 visions, both with 0 linked events
    and no relationship edges; 6 events mention the name, none linked; the
    links were by name only, and no entity holds the name.
  - Golden: vision-revisit; fixture seeds 2 events and creates 2 visions.
  - test/vision-review.test.js. npm test 100/100; golden fixture 24/24 +
    reset gate; live readonly 24/24, no rows changed
    (logs/golden-vision-*-20261121-0649.log). Not deployed: shown first.
- 2026-11-21: dev has its own model keys. Phesto added new Groq and
  OpenAI keys to dev's .env; fingerprints of JWT_SECRET, GROQ_API_KEY and
  OPENAI_API_KEY now all differ from prod (compared, never printed); .env
  600; both keys answer 200; cron, bridge and email still off in dev. Live
  readonly golden 21/21 on the new keys. Prod .env untouched.
- 2026-11-20: singular/plural in counts (real-use 3 of 3).
  - peopleGrounding.countOf: "1 son", "2 sons", "1 child"; used by the
    children, sibling and chain counts ("Your mother has 1 son"), list
    heads ("Your daughter: …" for one) and the properties head.
  - Golden: parents-sons-count (21 cases).
  - test/gender-filters.test.js (counts). npm test 96/96; golden fixture
    21/21 + reset gate; live readonly 21/21 (logs/golden-counts-*.log).
    Not deployed: shown to Phesto first.
- 2026-11-20: gender filters on every path (real-use 2 of 3).
  - "how many sons do I have?" listed every child: the children answer
    ignored sons/daughters. Now childrenWanted/childrenOfKind filter by
    the recorded kind (person or event wording); children recorded as
    neither are named apart ("Not recorded as son or daughter: …"), never
    counted in. The compound path (births of "my wife and sons") uses the
    same filter; chains and pronoun follow-ups already filtered by gender.
  - Golden: parents-pronoun-daughters (20 cases).
  - test/gender-filters.test.js. npm test 95/95; golden fixture 20/20 +
    reset gate; live readonly 20/20 (logs/golden-gender-*.log).
- 2026-11-20: pronoun follow-ups (real-use 1 of 3).
  - peopleGrounding.resolvePronouns: they/them/their/he/him/his/she/her
    refer to the people of the previous people question (a whole chain,
    or its relation words), rewritten ("… do my parents have?") so the
    usual answers apply. "they" after several groups, or a singular
    pronoun after a plural group, asks who is meant. Questions that name
    their own people, and follow-ups to non-people questions, are left
    as they are. Used in lifeAdvisor.chat.
  - Golden: parents-pronoun-count (19 cases).
  - test/pronouns.test.js. npm test 92/92; golden fixture 19/19 + reset
    gate; live readonly 19/19 (logs/golden-pronoun-*.log).
- 2026-11-20: Phesto confirmed the parent-connection card on prod. Checked
  readonly through the prod API: the spouse's children list the four
  children, the excepted one left out; the statement again answers
  "Already recorded".
- 2026-11-20 00:17: deployed 4477cd1 (possessive chains, stated parent
  connections) to prod. main fast-forwarded 31674a6..4477cd1, pushed;
  prod merged it as 86355f9. Backup first (dira_20261120_001603.dump); no
  migration; both services active; /health ok; prod .env 600. Prod golden
  readonly 18/18, no rows changed: the chain cases answer you and your
  siblings (5), the statement gives a 4-connection card leaving the
  exception out (logs/deploy-20261120a.log,
  logs/golden-prod-readonly-20261120a.log).
- 2026-11-19: stated parent connections ("X is the mother of my
  children, except Y") give a confirm card; only the confirm writes.
  - Routing on prod: relationship_add, but the router model also marked
    the message as accepting an offer from the previous turn
    (followUp accept), so home saved that offer as an event. Now a message
    that itself states a relationship is never a follow-up accept
    (intentRouter).
  - services/graph/statedConnections.js (code, no model): the parent must
    be a confirmed person; "my children" = the user's confirmed children,
    or a named list; exceptions left out; unknown names reported. The card
    (relationship_preview, "mother of …") holds the proposals in the
    session only; confirm upserts the ticked ones as confirmed, source
    user, parentRole kept; already-confirmed ones are not proposed again
    ("Already recorded" when nothing is new).
  - contamination.test.js: a personal name removed from its ordinary-word
    list (it became a personal word through the new golden case).
  - Golden: mother-of-children-statement (18 cases).
  - test/stated-connections.test.js. npm test 90/90; golden fixture
    18/18 + reset gate; live readonly 18/18, no rows changed
    (logs/golden-statement-*.log). Not deployed: shown to Phesto first.
- 2026-11-19: possessive chains resolved left to right, any depth.
  - Real use: "who are my parents' children?" listed the parents plus the
    user's own children (the compound path took "parents" and "children"
    as two questions). peopleGrounding.parseChain reads "my A's B's C",
    plural possessives (parents', sisters') and "how many C do my A have";
    each step from records: the person's recorded connections first, then
    only what follows from the user's own (a parent's children = you and
    your siblings; a parent's spouse = the other parent; a sibling's
    parents = your parents; a sibling's siblings = you and the others; a
    child's parent = you). Gendered words filter by gender, preferring
    people of known gender. "how many" gives the count.
  - Golden: parents-children and parents-children-count (17 cases).
  - test/chained-people.test.js. npm test 86/86; golden fixture 17/17 +
    reset gate; live readonly 17/17 (logs/golden-chains-*.log).
- 2026-11-19 23:07: redeployed 31674a6 (timeline sort fix) to prod. main
  fast-forwarded 65d07c7..31674a6, pushed; prod merged it as 2b7383e.
  Backup first (dira_20261119_230610.dump); no migration; both services
  active; /health ok. Prod golden readonly 15/15, no rows changed; the
  trip answer counts to the exact start date (21 days) and no longer
  lists the return date as missing (logs/deploy-20261119f.log,
  logs/golden-prod-readonly-20261119i.log).
- 2026-11-19 22:56: prod deploy of 65d07c7 (month precision, chained
  relations, compound people, timeline) and the approved date fix.
  Backups dira_20261119_225345.dump (before deploy) and _225425 (before
  the fix). Migration 20261119230000_event_date_precision applied; both
  services active; /health ok. Date fix, one transaction, matched by id,
  title and current value: a trip given its start and end dates; two
  events whose day had been invented from "in December" set to the month
  (datePrecision "month"). Second dry run: 0 changes. Script kept outside
  the repo (personal data).
  - Prod golden readonly: 14/15, no rows changed. trip-timeline failed:
    a month-only date (stored as the 1st) sorted before the exact trip
    date in the same month, so the answer counted to no day. Fixed: a
    month-only date ranks at the end of its month (timeline.js sortKey);
    test added. npm test 84/84; dev golden fixture 15/15 + reset gate,
    live 15/15 (logs/golden-sortkey-*.log). Redeploy follows.
- 2026-11-19: chained relations from records ("my father's wife",
  "my wife's …", "my sister's …", "my sister <name>'s husband").
  - peopleGrounding.chainedPeopleAnswer: the base relative(s), then that
    person's recorded connection of the asked kind; without one only two
    things follow from your own connections: a parent's spouse is your
    other parent, a parent's children are you and your siblings. Anything
    else unrecorded says "not recorded yet" (your children are not assumed
    to be your spouse's). loadPeopleContext now names connection ends
    outside the tree.
  - Golden: new case fathers-wife (the mother, never the own wife): 15 cases.
  - test/chained-people.test.js. npm test 83/83; golden fixture 15/15 +
    reset gate; live readonly 15/15 (logs/golden-chain-*.log).
- 2026-11-19: month-precision dates (needed before the prod fix of the
  two invented "15 Dec" events).
  - Migration 20261119230000_event_date_precision: Event.datePrecision
    (null = the day, "month" = only the month; occurredAt is its 1st).
    Applied to dira_dev; prod gets it with the next deploy.
  - Intake: the prompt asks for YYYY-MM when only the month is clear and
    never an invented day; normalizeUnderstood keeps it as month; yearless
    months snap to the nearest; kept as month at confirm unless a day is
    picked.
  - Shown without a day ("Dec 2026") in saved/preview lines, focus,
    timeline, the properties list, the model's event context and the web
    events/library pages; days-left says "no day recorded" instead of
    counting to an invented day; a month-only date this month still counts
    as coming up.
  - test/date-precision.test.js. npm test 79/79; golden fixture 14/14 +
    reset gate; live readonly 14/14 (logs/golden-precision-*.log).
- 2026-11-19: real-use 6, timeline and progress questions.
  - services/timeline.js: "days until", "on track", "how is … going",
    "status of", "where am I with", "ready for". Subjects = names in the
    question (records whose title has the name; a trip question keeps only
    trip records, not ones long past) or its topic word. Per subject:
    next recorded date with days left, the records (date, amount),
    recorded progress (completed/started/paid/… in a past or undated
    record) or "none", and a not-recorded checklist (trip: flights,
    accommodation, return date, local transport, budget; building work:
    contractor, cost estimate, payments, materials, start or finish date).
    Code only, no model call, so "on track" is never said. Nothing on
    record matches → normal chat.
  - Golden: a seed with a dated trip and case trip-timeline (14 cases).
  - On the dira_dev copy of prod: the trip record had no date (saved
    18 Nov, before dates were kept); the answer used another dated
    record and listed the trip as no date.
  - test/timeline.test.js. npm test 75/75; golden fixture 14/14 + reset
    gate; live readonly on dira_dev 14/14 (logs/golden-timeline-*.log).
- 2026-11-19: real-use 5, compound people questions.
  - peopleGrounding.compoundPeopleAnswer: a question naming two or more
    relations (spouse, parents, father, mother, children, siblings;
    "parents" covers father and mother) answers each from records, in
    the order asked, in one reply; birth questions give each person's
    recorded date or "not recorded yet". Possessive questions ("my
    father's wife") stay on the single-relation path. No model call.
  - Golden: new case wife-and-parents (13 cases now).
  - journal-share test sets DIRA_BRIDGE/DIRA_BRIDGE_JOURNAL "on"
    explicitly: Prisma loads api/.env into unset variables, and dev's
    .env now has DIRA_BRIDGE=off.
  - test/compound-people.test.js. npm test 70/70; golden fixture 13/13 +
    reset gate; live readonly on dira_dev 13/13
    (logs/golden-compound-*.log).
- 2026-11-19 21:51: deployed 57429be (docs and ops scripts only, no app
  code) to prod. main fast-forwarded 7a26f50..57429be, pushed; prod
  merged it as 0f0532d. Backup first (dira_20261119_215049.dump, 600);
  no migration; both services active; /health ok; prod .env still 600.
  Prod golden readonly: first run 11/12, `sisters` flagged "readonly
  violated: updated event" (answer itself right). The write was a PATCH
  /events/<id> from the web app at 21:52:09, after a GET of that event at
  21:51:40 (Phesto confirmed: he was editing it in the live app); the harness only calls
  /home/input and /home/confirm. Rerun 12/12, no rows changed
  (logs/deploy-20261119d.log, logs/golden-prod-readonly-20261119f.log
  and -g.log). Commit 3ccdd94 said 12/12 before the first result was
  read; corrected here.
- 2026-11-19 21:40: prod JWT rotated by Phesto (ops/rotate-prod-jwt.md);
  verified read-only, no secret printed: JWT_SECRET once in prod .env,
  64 hex chars; prod .env 600 qusaz:qusaz (= dira-api User=qusaz), old
  copy kept at 600; dev and prod fingerprints differ; prod
  refresh_tokens: 1 row, created after the restart (the 8 old ones gone);
  dira-api active since 21:39:44, dira-web active, /health ok; API log
  since the restart: 0 errors, 0 5xx, 2 x 401 at 21:40:13 (GET /events,
  /graph/suggestions with the old token, before the new login at
  21:40:41), request-otp and verify-otp 200; prod golden readonly 12/12,
  no rows changed (logs/golden-prod-readonly-20261119e.log). Dev .env was
  664, now 600; restore-into-dev.sh keeps it 600.
- 2026-11-19 21:36: backup permissions. /opt/qusaz/backups/dira/ was
  775 (dirs) and 664 (every dump, checksum, log and status file):
  readable by any local user. Now dirs 700, files 600, all qusaz (the
  cron user). /opt/qusaz/backups/dira_dev/ was already 700/600.
  dira-backup.sh and dira-restore-test.sh set umask 077 (backup also
  chmods its dirs 700); installed copies updated and set 755 (were
  group-writable 775). A test backup wrote dira_20261119_213619.dump at
  600.
- 2026-11-19 21:25: archived October test noise on prod (Phesto chose
  12 queue items, option a: queue item dismissed, its event archived,
  nothing deleted). Backup first (dira_20261119_212423.dump); dry run
  matched; one transaction, 18 changes (12 queue, 8 events). Before:
  47 active / 9 archived events; queue 51 understood, 25 dismissed,
  1 failed, 0 open. After: 39 active / 17 archived; 42 understood,
  35 dismissed, 0 failed, 0 open. Prod golden readonly 12/12, no rows
  changed (logs/archive-queue-20261119.log,
  logs/golden-prod-readonly-20261119d.log). The list itself was read
  from dira_dev (restored from the 20:43 prod dump; a direct prod read
  was blocked by the permission check).
- 2026-11-19: ops/rotate-prod-jwt.md for Phesto: new 64-char prod
  JWT_SECRET, clear prod refresh_tokens (random strings in the DB, so a
  new secret alone keeps sessions alive), chmod 600 on prod .env (664
  today), restart. Not applied yet.
- 2026-11-19 21:10: dev auth after the restore. dev and prod had the same
  JWT_SECRET (fingerprints compared, not printed): a token signed by
  either worked on both. Dev got its own (96 hex chars; old dev .env kept
  in /opt/qusaz/backups/dira_dev/); refresh_tokens cleared in dira_dev.
  Checked: a token signed with prod's secret gets 401 on dev, dev's 200.
  - ops/backup/restore-into-dev.sh: every future restore into dev (stop
    dev API, save dira_dev, restore, clear refresh_tokens, own JWT secret
    if it matches prod, cron/bridge off, refuse with a Resend key or
    bridge secret, restart, row counts). Ran twice on the same dump:
    0.45-0.46 s restore, counts match (logs/restore-into-dev-20261119.log).
- 2026-11-19 20:55: first restore test: prod dump into dira_dev
  (Phesto, instead of a second backfill).
  - Dev API stopped; dira_dev dumped first to
    /opt/qusaz/backups/dira_dev/dira_dev_pre_restore_20261119.dump (it
    also had the parked branch's `claims` table, 0 rows, and its
    migration; not in prod, so gone from dira_dev now).
  - DROP + CREATE dira_dev (owner dira_user), pg_restore (owners kept) of
    dira_20261119_204348.dump: 0.49 s for drop, create and restore.
  - Row counts, prod vs dira_dev: users 1/1, entities 15/15,
    relationships 15/15, events 56/56, input_queue 77/77, diary_entries
    2/2, visions 2/2, refresh_tokens 8/8, life_events 0/0,
    _prisma_migrations 10/10 (9 finished both); vector extension present.
  - Dev API restarted. Off in dev: DIRA_DISABLE_CRON=true ("[cron]
    disabled" at start); bridge: DIRA_BRIDGE=off now set explicitly in dev
    .env (it was unset = on, inert only because dev has no bridge secret);
    email: no RESEND_API_KEY in dev, so no digest or OTP mail can send.
  - Golden live readonly on dira_dev 12/12, no rows changed; fixture
    12/12 + reset gate (logs/golden-restore-*.log).
- 2026-11-19 20:46: deployed 7a26f50 (dates only from records, stated
  dates on confirm, property list by code) to prod. main fast-forwarded
  8225d06..7a26f50, pushed; prod merged it as 8ce77d6. Backup first
  (dira_20261119_204348.dump); no migration; both services active;
  /health ok. Readonly golden against prod 12/12 (family-tree,
  sister-births, properties included), every date from records, no rows
  changed (logs/deploy-20261119c.log, logs/golden-prod-readonly-20261119c.log).
- 2026-11-19 20:4x: one-off prod family backfill (Phesto approved the
  dry run, with one date he corrected). Backup first
  (dira_20261119_203734.dump). One transaction, empty fields only, records
  matched by id: 1 confirmed mother connection (her person record existed;
  the connection was missing, so she was not in the tree), 11 birth
  dates, 1 marriage date on the spouse connection. Second dry run: 0
  changes. Script kept outside the repo (personal data); log in
  logs/backfill-family-20261119.log (gitignored).
  - The disputed land entry stays on the properties list (Phesto).
- 2026-11-19: properties answered by code from records.
  - services/holdings.js: holdings found in saved events' text (plot
    numbers; "<kind> in <Place>"; "<Place> land/house"; "<Name> is our
    place"), one per plot or place ("<Place> <Region>" merges into
    "<Place>"), each with its earliest dated record and a count of more
    records. List questions ("what/which/list/how many … properties/
    plots/lands/houses", "do I own …") get this answer with no model call;
    other property questions keep the model with the property records.
  - test/holdings.test.js. npm test 65/65; golden fixture 12/12 + reset
    gate; live readonly on dira_dev 11/12, `properties` passes (7
    holdings), family-tree fails only because dira_dev has no father
    record (logs/golden-holdings-*.log).
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
- 2026-11-19 (Phesto): git history keeps the older PROGRESS.md versions
  that named family members and places; not rewritten (main is what prod
  pulls). New entries stay neutral.
- 2026-11-19 (Phesto): a house project's amounts are EUR, including two
  installments whose text names no currency.
- 2026-11-19 (Phesto): restores into dev always go through
  ops/backup/restore-into-dev.sh (sessions cleared, own JWT secret, nothing
  leaves dev).
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
- Next (Phesto, 2026-11-21): spending kind as a field Phesto can correct
  on each record (the cost sheet may be building).
Phesto (2026-11-18): before token logging, the backup + restore test and
the dev/prod key split must be done. Re-checked 2026-11-18 evening after
Phesto said both were applied: still not on this host, token logging held.
- Backup (later the same evening: installed, local only, see Done; NUC +
  R2 parked by Phesto). At the check: no /opt/qusaz/shared/backup/dira/, no
  /etc/qusaz/, no restic, no dira cron line. The only backup cron is the old
  /opt/qusaz/shared/postgres/backup.sh (02:00), and its dumps in
  /opt/qusaz/backups/ contain no dira database. No restore-test result.
- Keys: split on 2026-11-21 (see Done). Before that, dira-dev/api/.env and dira/api/.env (prod EnvironmentFile)
  shared the OpenAI and the Groq fingerprints; both files unchanged since
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
