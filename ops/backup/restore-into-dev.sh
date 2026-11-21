#!/usr/bin/env bash
# Restores a dira (prod) dump into dira_dev and makes dev safe to run on prod data:
#   1. stops the dev API (port 4801, cwd /opt/qusaz/dira-dev/api only)
#   2. dumps dira_dev first (BACKUP_DIR)
#   3. drops and recreates dira_dev (owner dira_user) and restores the dump, timed
#   3b. restores the uploads archive of the same backup (uploads_<stamp>.tar next to the dump) into dev's uploads
#       folder: checksum and every file checked against MANIFEST.sha256, folder 700, files 600; dev's previous uploads
#       kept in BACKUP_DIR; paths in dira_dev rewritten from prod's folder to dev's, and every referenced file checked
#   4. clears refresh_tokens (prod sessions must not work on dev)
#   5. checks dev's JWT_SECRET differs from prod's by fingerprint (never printed); if it matches, writes a new one
#   6. makes sure DIRA_DISABLE_CRON=true and DIRA_BRIDGE=off in dev .env, and that dev has no Resend key or bridge
#      secret
#   7. restarts the dev API and prints row counts, prod vs dev
# Usage: ops/backup/restore-into-dev.sh /opt/qusaz/backups/dira/daily/dira_YYYYMMDD_HHMMSS.dump
# Never touches the dira database except to read row counts.
set -euo pipefail

DUMP=${1:?usage: restore-into-dev.sh <dira dump>}
DEV_DIR=${DEV_DIR:-/opt/qusaz/dira-dev}
DEV_ENV="$DEV_DIR/api/.env"
PROD_ENV=${PROD_ENV:-/opt/qusaz/dira/api/.env}
PG_CONTAINER=${PG_CONTAINER:-qusaz-postgres}
PG_USER=${PG_USER:-postgres}
BACKUP_DIR=${BACKUP_DIR:-/opt/qusaz/backups/dira_dev}
PROD_UPLOADS=${PROD_UPLOADS:-/opt/qusaz/dira-data/uploads}
DEV_PORT=4801
STAMP=$(date +%Y%m%d_%H%M%S)

say() { echo "[restore-into-dev] $*"; }
fail() { say "FAIL: $*"; exit 1; }
psql_db() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -v ON_ERROR_STOP=1 -Atq -d "$1" -c "$2"; }
env_value() { grep -E "^$2=" "$1" | tail -1 | cut -d= -f2-; }
fingerprint() { printf '%s' "$1" | sha256sum | cut -c1-16; }

[ -f "$DUMP" ] || fail "no dump at $DUMP"
[ -f "$DEV_ENV" ] || fail "no dev env at $DEV_ENV"
DEV_UPLOADS=$(env_value "$DEV_ENV" DIRA_UPLOAD_DIR || true)
case "$DEV_UPLOADS" in "$DEV_DIR"/*) ;; *) fail "dev .env DIRA_UPLOAD_DIR must be inside $DEV_DIR (is '${DEV_UPLOADS}')" ;; esac
UTAR="$(dirname "$DUMP")/uploads_$(basename "$DUMP" .dump | sed 's/^[^_]*_//').tar"
[ -f "$UTAR" ] || fail "no uploads archive next to the dump ($UTAR)"
mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR"

# 0. Check the uploads archive file by file before anything in dev changes; a bad archive stops here.
UWORK="$DEV_DIR/data/.restore-$STAMP"
trap 'rm -rf "$UWORK"' EXIT
[ "$(sha256sum "$UTAR" | awk '{print $1}')" = "$(cat "$UTAR.sha256" 2>/dev/null)" ] || fail "checksum mismatch for $(basename "$UTAR")"
( umask 077; mkdir -p "$UWORK" ) && tar -xf "$UTAR" -C "$UWORK" || fail "could not unpack $(basename "$UTAR")"
[ -f "$UWORK/MANIFEST.sha256" ] || fail "no MANIFEST.sha256 in $(basename "$UTAR")"
[ ! -s "$UWORK/MANIFEST.sha256" ] || ( cd "$UWORK" && sha256sum --quiet -c MANIFEST.sha256 ) || fail "uploads do not match their manifest"
ufiles=$(wc -l < "$UWORK/MANIFEST.sha256"); rm -f "$UWORK/MANIFEST.sha256"
say "uploads archive $(basename "$UTAR"): $ufiles file(s), all match the manifest"

# 1. Stop the dev API.
pid=$(ss -ltnp 2>/dev/null | grep ":$DEV_PORT " | grep -oP 'pid=\K[0-9]+' || true)
if [ -n "$pid" ]; then
  [ "$(readlink "/proc/$pid/cwd")" = "$DEV_DIR/api" ] || fail "port $DEV_PORT is not the dev API (pid $pid)"
  kill "$pid"; sleep 2
  say "dev API stopped (pid $pid)"
fi
# Prisma engines left behind by earlier dev processes.
ps -eo pid,ppid,args | awk -v dir="$DEV_DIR" '$2==1 && index($0, dir"/api/node_modules/.prisma") {print $1}' | xargs -r kill

# 2. Dump dira_dev first.
pre="$BACKUP_DIR/dira_dev_pre_restore_$STAMP.dump"
docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc -d dira_dev > "$pre" && chmod 600 "$pre"
say "dira_dev saved to $pre"

# 3. Drop, recreate, restore.
start=$(date +%s.%N)
psql_db postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='dira_dev' AND pid <> pg_backend_pid()" >/dev/null
psql_db postgres "DROP DATABASE IF EXISTS dira_dev"
psql_db postgres "CREATE DATABASE dira_dev OWNER dira_user"
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" --exit-on-error -d dira_dev < "$DUMP" || fail "pg_restore failed (dira_dev was saved to $pre)"
end=$(date +%s.%N)
say "restored $(basename "$DUMP") in $(python3 -c "print(round($end-$start,2))") s"

# 3b. The checked uploads replace dev's, then the paths dira_dev holds point at dev's folder.
if [ -d "$DEV_UPLOADS" ] && [ -n "$(ls -A "$DEV_UPLOADS")" ]; then
  mv "$DEV_UPLOADS" "$BACKUP_DIR/dev-uploads-pre-restore-$STAMP" && say "dev's previous uploads kept in $BACKUP_DIR/dev-uploads-pre-restore-$STAMP"
else
  rm -rf "$DEV_UPLOADS"
fi
mkdir -p "$(dirname "$DEV_UPLOADS")" && mv "$UWORK" "$DEV_UPLOADS"
find "$DEV_UPLOADS" -type d -exec chmod 700 {} + && find "$DEV_UPLOADS" -type f -exec chmod 600 {} +
from=$PROD_UPLOADS to=$DEV_UPLOADS
psql_db dira_dev "UPDATE input_queue SET \"filePath\" = replace(\"filePath\", '$from/', '$to/') WHERE \"filePath\" LIKE '$from/%'" >/dev/null
psql_db dira_dev "UPDATE events SET \"sourceFile\" = replace(\"sourceFile\", '$from/', '$to/') WHERE \"sourceFile\" LIKE '$from/%'" >/dev/null
psql_db dira_dev "UPDATE events SET attachments = replace(attachments::text, '$from/', '$to/')::jsonb WHERE attachments::text LIKE '%$from/%'" >/dev/null
psql_db dira_dev "UPDATE visions SET inspirations = replace(inspirations::text, '$from/', '$to/')::jsonb WHERE inspirations::text LIKE '%$from/%'" >/dev/null
left=$(psql_db dira_dev "SELECT (SELECT count(*) FROM input_queue WHERE \"filePath\" LIKE '$from/%') + (SELECT count(*) FROM events WHERE attachments::text LIKE '%$from/%' OR \"sourceFile\" LIKE '$from/%')")
[ "$left" = 0 ] || fail "$left row(s) still point at prod's uploads folder"
refs=$(psql_db dira_dev "SELECT \"filePath\" FROM input_queue WHERE \"filePath\" LIKE '$to/%' UNION SELECT a->>'path' FROM events, jsonb_array_elements(CASE WHEN jsonb_typeof(attachments)='array' THEN attachments ELSE '[]'::jsonb END) a WHERE a->>'path' LIKE '$to/%'")
present=0; missing=0
for path in $refs; do if [ -f "$path" ]; then present=$((present + 1)); else missing=$((missing + 1)); say "  referenced, not in the archive: $path"; fi; done
lost=$(psql_db dira_dev "SELECT count(*) FROM input_queue WHERE \"filePath\" LIKE '/tmp/%'")
say "uploads: $ufiles file(s) from $(basename "$UTAR") verified into $DEV_UPLOADS (700/600); referenced $((present + missing)), present $present, missing $missing; $lost older reference(s) to /tmp (lost before the folder existed)"
[ "$missing" = 0 ] || fail "$missing referenced upload(s) missing from the archive"

# 4. Prod sessions do not carry over.
psql_db dira_dev "DELETE FROM refresh_tokens" >/dev/null
say "refresh_tokens cleared ($(psql_db dira_dev 'SELECT count(*) FROM refresh_tokens') left)"

# 5. Dev signs its own tokens.
dev_secret=$(env_value "$DEV_ENV" JWT_SECRET || true)
prod_secret=$(env_value "$PROD_ENV" JWT_SECRET || true)
if [ -z "$dev_secret" ] || [ "$(fingerprint "$dev_secret")" = "$(fingerprint "$prod_secret")" ]; then
  cp -p "$DEV_ENV" "$BACKUP_DIR/dev-env-before-jwt-rotate-$STAMP" && chmod 600 "$BACKUP_DIR/dev-env-before-jwt-rotate-$STAMP"
  NEW_SECRET=$(openssl rand -hex 48) python3 - "$DEV_ENV" <<'PY'
import os, re, sys
path = sys.argv[1]
text = open(path).read()
line = "JWT_SECRET=" + os.environ["NEW_SECRET"]
text, n = re.subn(r"(?m)^JWT_SECRET=.*$", line, text)
if not n:
    text = text.rstrip("\n") + "\n" + line + "\n"
open(path, "w").write(text)
PY
  say "JWT_SECRET matched prod (or was empty): dev got its own"
else
  say "JWT_SECRET differs from prod"
fi
unset dev_secret prod_secret

# 6. Nothing leaves dev.
set_flag() {
  if grep -qE "^$1=" "$DEV_ENV"; then sed -i "s|^$1=.*|$1=$2|" "$DEV_ENV"; else printf '%s=%s\n' "$1" "$2" >> "$DEV_ENV"; fi
}
set_flag DIRA_DISABLE_CRON true
set_flag DIRA_BRIDGE off
for key in RESEND_API_KEY ALTIMETRIX_BRIDGE_SECRET ALTIMETRIX_WEBHOOK_SECRET; do
  [ -z "$(env_value "$DEV_ENV" "$key" || true)" ] || fail "$key is set in dev .env: remove it before running dev on prod data"
done
chmod 600 "$DEV_ENV"
say "dev .env (600): DIRA_DISABLE_CRON=true, DIRA_BRIDGE=off, no Resend key, no bridge secret"

# 7. Restart and compare.
# exec, with every stream redirected, so no shell waits on the API or holds the caller's output open.
(cd "$DEV_DIR/api" && DIRA_TOKEN_LOG="$DEV_DIR/logs/tokens.jsonl" exec nohup node src/index.js) >> "$DEV_DIR/logs/api-personal.log" 2>&1 < /dev/null &
for _ in $(seq 1 20); do curl -fs "http://127.0.0.1:$DEV_PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "http://127.0.0.1:$DEV_PORT/health" | python3 -c "import sys, json; d = json.load(sys.stdin); print('[restore-into-dev] dev API', d['status'], 'bridge', d['flags']['DIRA_BRIDGE'])" || fail "dev API did not come back"
say "row counts (prod now / dev restored; prod may have moved on since the dump):"
for table in $(psql_db dira_dev "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"); do
  printf '  %-20s %6s / %s\n' "$table" "$(psql_db dira "SELECT count(*) FROM \"$table\"" 2>/dev/null || echo '?')" "$(psql_db dira_dev "SELECT count(*) FROM \"$table\"")"
done
say "done. Next: golden live readonly on dev."
