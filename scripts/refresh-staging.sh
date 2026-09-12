#!/usr/bin/env bash
#
# Rebuild the staging database from production, with the payment credentials
# taken out.
#
# Staging exists so a change can be tried against real volumes and real edge
# cases before it touches the books. That means a copy of production — and a
# copy of production also means every vendor's bank account, every employee's
# salary account, and every password hash, sitting on a box that more people
# can reach. So the copy is scrubbed on the way in, and the scrub is verified
# afterwards rather than assumed: a scrub that silently did nothing leaves
# real payment credentials on staging with nobody aware of it.
#
# Fake account numbers are not a limitation here, they are the point. A
# staging payment file built from them fails harmlessly at the bank; one built
# from real numbers does not.
#
# Usage, on the Droplet:
#   PROD_DATABASE_URL=... STAGING_DATABASE_URL=... ./scripts/refresh-staging.sh
#
# Optional:
#   STAGING_SERVICE   systemd unit to stop/start around the restore
#                     (default: niko-staging)
#   STAGING_PASSWORD  password every staging login is reset to
#                     (default: staging)
#
set -euo pipefail

PROD_URL="${PROD_DATABASE_URL:-}"
STAGING_URL="${STAGING_DATABASE_URL:-}"
SERVICE="${STAGING_SERVICE:-niko-staging}"
STAGING_PW="${STAGING_PASSWORD:-staging123}"

die() { echo "refresh-staging: $*" >&2; exit 1; }

# ── Guards ────────────────────────────────────────────────────────────────
# The whole script is destructive against whatever STAGING_DATABASE_URL names,
# so it has to be impossible for that to be production. Three independent
# checks, because one typo in an env file should not be able to drop the books.

[ -n "$PROD_URL" ]    || die "PROD_DATABASE_URL is not set"
[ -n "$STAGING_URL" ] || die "STAGING_DATABASE_URL is not set"
[ "$PROD_URL" != "$STAGING_URL" ] || die "staging and production are the same URL — refusing"

# Database name is the last path segment, minus any ?sslmode=... query.
db_name() { local p="${1##*/}"; echo "${p%%\?*}"; }
PROD_DB="$(db_name "$PROD_URL")"
STAGING_DB="$(db_name "$STAGING_URL")"

[ "$PROD_DB" != "$STAGING_DB" ] || die "both URLs name the database '$PROD_DB' — refusing"
case "$STAGING_DB" in
  *staging*|*test*) ;;
  *) die "'$STAGING_DB' is not named like a staging database — refusing" ;;
esac

command -v pg_dump    >/dev/null || die "pg_dump not found"
command -v pg_restore >/dev/null || die "pg_restore not found"
command -v psql       >/dev/null || die "psql not found"

DUMP="$(mktemp -t niko-prod-XXXXXX.dump)"
cleanup() { rm -f "$DUMP"; }
trap cleanup EXIT

echo "==> production : $PROD_DB"
echo "==> staging    : $STAGING_DB  (will be replaced)"

# ── 1. Stop the staging app ───────────────────────────────────────────────
# Its connection pool would otherwise hold the database open, and the restore
# would half-apply against a live app. Ignored when the unit isn't installed,
# so this script also works from a laptop against a local staging database.
if command -v systemctl >/dev/null && systemctl list-units --full -all \
     | grep -Fq "${SERVICE}.service"; then
  echo "==> stopping ${SERVICE}"
  sudo systemctl stop "$SERVICE"
  STOPPED=1
fi

# ── 2. Dump production ────────────────────────────────────────────────────
# Read-only: pg_dump takes a consistent snapshot and holds no lock that blocks
# ordinary work, so this is safe to run while people are using the app.
echo "==> dumping production"
pg_dump -Fc --no-owner --no-privileges "$PROD_URL" -f "$DUMP"
echo "    $(du -h "$DUMP" | cut -f1)"

# ── 3. Replace staging ────────────────────────────────────────────────────
# DigitalOcean's managed Postgres gives no superuser, so the schema is dropped
# and rebuilt in place rather than the database being dropped and recreated.
# --no-owner/--no-privileges keep the restore quiet about roles that only
# exist on the managed side.
echo "==> restoring into $STAGING_DB"
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -q \
  -c "DROP SCHEMA IF EXISTS public CASCADE;" \
  -c "CREATE SCHEMA public;"
pg_restore -d "$STAGING_URL" --no-owner --no-privileges --schema=public "$DUMP" 2>&1 \
  | grep -v "^pg_restore: warning: errors ignored on restore" || true

# ── 4. Scrub ──────────────────────────────────────────────────────────────
# Anything that could move money, plus the password hashes. Tax identifiers
# are deliberately left alone: they are printed on documents anyway, and
# invoices need them to render realistically.
echo "==> scrubbing payment credentials"
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
UPDATE bank_accounts      SET account_number = NULL, bank_customer_code = NULL;
UPDATE contacts           SET bank_account_number = NULL, bank_ifsc = NULL,
                              bank_beneficiary_name = NULL;
UPDATE employees          SET bank_account_number = NULL, bank_ifsc = NULL;
UPDATE salary_slips       SET bank_account_number = NULL, bank_ifsc = NULL;
UPDATE payment_batch_lines SET account_number = 'SCRUBBED', ifsc = 'SCRUBBED';
SQL

# Every staging login becomes the same known password. Production hashes have
# no business on a lower-trust box, and whoever is testing needs a way in.
echo "==> resetting staging logins"
HASH="$(node -e '
  const { randomBytes, scryptSync } = require("node:crypto");
  const salt = randomBytes(16).toString("hex");
  process.stdout.write(salt + ":" + scryptSync(process.argv[1], salt, 64).toString("hex"));
' "$STAGING_PW")"
psql "$STAGING_URL" -v ON_ERROR_STOP=1 -q \
  -c "UPDATE users SET password_hash = '$HASH';"

# ── 5. Verify the scrub actually happened ─────────────────────────────────
# The step that matters most is the one most likely to fail quietly — a
# renamed column makes the UPDATE a no-op under some settings, and staging
# would then hold live bank details looking perfectly normal.
echo "==> verifying"
LEFT="$(psql "$STAGING_URL" -tAc "
  SELECT
    (SELECT count(*) FROM bank_accounts WHERE account_number IS NOT NULL
                                            OR bank_customer_code IS NOT NULL)
  + (SELECT count(*) FROM contacts      WHERE bank_account_number IS NOT NULL
                                            OR bank_ifsc IS NOT NULL)
  + (SELECT count(*) FROM employees     WHERE bank_account_number IS NOT NULL
                                            OR bank_ifsc IS NOT NULL)
  + (SELECT count(*) FROM salary_slips  WHERE bank_account_number IS NOT NULL
                                            OR bank_ifsc IS NOT NULL)
")"
[ "$LEFT" = "0" ] || die "SCRUB FAILED — $LEFT row(s) still hold bank details. Staging left stopped."

ROWS="$(psql "$STAGING_URL" -tAc "SELECT count(*) FROM contacts")"
echo "    scrub clean; $ROWS contacts restored"

# ── 6. Start staging again ────────────────────────────────────────────────
if [ "${STOPPED:-0}" = "1" ]; then
  echo "==> starting ${SERVICE}"
  sudo systemctl start "$SERVICE"
fi

echo
echo "Staging rebuilt from production."
echo "  every login: password '${STAGING_PW}'"
echo "  bank details are blank by design — seed fake ones to test a payment run"
