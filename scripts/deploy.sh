#!/usr/bin/env bash
#
# Pull, build, migrate, restart. Run on the Droplet, as the niko user.
#
#   cd /srv/niko && ./scripts/deploy.sh
#
# Staging is the same script pointed at the other checkout:
#   SERVICE=niko-staging APP_DIR=/srv/niko-staging ./scripts/deploy.sh
#
# The order matters. Migrations run *before* the new code starts, because a
# release that adds a column and the code that reads it must not be live in
# the wrong order — the old process tolerates a column it doesn't know about,
# the new one cannot tolerate a column that isn't there yet.
#
set -euo pipefail

# Exported so the re-exec below inherits them rather than falling back to the
# production defaults — a staging deploy that forgot which checkout it was in
# would restart the wrong service.
export APP_DIR="${APP_DIR:-/srv/niko}"
export SERVICE="${SERVICE:-niko}"
export BRANCH="${BRANCH:-main}"

die() { echo "deploy: $*" >&2; exit 1; }

# SKIP_BUILD used to mean "a prebuilt dist is being shipped, so skip the build".
# It never once worked: that path installed with --omit=dev, and the migration
# two steps later runs through tsx, which is a dev dependency, so every such
# deploy died on "sh: 1: tsx: not found" — after `git reset --hard` had already
# advanced the checkout, leaving the new code on disk, the database unmigrated
# and the old process still serving from memory. That is how it was found, on
# staging, on 14 Oct 2026.
#
# Installing the dev dependencies would have fixed the symptom and left the
# mode unsafe. `dist/` is gitignored, so no prebuilt bundle ever arrives with
# the checkout: skipping the build would restart the service on the bundle from
# a *previous* commit against a database just migrated to this one — the
# version skew the note at the top of this file exists to prevent. Nothing
# passed it and the README never documented it, so it is gone rather than
# mended.
#
# Refused, not ignored: silently doing a full deploy would mean somebody
# expecting a shortcut waits through a build wondering why.
#
# An `x && y` statement would be the last command in the script's eyes, and a
# false test makes it return 1 — which under `set -e` exits the deploy.
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  die "SKIP_BUILD is not supported. The migration runs through tsx, a dev
  dependency, and dist/ never ships with the checkout — a deploy that skipped
  the build would run the previous commit's bundle against this commit's
  database. Re-run without it."
fi

# The service reads its environment from here via systemd. The migration runs
# in this shell instead, which systemd never touches, so it has to be loaded by
# hand or db:migrate dies on "DATABASE_URL must be set". Kept out of the log and
# out of the exported environment of anything but the migrate — the file holds
# the database password and the session secret.
# An `x && y` statement would be the last command in the script's eyes, and a
# false test makes it return 1 — which under `set -e` exits the deploy.
if [ "$SERVICE" = "niko" ]; then
  ENV_FILE="/etc/niko/prod.env"
else
  ENV_FILE="/etc/niko/${SERVICE#niko-}.env"
fi

cd "$APP_DIR" || die "no such directory: $APP_DIR"
[ -d .git ] || die "$APP_DIR is not a git checkout"

# One deploy per checkout at a time. `npm ci` empties node_modules before it
# installs, so two deploys of the same checkout delete each other's install
# mid-build: on 21 Sep 2026 two sessions deployed staging within seconds of each
# other and both died on "vite: not found", leaving a service that was up only
# because the old process was still in memory.
#
# Per checkout, not per machine — prod and staging share nothing and may deploy
# side by side. Inside .git so it never shows in `git status` and the reset
# below cannot touch it. The second deploy waits rather than fails: it was asked
# to ship something, and what it ships is fetched after the wait, so it is never
# stale.
#
# The lock lives on fd 9 and is held until the script exits. `exec` keeps open
# descriptors, so a re-exec'd copy already holds it — NIKO_DEPLOY_LOCKED says so,
# because opening the file again would drop the lock for an instant and let a
# waiter in. The variable alone is not believed: without fd 9 actually open
# there is no lock, whatever the environment claims.
if [ "${NIKO_DEPLOY_LOCKED:-0}" != "1" ] || [ ! -e "/proc/$$/fd/9" ]; then
  exec 9>"$APP_DIR/.git/deploy.lock"
  if ! flock -n 9; then
    echo "==> another deploy of $APP_DIR is running; waiting for it (up to 15 min)"
    flock -w 900 9 || die "gave up waiting for the other deploy of $APP_DIR"
    # That deploy reset the checkout while this shell sat here with deploy.sh
    # half read — the same hazard as the re-exec further down. Start over.
    NIKO_DEPLOY_LOCKED=1 exec bash "$APP_DIR/scripts/deploy.sh"
  fi
  export NIKO_DEPLOY_LOCKED=1
fi

echo "==> $SERVICE  ($APP_DIR, branch $BRANCH)"

# A deploy that would silently discard someone's hand-edit on the server is a
# deploy that loses work. Refuse instead.
#
# TRACKED changes only. `git reset --hard` below leaves untracked files alone,
# so they are never the work at risk — refusing on them only means a stray
# scratch file in the checkout blocks every future deploy for no reason.
#
# Except the lockfile, which this script dirties itself. The Droplet's npm is
# older than the one the lockfile was written with and drops the `libc` fields
# it doesn't know, so every `npm ci` below rewrites the file and every NEXT
# deploy refused to start. Nobody hand-edits a lockfile on a server, and the
# reset restores it a few lines down regardless.
DIRTY="$(git status --porcelain --untracked-files=no -- . ':(exclude)package-lock.json')"
if [ -n "$DIRTY" ]; then
  echo "$DIRTY"
  die "working tree has local changes — commit, stash or revert on the server first"
fi

# Read by the trap below, which runs for the restart too and must not claim the
# service is untouched once it has been bounced.
RESTARTED=0

BEFORE="$(git rev-parse --short HEAD)"
# Exported so the re-exec below still knows where this deploy started. Its
# second pass resets an already-reset checkout, so its own BEFORE is the new
# commit and would have nothing to report.
export NIKO_DEPLOY_BEFORE="${NIKO_DEPLOY_BEFORE:-$BEFORE}"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
AFTER="$(git rev-parse --short HEAD)"
echo "    $BEFORE -> $AFTER"

# The checkout is now at the new commit while the database, the bundle in dist/
# and the running process are all still at the old one. A failure from here to
# the restart is not a no-op, and nothing else says so: the deploy that found
# the SKIP_BUILD bug printed npm's "tsx: not found" and stopped, which reads
# like nothing happened. The next restart — a reboot, or somebody's
# `systemctl restart` — would bring up whatever the half-finished state left.
trap 'code=$?; if [ "$code" -ne 0 ]; then
  echo >&2
  echo "deploy: FAILED with the checkout already moved to $AFTER." >&2
  echo "  Started at $NIKO_DEPLOY_BEFORE. The database may not have migrated," >&2
  echo "  and dist/ may still hold the bundle built from an earlier commit." >&2
  if [ "$RESTARTED" -eq 0 ]; then
    echo "  $SERVICE was NOT restarted — it is still serving the old code from" >&2
    echo "  memory, so the site is up and stays up until something restarts it." >&2
  else
    echo "  $SERVICE HAS been restarted onto this state." >&2
  fi
  echo "  Fix the cause and re-run this script, or go back with:" >&2
  echo "    cd $APP_DIR && git reset --hard $NIKO_DEPLOY_BEFORE && npm ci && npm run build" >&2
fi' EXIT

# This script is inside the checkout it just replaced. bash reads a script
# lazily, by byte offset, so when the reset above rewrites deploy.sh the running
# shell carries on at the same offset into a different file — executing whatever
# now happens to sit there. That is how a fix to this file appeared not to work
# twice in a row: the corrected version was on disk and the old one was running.
# Start the new file over from the top, once.
if [ "${NIKO_DEPLOY_REEXEC:-0}" != "1" ] && [ "$BEFORE" != "$AFTER" ]; then
  echo "==> deploy.sh may have changed; restarting it"
  NIKO_DEPLOY_REEXEC=1 exec bash "$APP_DIR/scripts/deploy.sh"
fi

# npm ends an install by asking the registry about advisories and funding.
# Neither answer changes a byte of what lands in node_modules, and both are
# network round-trips that npm waits on. They are what turned a prune with no
# work to do into `up to date in 6m` — six minutes, nothing removed. Off for
# every npm call in this script.
NPM_FLAGS=(--no-audit --no-fund)

# Everything, including the dev toolchain: the build needs vite and esbuild,
# and the migration a few lines down needs tsx. The prune after the migration
# is what takes node_modules back down to the runtime set.
#
# `npm ci` empties node_modules before it installs, so a prod-only install
# followed by a full one would not be two steps of one job — the second throws
# the first away and does the work again. Install once, completely.
echo "==> installing"
npm ci "${NPM_FLAGS[@]}"
echo "==> building"
npm run build

# Before the prune, not after: db:migrate runs through tsx, which is a dev
# dependency. Pruning first left every deploy failing on
# "sh: 1: tsx: not found" — after the new code was already on disk.
echo "==> migrating"
[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE — the migration needs DATABASE_URL"
#
# Read, don't source. systemd parses an EnvironmentFile literally; bash does
# not, and DATABASE_URL carries an `&` from `&sslrootcert=`. Sourcing it ran
# everything up to the ampersand as a background job, so the assignment landed
# in a subshell and DATABASE_URL arrived empty — the service was fine the whole
# time, because systemd never went through a shell.
#
# The expansion below is quoted, so `&`, `?` and spaces in a value stay put.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) continue ;; esac
  key="${line%%=*}"
  val="${line#*=}"
  # systemd strips a single layer of matching quotes; match that.
  case "$val" in
    \"*\") val="${val#\"}"; val="${val%\"}" ;;
    \'*\') val="${val#\'}"; val="${val%\'}" ;;
  esac
  export "$key=$val"
done < "$ENV_FILE"
[ -n "${DATABASE_URL:-}" ] || die "no DATABASE_URL in $ENV_FILE"
npm run db:migrate

npm prune --omit=dev "${NPM_FLAGS[@]}"

echo "==> restarting $SERVICE"
sudo systemctl restart "$SERVICE"
RESTARTED=1

# systemd reports a start as successful the moment the process is spawned, so
# "restarted" on its own proves nothing. Wait for the port to actually answer.
PORT="$(grep -oP '^PORT=\K.*' "$ENV_FILE" 2>/dev/null || echo 3000)"
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/auth/me" \
     || [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/auth/me")" = "401" ]; then
    echo "==> $SERVICE is answering on :${PORT}"
    echo
    echo "Deployed $AFTER."
    exit 0
  fi
  sleep 1
done

echo "deploy: $SERVICE did not answer on :${PORT} within 20s" >&2
echo "  journalctl -u $SERVICE -n 50 --no-pager" >&2
exit 1
