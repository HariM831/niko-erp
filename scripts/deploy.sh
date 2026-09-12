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
export SKIP_BUILD="${SKIP_BUILD:-0}"

die() { echo "deploy: $*" >&2; exit 1; }

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

BEFORE="$(git rev-parse --short HEAD)"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
AFTER="$(git rev-parse --short HEAD)"
echo "    $BEFORE -> $AFTER"

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

# `npm ci` empties node_modules before it installs. So a prod-only install
# followed by a full one is not two steps of one job — the second throws the
# first away and does the work again. Install once, for the case at hand:
# everything when a build follows, runtime-only when a prebuilt dist is being
# shipped and the dev toolchain would never be touched.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> installing"
  npm ci "${NPM_FLAGS[@]}"
  echo "==> building"
  npm run build
else
  # The server bundle leaves every dependency external, so runtime deps must
  # be present — but nothing here needs vite, esbuild or typescript.
  echo "==> installing"
  npm ci --omit=dev "${NPM_FLAGS[@]}"
fi

# Before the prune, not after: db:migrate runs through tsx, which is a dev
# dependency. Pruning first left every build-and-deploy failing on
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

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm prune --omit=dev "${NPM_FLAGS[@]}"
fi

echo "==> restarting $SERVICE"
sudo systemctl restart "$SERVICE"

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
