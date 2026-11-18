#!/bin/bash
# Nightly backup of the DIRA database: a verified pg_dump kept locally (7 daily + 4 weekly), mirrored to the other
# NUC over rsync/ssh, and copied encrypted to Cloudflare R2 with restic (same retention).
# Config: an env file (default /etc/qusaz/dira-backup.env, see dira-backup.env.example). A destination whose
# setting is empty is skipped. One destination failing does not stop the others; the script then exits 1.
# Writes $BACKUP_ROOT/last_status.json for monitoring.
set -uo pipefail

ENV_FILE=${DIRA_BACKUP_ENV:-/etc/qusaz/dira-backup.env}
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

DB_NAME=${DB_NAME:-dira}
PG_CONTAINER=${PG_CONTAINER:-qusaz-postgres}
PG_USER=${PG_USER:-postgres}
BACKUP_ROOT=${BACKUP_ROOT:-/opt/qusaz/backups/dira}
KEEP_DAILY=${KEEP_DAILY:-7}
KEEP_WEEKLY=${KEEP_WEEKLY:-4}
WEEKLY_DAY=${WEEKLY_DAY:-7}            # date +%u: 1 = Monday … 7 = Sunday
NUC_TARGET=${NUC_TARGET:-}             # e.g. backup@other-nuc:/srv/backups/dira
NUC_SSH_KEY=${NUC_SSH_KEY:-}
RESTIC_REPOSITORY=${RESTIC_REPOSITORY:-}  # e.g. s3:https://<account-id>.r2.cloudflarestorage.com/dira-backups
export RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

log() { echo "$(date -Is) [dira-backup] $*"; }
mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly"
exec 9>"$BACKUP_ROOT/.lock"
flock -n 9 || { log "another backup is running"; exit 1; }

STAMP=$(date +%Y%m%d_%H%M%S)
FILE="$BACKUP_ROOT/daily/${DB_NAME}_${STAMP}.dump"
TMP="$FILE.partial"
nuc=skipped; r2=skipped; failed=0

# 1. Dump (custom format: compressed, restorable table by table) and check it before keeping it.
if ! docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -Fc -d "$DB_NAME" > "$TMP"; then
  log "pg_dump failed"; rm -f "$TMP"; echo "{\"at\":\"$(date -Is)\",\"ok\":false,\"error\":\"pg_dump failed\"}" > "$BACKUP_ROOT/last_status.json"; exit 1
fi
tables=$(docker exec -i "$PG_CONTAINER" pg_restore --list < "$TMP" | grep -c " TABLE DATA " || true)
if [ "${tables:-0}" -lt 1 ]; then
  log "dump has no table data (${tables:-0}); not kept"; rm -f "$TMP"
  echo "{\"at\":\"$(date -Is)\",\"ok\":false,\"error\":\"dump has no table data\"}" > "$BACKUP_ROOT/last_status.json"; exit 1
fi
mv "$TMP" "$FILE"
sha256sum "$FILE" | awk '{print $1}' > "$FILE.sha256"
size=$(stat -c %s "$FILE")
log "dumped $DB_NAME: $FILE ($size bytes, $tables tables with data)"

# 2. Weekly copy (hard link: no extra space) on the chosen weekday.
if [ "$(date +%u)" = "$WEEKLY_DAY" ]; then
  ln -f "$FILE" "$BACKUP_ROOT/weekly/$(basename "$FILE")" && ln -f "$FILE.sha256" "$BACKUP_ROOT/weekly/$(basename "$FILE").sha256"
  log "kept as weekly"
fi

# 3. Retention by count, newest first: 7 daily, 4 weekly.
prune() { ls -1t "$1"/*.dump 2>/dev/null | tail -n +$(( $2 + 1 )) | while read -r old; do rm -f "$old" "$old.sha256"; log "pruned $old"; done; }
prune "$BACKUP_ROOT/daily" "$KEEP_DAILY"
prune "$BACKUP_ROOT/weekly" "$KEEP_WEEKLY"

# 4. Mirror to the other NUC (same retention: --delete removes what was pruned here).
if [ -n "$NUC_TARGET" ]; then
  ssh_cmd="ssh -o BatchMode=yes -o ConnectTimeout=20${NUC_SSH_KEY:+ -i $NUC_SSH_KEY}"
  if rsync -a --delete -e "$ssh_cmd" "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$NUC_TARGET/"; then nuc=ok; log "mirrored to $NUC_TARGET"
  else nuc=failed; failed=1; log "rsync to $NUC_TARGET failed"; fi
fi

# 5. Encrypted off-site copy to R2 with restic; restic keeps its own 7 daily + 4 weekly snapshots.
if [ -n "$RESTIC_REPOSITORY" ]; then
  if restic backup --quiet --tag dira --host dira-backup "$FILE" "$FILE.sha256" \
     && restic forget --quiet --tag dira --host dira-backup --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" --prune; then
    r2=ok; log "restic snapshot saved and pruned"
  else r2=failed; failed=1; log "restic backup to R2 failed"; fi
fi

echo "{\"at\":\"$(date -Is)\",\"ok\":$([ $failed = 0 ] && echo true || echo false),\"file\":\"$(basename "$FILE")\",\"bytes\":$size,\"tables\":$tables,\"sha256\":\"$(cat "$FILE.sha256")\",\"nuc\":\"$nuc\",\"r2\":\"$r2\"}" > "$BACKUP_ROOT/last_status.json"
log "done (nuc: $nuc, r2: $r2)"
exit $failed
