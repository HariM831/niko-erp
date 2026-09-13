#!/usr/bin/env bash
#
# Bring the farm's records up to date from a fresh Amino export. Run on the
# Droplet, as the niko user, with the tarball the export produced:
#
#   cd /srv/niko && ./scripts/refresh-farm-from-amino.sh /tmp/farm-export.tgz
#
# Staging first, then production — the same script pointed at the other
# checkout, exactly as deploy.sh is:
#   APP_DIR=/srv/niko-staging SERVICE=niko-staging ./scripts/refresh-farm-from-amino.sh /tmp/farm-export.tgz
#
# The tarball is what `scripts/export-farm-for-eggsy.ts` in the Amino repo
# writes, run on Replit where Amino's database lives, then packed:
#   npx tsx scripts/export-farm-for-eggsy.ts && tar czf farm-export.tgz farm-export
#
# What happens, in order, and why it stops where it stops:
#   1. The export is unpacked over farm-export/ in the checkout. The previous
#      export's date is kept and printed next to the new one, so an old file
#      handed over by mistake is caught by eye before anything is read.
#   2. check-amino-export.ts reconciles the numbers. If the birds do not add up
#      the import would refuse half-way anyway; better to know first.
#   3. The import runs dry, then for real with --reset. niko's copy is
#      REPLACED, not merged: the imported flocks and everything hanging off
#      them are removed and written again from the new file. Anything recorded
#      in niko's own farm screens against those flocks would go with them —
#      which is why this script refuses to run once such records exist (the
#      two guards below).
#
# niko has been the system of record for the farm since 13 Sep 2026. This
# script exists for the export of that day and for a re-run of it; a later
# export can only get past the guards if nobody has entered a day in niko
# since, which is not how the farm is meant to run any more.
#   4. The Dr niko observations and their photographs follow; that import is
#      idempotent on Amino's id and adds only what is new.
#
set -euo pipefail

export APP_DIR="${APP_DIR:-/srv/niko}"
export SERVICE="${SERVICE:-niko}"

die() { echo "refresh-farm: $*" >&2; exit 1; }

TGZ="${1:-}"
[ -n "$TGZ" ] || die "usage: $0 <farm-export.tgz>"
[ -r "$TGZ" ] || die "cannot read $TGZ"
TGZ="$(readlink -f "$TGZ")"

if [ "$SERVICE" = "niko" ]; then
  ENV_FILE="/etc/niko/prod.env"
else
  ENV_FILE="/etc/niko/${SERVICE#niko-}.env"
fi
[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE"

cd "$APP_DIR" || die "no such directory: $APP_DIR"
echo "==> $SERVICE  ($APP_DIR)"

# Read, don't source — same reason as deploy.sh: DATABASE_URL carries an `&`.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  export "$key=$val"
done < "$ENV_FILE"
[ -n "${DATABASE_URL:-}" ] || die "no DATABASE_URL in $ENV_FILE"

# ── Guard: nothing of niko's own may hang off the flocks about to be replaced ──
# --reset removes the imported flocks and cascades through their placements.
# Once the farm records a vaccination, a weighing or a day in niko itself, or
# an owner statement has been raised from these transfers, this script is no
# longer the right tool and the import must become a merge. Refuse, loudly.
OWN="$(psql "$DATABASE_URL" -tAc "
  SELECT (SELECT count(*) FROM vaccination_events)
       + (SELECT count(*) FROM owner_billing_runs)
       + (SELECT count(*) FROM feed_transfers WHERE number LIKE 'AMN-FT-%' AND journal_entry_id IS NOT NULL)
" | tr -d '[:space:]')"
[ "$OWN" = "0" ] || die "$OWN row(s) recorded in niko depend on the imported farm — a reset would destroy them; stop and decide"

# ── 1. Unpack ─────────────────────────────────────────────────────────────
PREV="none"
if [ -r farm-export/farm-export.json ]; then
  PREV="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("farm-export/farm-export.json","utf8")).exportedAt)')"
fi
# `tar czf x.tgz farm-export` and `tar czf x.tgz ./farm-export` both happen.
# Not `grep -q`: it stops at the first match, tar dies of SIGPIPE, and under
# pipefail the pipeline fails on a tarball that was perfectly fine.
tar tzf "$TGZ" | grep -xE '(\./)?farm-export/farm-export.json' >/dev/null || die "$TGZ does not contain farm-export/farm-export.json"
rm -rf farm-export
tar xzf "$TGZ"
NEXT="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("farm-export/farm-export.json","utf8")).exportedAt)')"
echo "==> export on disk was $PREV"
echo "==> export now is     $NEXT"

# ── Guard: niko must not hold a day newer than the export ─────────────────
# niko is the system of record since 13 Sep 2026. A day sheet or a weighing in
# niko dated after the last one in the export can only have been entered here,
# and --reset would delete it and write Amino's older record in its place.
# Refused before anything is read, so the export on disk is the only change.
EXPORT_TO="$(node -e '
  const m = JSON.parse(require("fs").readFileSync("farm-export/farm-export.json","utf8")).manifest;
  const t = (n) => (m.find((x) => x.table === n)?.to ?? "").slice(0, 10);
  console.log(t("daily_bird_records") + " " + t("weekly_bird_weights"));
')"
EXPORT_DAYS_TO="${EXPORT_TO% *}"
EXPORT_WEIGHTS_TO="${EXPORT_TO#* }"
NIKO_DAYS_TO="$(psql "$DATABASE_URL" -tAc "SELECT coalesce(max(day)::text, '') FROM placement_days" | tr -d '[:space:]')"
NIKO_WEIGHTS_TO="$(psql "$DATABASE_URL" -tAc "SELECT coalesce(max(weighed_on)::text, '') FROM bird_weighings" | tr -d '[:space:]')"
echo "==> daily sheet: export to ${EXPORT_DAYS_TO:-none}, niko to ${NIKO_DAYS_TO:-none}"
echo "==> weighings:   export to ${EXPORT_WEIGHTS_TO:-none}, niko to ${NIKO_WEIGHTS_TO:-none}"
if [ -n "$NIKO_DAYS_TO" ] && [[ "$NIKO_DAYS_TO" > "$EXPORT_DAYS_TO" ]]; then
  die "niko holds a day sheet dated $NIKO_DAYS_TO, newer than the export's $EXPORT_DAYS_TO — entered in niko, and a reset would destroy it; stop"
fi
if [ -n "$NIKO_WEIGHTS_TO" ] && [[ "$NIKO_WEIGHTS_TO" > "$EXPORT_WEIGHTS_TO" ]]; then
  die "niko holds a weighing dated $NIKO_WEIGHTS_TO, newer than the export's $EXPORT_WEIGHTS_TO — entered in niko, and a reset would destroy it; stop"
fi
node -e '
  const m = JSON.parse(require("fs").readFileSync("farm-export/farm-export.json","utf8")).manifest;
  for (const t of m) console.log("    " + t.table.padEnd(22) + String(t.rows).padStart(7) + (t.from ? "   " + t.from.slice(0,10) + " … " + (t.to||"").slice(0,10) : ""));
'

# deploy.sh ends with `npm prune --omit=dev`, so tsx is not installed; --yes fetches it.
TSX=(npx --yes tsx)

# ── 2. Reconcile ──────────────────────────────────────────────────────────
echo "==> reconciling"
"${TSX[@]}" scripts/check-amino-export.ts --file farm-export/farm-export.json

# ── 3. Import: dry, then for real ─────────────────────────────────────────
echo "==> import, dry run"
"${TSX[@]}" scripts/import-from-amino.ts --file farm-export/farm-export.json
echo "==> import, applying with --reset"
"${TSX[@]}" scripts/import-from-amino.ts --file farm-export/farm-export.json --apply --reset

# ── 4. Dr niko observations and photographs ───────────────────────────────
echo "==> Dr niko observations"
"${TSX[@]}" scripts/import-dr-eggsy.ts --apply

echo
echo "==> where the records now end"
psql "$DATABASE_URL" -tA -F ' | ' -c "
  SELECT 'flocks', string_agg(code || ' ' || status, ', ' ORDER BY code) FROM flocks
  UNION ALL SELECT 'daily sheet to', max(day)::text FROM placement_days
  UNION ALL SELECT 'weighings to', max(weighed_on)::text FROM bird_weighings
  UNION ALL SELECT 'feed transfers to', max(transfer_date)::text FROM feed_transfers WHERE number LIKE 'AMN-FT-%'
  UNION ALL SELECT 'observations', count(*)::text FROM ai_observations
" | sed 's/^/    /'
echo
echo "Farm refreshed from the Amino export of $NEXT."
