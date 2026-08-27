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

APP_DIR="${APP_DIR:-/srv/niko}"
SERVICE="${SERVICE:-niko}"
BRANCH="${BRANCH:-main}"

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
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree is not clean — commit, stash or revert on the server first"
fi

BEFORE="$(git rev-parse --short HEAD)"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
AFTER="$(git rev-parse --short HEAD)"
echo "    $BEFORE -> $AFTER"

# --omit=dev: the server bundle leaves every dependency external, so runtime
# deps must be present, but nothing needs vite, esbuild or typescript here.
echo "==> installing"
npm ci --omit=dev

# The build needs the dev toolchain, which --omit=dev just removed. Build on
# your machine and rsync dist/, or install everything here. Installing is the
# simpler default; drop SKIP_BUILD=1 in if you ship a prebuilt dist instead.
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> building"
  npm ci
  npm run build
fi

# Before the prune, not after: db:migrate runs through tsx, which is a dev
# dependency. Pruning first left every build-and-deploy failing on
# "sh: 1: tsx: not found" — after the new code was already on disk.
echo "==> migrating"
if [ -r "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
else
  die "cannot read $ENV_FILE — the migration needs DATABASE_URL"
fi
npm run db:migrate

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  npm prune --omit=dev
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
