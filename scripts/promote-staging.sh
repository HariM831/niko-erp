#!/usr/bin/env bash
#
# Staging becomes production (decided 27 Sep 2026, switched 30 Sep 2026).
#
# Staging's database is the one the farm has been working in — purchases,
# payroll, gates, canteen, the mill, the sheds' daily records, and the sales
# brought across from Amino. Production's database holds one thing staging
# does not: the live shed feed. aminofarms.com has polled the controllers since
# July and is where ventilation rules are set and proposals approved and
# written, so its iot_* and controller_* tables are newer than staging's copy.
#
# So: staging's database is restored into production's own database (`niko`,
# the one prod.env already names — nothing in the app's config changes), and
# production's shed tables are laid back over the top. Every login comes with
# its password as it is on staging (the user, 30 Sep 2026), except the test
# logins, which do not come at all. Uploaded files, which live on disk and not
# in the database, are copied across.
#
# Usage, on the droplet, as root:
#   scripts/promote-staging.sh --rehearse   builds niko_rehearsal, checks it, drops it;
#                                           no service is stopped, nothing live is written
#   scripts/promote-staging.sh --switch     the real thing
#
# Both take fresh backups of both databases into /var/backups/niko/<stamp>/
# first. Rolling the switch back is restoring prod.dump from there.
#
set -euo pipefail

MODE="${1:-}"
case "$MODE" in --rehearse|--switch) ;; *) echo "usage: $0 --rehearse|--switch" >&2; exit 2 ;; esac

die() { echo "promote-staging: $*" >&2; exit 1; }
say() { echo "==> $*"; }

# The env files are read, not sourced: DATABASE_URL carries an `&` that a
# shell assignment would take as "run in the background".
env_url() { sed -n 's/^DATABASE_URL=//p' "$1" | tail -1 | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"; }
PROD_URL="$(env_url /etc/niko/prod.env)"
STAGING_URL="$(env_url /etc/niko/staging.env)"
db_name() { local p="${1%%\?*}"; echo "${p##*/}"; }
with_db() { local base="${1%%\?*}" q=""; [ "$1" != "$base" ] && q="?${1#*\?}"; echo "${base%/*}/$2$q"; }

[ "$(db_name "$PROD_URL")" = "niko" ]            || die "prod.env does not name the database 'niko'"
[ "$(db_name "$STAGING_URL")" = "niko_staging" ] || die "staging.env does not name the database 'niko_staging'"

if [ "$MODE" = "--switch" ]; then
  TARGET_URL="$PROD_URL"
else
  TARGET_URL="$(with_db "$PROD_URL" niko_rehearsal)"
fi
TARGET_DB="$(db_name "$TARGET_URL")"

# Production's own shed feed — the only tables where production is ahead.
SHED_TABLES=(iot_house_sample iot_house_day iot_poll_log iot_readings
             controller_snapshots controller_proposals controller_changes controller_rules)
TEST_LOGINS="'test.mill','test.director'"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP="/var/backups/niko/$STAMP"
mkdir -p "$BACKUP"; chmod 700 "$BACKUP"

say "mode $MODE → target database $TARGET_DB"

# ── 1. Quiet ────────────────────────────────────────────────────────────────
# For the real switch both apps stop first: staging so nobody keys an entry
# the copy would miss, production so the shed poll adds no sample after the
# shed tables are taken.
if [ "$MODE" = "--switch" ]; then
  say "stopping niko-staging and niko"
  systemctl stop niko-staging niko
fi

# ── 2. Backups ──────────────────────────────────────────────────────────────
say "backing up both databases into $BACKUP"
pg_dump -Fc --no-owner --no-privileges "$PROD_URL"    -f "$BACKUP/prod.dump"
pg_dump -Fc --no-owner --no-privileges "$STAGING_URL" -f "$BACKUP/staging.dump"
T_ARGS=(); for t in "${SHED_TABLES[@]}"; do T_ARGS+=(-t "public.$t"); done
pg_dump -Fc --data-only --no-owner --no-privileges "${T_ARGS[@]}" "$PROD_URL" -f "$BACKUP/prod-shed.dump"
ls -lh "$BACKUP"

# ── 3. Target ───────────────────────────────────────────────────────────────
if [ "$MODE" = "--rehearse" ]; then
  say "creating $TARGET_DB"
  psql "$PROD_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS niko_rehearsal" -c "CREATE DATABASE niko_rehearsal"
fi

say "replacing $TARGET_DB with staging"
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q \
  -c "DROP SCHEMA IF EXISTS public CASCADE" -c "DROP SCHEMA IF EXISTS drizzle CASCADE" -c "CREATE SCHEMA public"
pg_restore -d "$TARGET_URL" --no-owner --no-privileges --exit-on-error "$BACKUP/staging.dump"

# ── 4. Production's shed feed over the top ─────────────────────────────────
say "laying production's shed tables back"
LIST="$(IFS=,; echo "${SHED_TABLES[*]}")"
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q -c "TRUNCATE $LIST"
pg_restore -d "$TARGET_URL" --no-owner --no-privileges --data-only --exit-on-error "$BACKUP/prod-shed.dump"
# Serial ids carry on from the highest row now present.
for t in "${SHED_TABLES[@]}"; do
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q -At -c "
    SELECT setval(pg_get_serial_sequence('$t', 'id'), COALESCE(max(id), 1), max(id) IS NOT NULL) FROM $t
     WHERE pg_get_serial_sequence('$t', 'id') IS NOT NULL" >/dev/null 2>&1 || true
done

# ── 5. Logins ───────────────────────────────────────────────────────────────
# Everyone else keeps their staging password untouched.
say "leaving the test logins behind; clearing sessions"
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q <<SQL
UPDATE activity_log SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE username IN ($TEST_LOGINS));
DELETE FROM users WHERE username IN ($TEST_LOGINS);
DELETE FROM user_sessions;
SQL

# ── 6. Checks ───────────────────────────────────────────────────────────────
say "checking"
count_all() {
  psql "$1" -X -At -F'=' <<'SQL'
CREATE TEMP TABLE c(t text, n bigint);
DO $$ DECLARE r record; n bigint; BEGIN
  FOR r IN SELECT table_name FROM information_schema.tables
            WHERE table_schema='public' AND table_type='BASE TABLE' LOOP
    EXECUTE format('select count(*) from %I', r.table_name) INTO n;
    INSERT INTO c VALUES (r.table_name, n);
  END LOOP; END $$;
SELECT t, n FROM c ORDER BY t;
SQL
}
count_all "$STAGING_URL" | grep '=' > "$BACKUP/count-staging.txt"
count_all "$PROD_URL"    | grep '=' > "$BACKUP/count-prod.txt"
count_all "$TARGET_URL"  | grep '=' > "$BACKUP/count-target.txt"

TESTS="$(psql "$STAGING_URL" -At -c "select count(*) from users where username in ($TEST_LOGINS)")"
BAD=0
while IFS='=' read -r t n; do
  [ -n "$t" ] || continue
  if printf '%s\n' "${SHED_TABLES[@]}" | grep -qx "$t"; then
    want="$(grep "^$t=" "$BACKUP/count-prod.txt" | cut -d= -f2)"; from=production
  else
    want="$(grep "^$t=" "$BACKUP/count-staging.txt" | cut -d= -f2)"; from=staging
    case "$t" in
      users)         want=$((want - TESTS)) ;;
      user_sessions) want=0 ;;
    esac
  fi
  # Staging is live during a rehearsal: a row keyed mid-run is not a fault.
  if [ "$n" != "$want" ]; then echo "    MISMATCH $t: $n, $from has $want"; BAD=1; fi
done < "$BACKUP/count-target.txt"

ledger() { psql "$1" -At -c "select sum(debit)::text||' / '||sum(credit)::text from journal_entry_lines"; }
L_TARGET="$(ledger "$TARGET_URL")"; L_STAGING="$(ledger "$STAGING_URL")"
echo "    ledger debits / credits: staging now $L_STAGING, target $L_TARGET"
[ "$L_STAGING" = "$L_TARGET" ] || { echo "    MISMATCH ledger"; BAD=1; }
MIG_S="$(psql "$STAGING_URL" -At -c "select count(*) from drizzle.__drizzle_migrations")"
MIG_T="$(psql "$TARGET_URL"  -At -c "select count(*) from drizzle.__drizzle_migrations")"
echo "    migrations: staging $MIG_S, target $MIG_T"
[ "$MIG_S" = "$MIG_T" ] || { echo "    MISMATCH migrations"; BAD=1; }
# Every login that came must sign in exactly as it did on staging.
PW="$(psql "$STAGING_URL" -At -c "select md5(string_agg(username||password_hash, ',' order by username)) from users where username not in ($TEST_LOGINS)")"
PW_T="$(psql "$TARGET_URL" -At -c "select md5(string_agg(username||password_hash, ',' order by username)) from users")"
[ "$PW" = "$PW_T" ] && echo "    passwords: identical to staging" || { echo "    MISMATCH passwords"; BAD=1; }
echo "    logins: $(psql "$TARGET_URL" -At -c "select string_agg(username, ', ' order by username) from users")"

# ── 7. Files, and back up ──────────────────────────────────────────────────
if [ "$MODE" = "--rehearse" ]; then
  echo "    uploads to copy: $(rsync -a --dry-run --itemize-changes /srv/niko-staging/uploads/ /srv/niko/uploads/ | grep -c '^>f' || true) file(s)"
  say "dropping niko_rehearsal"
  psql "$PROD_URL" -q -c "DROP DATABASE niko_rehearsal"
  [ "$BAD" = 0 ] && say "rehearsal clean — backups kept in $BACKUP" || die "rehearsal found mismatches (see above)"
  exit 0
fi

[ "$BAD" = 0 ] || die "mismatches after the restore — both apps LEFT STOPPED. Roll back: pg_restore $BACKUP/prod.dump into niko"

say "copying uploaded files"
rsync -a /srv/niko-staging/uploads/ /srv/niko/uploads/
chown -R niko:niko /srv/niko/uploads

say "starting niko"
systemctl start niko
say "switched. Staging stays stopped until it is rebuilt as a sandbox from production."
