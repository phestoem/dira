# DIRA backups (proposal, 2026-11-18)

Prod `dira` is in no backup today: `/opt/qusaz/shared/postgres/backup.sh` dumps fomu, jumuiya, estateiq,
choirly_staging and nexus only. This adds a separate job for `dira`. The shared script stays as it is: its
`find … -name "*.sql.gz" -mtime +7 -delete` does not touch these files, which are `.dump` files in their own
folder.

What it does (Phesto's decision):
- nightly `pg_dump` of `dira`, verified, with a checksum;
- 7 daily + 4 weekly copies, kept locally, mirrored to the other NUC and copied encrypted with restic to
  Cloudflare R2;
- a monthly restore test into a scratch database.

| File | Purpose |
|---|---|
| `dira-backup.sh` | dump → verify (it must hold table data) → sha256 → weekly hard link on Sundays → prune by count → rsync to the NUC → restic to R2 → `last_status.json`. One destination failing does not stop the others; the exit code is then 1. |
| `dira-restore-test.sh` | fetch the newest backup (`SOURCE=r2`, default; or `nuc`, `local`) → check its sha256 → restore into `dira_restore_test` → compare with live `dira` (every table present, no table empty that has rows live, same applied migrations; row counts reported) → drop the scratch database → `last_restore_test.json`. Reads live `dira` only. |
| `dira-backup.env.example` | settings; copy to `/etc/qusaz/dira-backup.env`, chmod 600 |

Tested 2026-11-18 against `dira_dev` (not prod): three backups with KEEP_DAILY=2 (pruning and weekly links
work), restore test PASS with every table's row count matching (pgvector restored from the dump), and the
failure paths (NUC unreachable, R2 unreachable, missing database) each reported and exit 1 with the local dump
kept. The NUC and R2 steps are untested here: no access from this session.

## Setup (Phesto)

1. **Scripts.** Copy the scripts to a fixed place that does not change with deploys:
   `sudo install -d /opt/qusaz/shared/backup/dira && sudo install -m 755 dira-backup.sh dira-restore-test.sh /opt/qusaz/shared/backup/dira/`
2. **Settings.** `sudo install -d -m 700 /etc/qusaz`, copy `dira-backup.env.example` to
   `/etc/qusaz/dira-backup.env`, fill it in, `chmod 600`. The cron user (qusaz) needs to read it and to run
   `docker exec`, as the existing backup job already does.
3. **Other NUC.**
   - On the NUC: create a `backup` user and `/srv/backups/dira`.
   - Here: `ssh-keygen -t ed25519 -f ~/.ssh/dira_backup_ed25519 -N ""`.
   - Put the public key in the NUC user's `authorized_keys`. Restrict it to rsync into that folder, e.g.
     `command="rrsync /srv/backups/dira",restrict ssh-ed25519 …`.
   - Run `ssh -i ~/.ssh/dira_backup_ed25519 backup@OTHER_NUC_HOST` once to accept the host key.
4. **Cloudflare R2.**
   - Create bucket `dira-backups`, and an R2 API token with Object Read & Write on that bucket only. That gives
     the access key ID and secret used in the env file.
   - Install restic: `sudo apt install restic` (or the static binary).
   - Generate a password with `openssl rand -base64 32 > /etc/qusaz/dira-restic.pass` (chmod 600) **and keep a
     copy in your password manager**. Without it the R2 backups cannot be read.
   - Initialise once: `set -a; . /etc/qusaz/dira-backup.env; set +a; restic init`.
5. **First run by hand.** Run `/opt/qusaz/shared/backup/dira/dira-backup.sh`, then check that
   `/opt/qusaz/backups/dira/last_status.json` shows `"ok":true,"nuc":"ok","r2":"ok"`. Then run
   `SOURCE=r2 /opt/qusaz/shared/backup/dira/dira-restore-test.sh` and look for `PASS`.
6. **Cron** (qusaz's crontab, after the existing 02:00 job):
   ```
   30 2 * * * /opt/qusaz/shared/backup/dira/dira-backup.sh >> /opt/qusaz/backups/dira/backup.log 2>&1
   0 4 1 * * /opt/qusaz/shared/backup/dira/dira-restore-test.sh >> /opt/qusaz/backups/dira/restore-test.log 2>&1
   ```
   Alternate the monthly `SOURCE` (r2 / nuc) if both copies should be proven; r2 is the one that survives the
   house.

## Restoring prod for real

1. Stop writes: `sudo systemctl stop dira-api`.
2. Keep the current state: run `dira-backup.sh` once (or `pg_dump -Fc` by hand).
3. Restore: `docker exec -i qusaz-postgres pg_restore -U postgres --clean --if-exists --no-owner --no-acl -d dira < FILE.dump`.
   From R2, fetch it first with `restic restore latest --tag dira --target /tmp/dira-restore`; from the NUC, with
   rsync.
4. `sudo systemctl start dira-api`, then a read-only check:
   `npm run golden -- --base http://127.0.0.1:4800 --user <id> --readonly --allow-prod-readonly`.

## Monitoring (later)

`last_status.json` and `last_restore_test.json` carry `ok` and `at`. The graceful-failure item can show their age
on `/health`, and the digest can mention a backup older than 36 hours.

## Restoring prod into dev

Every restore of a dira dump into dira_dev goes through `restore-into-dev.sh`:

    ops/backup/restore-into-dev.sh /opt/qusaz/backups/dira/daily/dira_YYYYMMDD_HHMMSS.dump

It stops the dev API, saves dira_dev to /opt/qusaz/backups/dira_dev/, restores the dump, clears refresh_tokens,
gives dev its own JWT_SECRET if it matches prod's (fingerprints compared, never printed), sets
DIRA_DISABLE_CRON=true and DIRA_BRIDGE=off, refuses to finish if dev has a Resend key or a bridge secret, restarts
the dev API and prints row counts against prod. Then run the golden live readonly check on dev.
