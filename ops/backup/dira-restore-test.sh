#!/bin/bash
# Monthly restore test: restores the newest DIRA backup into a scratch database and compares it with the live one,
# then drops the scratch database. SOURCE=r2 (default, proves the off-site copy), nuc or local.
# Pass: checksum matches, every live table exists, every table with rows has rows, same applied migrations.
# Row counts may trail the live database by a day of saves; they are reported, not required to match.
# Writes $BACKUP_ROOT/last_restore_test.json. Reads the live database only.
set -uo pipefail
# Dumps hold personal data: new files 600 and directories 700, readable only by the backup user.
umask 077

ENV_FILE=${DIRA_BACKUP_ENV:-/etc/qusaz/dira-backup.env}
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

DB_NAME=${DB_NAME:-dira}
PG_CONTAINER=${PG_CONTAINER:-qusaz-postgres}
PG_USER=${PG_USER:-postgres}
BACKUP_ROOT=${BACKUP_ROOT:-/opt/qusaz/backups/dira}
SOURCE=${SOURCE:-r2}
NUC_TARGET=${NUC_TARGET:-}
NUC_SSH_KEY=${NUC_SSH_KEY:-}
SCRATCH="${DB_NAME}_restore_test"
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

log() { echo "$(date -Is) [dira-restore-test] $*"; }
psql_db() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -v ON_ERROR_STOP=1 -Atq -d "$1" -c "$2"; }
[ "$SCRATCH" != "$DB_NAME" ] || { log "scratch name equals the live database"; exit 1; }

WORK=$(mktemp -d)
cleanup() { psql_db postgres "DROP DATABASE IF EXISTS \"$SCRATCH\"" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
fail() { log "FAIL: $*"; echo "{\"at\":\"$(date -Is)\",\"ok\":false,\"source\":\"$SOURCE\",\"error\":\"$*\"}" > "$BACKUP_ROOT/last_restore_test.json"; exit 1; }

# 1. Fetch the newest backup and its checksum.
case "$SOURCE" in
  r2)
    [ -n "${RESTIC_REPOSITORY:-}" ] || fail "RESTIC_REPOSITORY not set"
    restic restore latest --tag dira --host dira-backup --target "$WORK" --quiet || fail "restic restore failed"
    DUMP=$(find "$WORK" -name '*.dump' | sort | tail -1) ;;
  nuc)
    [ -n "$NUC_TARGET" ] || fail "NUC_TARGET not set"
    ssh_cmd="ssh -o BatchMode=yes -o ConnectTimeout=20${NUC_SSH_KEY:+ -i $NUC_SSH_KEY}"
    rsync -a -e "$ssh_cmd" "$NUC_TARGET/daily/" "$WORK/" || fail "rsync from NUC failed"
    DUMP=$(ls -1t "$WORK"/*.dump 2>/dev/null | head -1) ;;
  local) DUMP=$(ls -1t "$BACKUP_ROOT"/daily/*.dump 2>/dev/null | head -1) ;;
  *) fail "unknown SOURCE $SOURCE" ;;
esac
[ -n "${DUMP:-}" ] && [ -f "$DUMP" ] || fail "no backup found from $SOURCE"
[ -f "$DUMP.sha256" ] || fail "no checksum next to $(basename "$DUMP")"
[ "$(sha256sum "$DUMP" | awk '{print $1}')" = "$(cat "$DUMP.sha256")" ] || fail "checksum mismatch for $(basename "$DUMP")"
log "restoring $(basename "$DUMP") from $SOURCE"

# 2. Restore into a fresh scratch database (extensions such as pgvector come from the dump).
psql_db postgres "DROP DATABASE IF EXISTS \"$SCRATCH\"" || fail "could not drop old scratch database"
psql_db postgres "CREATE DATABASE \"$SCRATCH\"" || fail "could not create scratch database"
docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" --no-owner --no-acl --exit-on-error -d "$SCRATCH" < "$DUMP" || fail "pg_restore failed"

# 3. Compare with the live database.
count_rows() {
  local db=$1 out=""
  for table in $(psql_db "$db" "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"); do
    out+="$table=$(psql_db "$db" "SELECT count(*) FROM \"$table\"") "
  done
  echo "$out"
}
live=$(count_rows "$DB_NAME"); restored=$(count_rows "$SCRATCH")
problems=""
for pair in $live; do
  table=${pair%%=*}; n=${pair#*=}
  got=$(echo " $restored" | grep -o " $table=[0-9]*" | cut -d= -f2)
  [ -n "$got" ] || { problems+="missing table $table; "; continue; }
  [ "$n" -gt 0 ] && [ "$got" -eq 0 ] && problems+="$table empty (live $n); "
  log "  $table: restored $got, live $n"
done
mig_live=$(psql_db "$DB_NAME" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null || echo "?")
mig_restored=$(psql_db "$SCRATCH" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null || echo "?")
[ "$mig_live" = "$mig_restored" ] || problems+="migrations restored $mig_restored vs live $mig_live; "
[ -z "$problems" ] || fail "$problems"

echo "{\"at\":\"$(date -Is)\",\"ok\":true,\"source\":\"$SOURCE\",\"file\":\"$(basename "$DUMP")\",\"migrations\":$mig_restored}" > "$BACKUP_ROOT/last_restore_test.json"
log "PASS: $(basename "$DUMP") restores cleanly ($mig_restored migrations)"
