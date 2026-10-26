#!/usr/bin/env bash
# Safe self-update: only switches to the new version if it installs and
# passes its self-tests; otherwise goes back to the version that was running.
# Started by the "Check for update" button, or run by hand: ./scripts/update.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
say() { echo "[$(date '+%H:%M:%S')] $*"; }

restart() {
  # systemd restarts the service when its main process exits.
  local pid
  pid="$(systemctl show -p MainPID --value tollpower 2>/dev/null || echo 0)"
  if [[ "$pid" != "0" && -n "$pid" ]]; then
    say "Restarting Tollpower..."
    kill -TERM "$pid"
  else
    say "Not running as a service; restart it yourself."
  fi
}

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  say "Local changes found in the code folder; not updating. (Run 'git status' to see them.)"
  say "Update finished: nothing changed."
  exit 1
fi

OLD="$(git rev-parse HEAD)"
UPSTREAM="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null || echo origin/main)"
say "Checking GitHub for a newer version ($UPSTREAM)..."
if ! git fetch --quiet; then
  say "Could not reach GitHub. Check the Pi's internet connection."
  say "Update finished: nothing changed."
  exit 1
fi

if [[ "$(git rev-parse "$UPSTREAM")" == "$OLD" ]]; then
  say "Already up to date ($(git rev-parse --short HEAD))."
  exit 0
fi

say "New version found. Changes:"
git log --oneline "$OLD..$UPSTREAM" | head -20

rollback() {
  say "Problem: $1. Going back to the previous version."
  git reset --hard --quiet "$OLD"
  npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || true
  say "Update rolled back. Still running $(git rev-parse --short HEAD)."
  exit 1
}

git merge --ff-only --quiet "$UPSTREAM" || rollback "the new version could not be applied cleanly"
say "Installing..."
npm ci --omit=dev --no-audit --no-fund || rollback "installing dependencies failed"
say "Running self-tests..."
npm test --silent || rollback "self-tests failed"

say "Update finished: now on $(git rev-parse --short HEAD)."
restart
