# Rotate prod's JWT secret (Phesto applies; nothing here prints the secret)

Why both steps: access tokens are signed with `JWT_SECRET`, but refresh tokens are random strings in the
`refresh_tokens` table, so a new secret alone does not end sessions: clients refresh and carry on. Clearing the
table ends them. After this everyone logs in again by email code.

1. Backup first:

       DIRA_BACKUP_ENV=/opt/qusaz/shared/backup/dira/dira-backup.env /opt/qusaz/shared/backup/dira/dira-backup.sh

2. New 64-character secret, in place, never echoed (keeps a copy of the old .env, readable only by you):

       cd /opt/qusaz/dira/api
       cp -p .env .env.before-jwt-rotate-$(date +%Y%m%d) && chmod 600 .env.before-jwt-rotate-*
       NEW=$(openssl rand -hex 32)
       sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$NEW|" .env
       unset NEW
       grep -c '^JWT_SECRET=' .env                                   # 1
       awk -F= '/^JWT_SECRET=/{print length(substr($0, index($0,"=")+1))}' .env   # 64
       chmod 600 .env                                                # it is 664 (world-readable) today

3. Check dev and prod now differ (fingerprints only):

       f() { grep -E '^JWT_SECRET=' "$1" | cut -d= -f2- | sha256sum | cut -c1-16; }
       [ "$(f /opt/qusaz/dira/api/.env)" != "$(f /opt/qusaz/dira-dev/api/.env)" ] && echo differs || echo SAME

4. End the old sessions:

       docker exec qusaz-postgres psql -U postgres -d dira -c 'DELETE FROM refresh_tokens'

5. Restart and check:

       sudo systemctl restart dira-api
       sudo systemctl is-active dira-api
       curl -s http://127.0.0.1:4800/health | head -c 80; echo

6. Log in again in the app. The readonly golden check signs its own tokens from the new `.env`, so it keeps
   working: export DATABASE_URL and JWT_SECRET from /opt/qusaz/dira/api/.env as before.

Dev keeps its own secret (ops/backup/restore-into-dev.sh gives dev a new one whenever it matches prod's).
