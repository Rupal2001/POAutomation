#!/usr/bin/env bash

# One-command local installer/launcher for StyleFlow on macOS.
# It deliberately uses an app-owned PostgreSQL cluster instead of
# `brew services`, so launchctl failures and old local DB passwords cannot
# interfere with this workspace.

set -Eeuo pipefail
IFS=$'\n\t'

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
APP_PORT=3000
PG_PORT=55432
DB_ROLE="styleflow"
DB_NAME="po_ledger"
SUPPORT_DIR="$HOME/Library/Application Support/StyleFlow"
PG_DATA_DIR="$SUPPORT_DIR/postgres-16"
PG_SOCKET_DIR="${TMPDIR:-/tmp}/styleflow-pg-$(id -u)"
PG_LOG_FILE="$SUPPORT_DIR/postgres-16.log"
DEMO_COMPLETE_MARKER="$SUPPORT_DIR/noise-demo-v2.complete"
DEMO_IN_PROGRESS_MARKER="$SUPPORT_DIR/noise-demo-v2.in-progress"
TEMP_DIR=""
BOOTSTRAP_PID=""
SUPERUSER_PASSWORD_FILE=""
FRESH_CLUSTER=false
NEW_APP_DATABASE=false
MANAGE_DATABASE=false

say() {
  printf '\n\033[1;35mStyleFlow\033[0m  %s\n' "$1"
}

fail() {
  printf '\n\033[1;31mSetup stopped:\033[0m %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [ -n "${BOOTSTRAP_PID:-}" ] && kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
    kill "$BOOTSTRAP_PID" 2>/dev/null || true
    wait "$BOOTSTRAP_PID" 2>/dev/null || true
  fi
  BOOTSTRAP_PID=""
  if [ -n "${TEMP_DIR:-}" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
  TEMP_DIR=""
  if [ -n "${SUPERUSER_PASSWORD_FILE:-}" ] && [ -f "$SUPERUSER_PASSWORD_FILE" ]; then
    rm -f "$SUPERUSER_PASSWORD_FILE"
  fi
  SUPERUSER_PASSWORD_FILE=""
}

finish() {
  cleanup
  if [ "$MANAGE_DATABASE" = "true" ] && command -v pg_ctl >/dev/null 2>&1 && [ -f "$PG_DATA_DIR/PG_VERSION" ]; then
    if pg_ctl -D "$PG_DATA_DIR" status >/dev/null 2>&1; then
      printf '\nStopping StyleFlow\047s private PostgreSQL server…\n'
      pg_ctl -D "$PG_DATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
    fi
  fi
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[ "$(uname -s)" = "Darwin" ] || fail "This launcher is for macOS. See README.md for other environments."
cd "$APP_DIR"

[ -f "$APP_DIR/package.json" ] || fail "package.json is missing. Keep START_STYLEFLOW_MAC.command inside the StyleFlow folder."
PACKAGE_NAME="$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -n 1)"
[ "$PACKAGE_NAME" = "po-automation" ] || fail "This does not look like the StyleFlow application folder."
[ -f "$APP_DIR/package-lock.json" ] || fail "package-lock.json is missing from the copied folder."
[ -f "$APP_DIR/sample-data/methodology/Noise_113.xlsx" ] || fail "The bundled NOISE demo workbook is missing from sample-data/methodology."

if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port $APP_PORT is already in use. Stop the old local server, then run this same command again."
fi

if ! command -v brew >/dev/null 2>&1; then
  if [ -x /opt/homebrew/bin/brew ]; then
    export PATH="/opt/homebrew/bin:$PATH"
  elif [ -x /usr/local/bin/brew ]; then
    export PATH="/usr/local/bin:$PATH"
  else
    fail "Homebrew is required. Install it from https://brew.sh, then run this same command again."
  fi
fi

say "Checking Node.js 22 and PostgreSQL 16"
if ! brew list --versions node@22 >/dev/null 2>&1; then
  brew install node@22
fi
if ! brew list --versions postgresql@16 >/dev/null 2>&1; then
  brew install postgresql@16
fi

NODE_PREFIX="$(brew --prefix node@22)"
PG_PREFIX="$(brew --prefix postgresql@16)"
export PATH="$NODE_PREFIX/bin:$PG_PREFIX/bin:$PATH"

for executable in node npm initdb pg_ctl psql createdb pg_isready openssl curl; do
  command -v "$executable" >/dev/null 2>&1 || fail "$executable is unavailable after dependency setup."
done

umask 077
mkdir -p "$SUPPORT_DIR" "$PG_SOCKET_DIR"
chmod 700 "$SUPPORT_DIR" "$PG_SOCKET_DIR"

# A ZIP copied from another Mac can retain quarantine metadata and broken
# platform-specific dependencies. Clear the metadata before reinstalling.
xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true

if [ -f "$PG_DATA_DIR/PG_VERSION" ] && [ "$(sed -n '1p' "$PG_DATA_DIR/PG_VERSION")" != "16" ]; then
  fail "The private StyleFlow database is not PostgreSQL 16. Move $PG_DATA_DIR aside, then run this command again."
fi

if [ ! -f "$PG_DATA_DIR/PG_VERSION" ]; then
  FRESH_CLUSTER=true
  say "Creating StyleFlow's private local database (no password prompt)"
  if [ -d "$PG_DATA_DIR" ] && [ -n "$(find "$PG_DATA_DIR" -mindepth 1 -print -quit 2>/dev/null)" ]; then
    INCOMPLETE_DATA_DIR="$PG_DATA_DIR.incomplete-$(date +%Y%m%d-%H%M%S)-$$"
    mv "$PG_DATA_DIR" "$INCOMPLETE_DATA_DIR"
    printf 'Moved an incomplete prior database setup to %s for recovery.\n' "$INCOMPLETE_DATA_DIR"
  fi
  mkdir -p "$PG_DATA_DIR"
  SUPERUSER_PASSWORD_FILE="$(mktemp "${TMPDIR:-/tmp}/styleflow-pg-password.XXXXXX")"
  openssl rand -hex 24 > "$SUPERUSER_PASSWORD_FILE"
  initdb \
    -D "$PG_DATA_DIR" \
    --username="$(id -un)" \
    --pwfile="$SUPERUSER_PASSWORD_FILE" \
    --auth-local=trust \
    --auth-host=scram-sha-256 \
    --encoding=UTF8 \
    --locale=C >/dev/null
  rm -f "$SUPERUSER_PASSWORD_FILE"
  SUPERUSER_PASSWORD_FILE=""
fi

if ! pg_ctl -D "$PG_DATA_DIR" status >/dev/null 2>&1; then
  if lsof -nP -iTCP:"$PG_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "Port $PG_PORT is already used by another PostgreSQL server. Stop that server and run this command again."
  fi
  say "Starting StyleFlow's private PostgreSQL server"
  pg_ctl \
    -D "$PG_DATA_DIR" \
    -l "$PG_LOG_FILE" \
    -o "-h 127.0.0.1 -p $PG_PORT -k $PG_SOCKET_DIR" \
    -w start >/dev/null
fi

pg_isready -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1 || fail "PostgreSQL did not become ready. See $PG_LOG_FILE."
MANAGE_DATABASE=true

REUSE_ENVIRONMENT=false
DB_PASSWORD=""
AUTH_SECRET=""
if [ "$FRESH_CLUSTER" = "false" ] && [ -f "$APP_DIR/.env.local" ]; then
  EXISTING_DB_PASSWORD="$(sed -n 's#^DATABASE_URL=postgresql://styleflow:\([0-9a-f][0-9a-f]*\)@127\.0\.0\.1:55432/po_ledger$#\1#p' "$APP_DIR/.env.local" | head -n 1)"
  EXISTING_AUTH_SECRET="$(sed -n 's/^AUTH_SECRET=\([0-9a-f][0-9a-f]*\)$/\1/p' "$APP_DIR/.env.local" | head -n 1)"
  if [ "${#EXISTING_DB_PASSWORD}" -eq 48 ] && [ "${#EXISTING_AUTH_SECRET}" -ge 64 ]; then
    DB_PASSWORD="$EXISTING_DB_PASSWORD"
    AUTH_SECRET="$EXISTING_AUTH_SECRET"
    REUSE_ENVIRONMENT=true
  fi
fi
if [ "$REUSE_ENVIRONMENT" = "false" ]; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  AUTH_SECRET="$(openssl rand -hex 32)"
fi

DB_ADMIN=(psql -X -v ON_ERROR_STOP=1 -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U "$(id -un)" postgres)

ROLE_EXISTS="$("${DB_ADMIN[@]}" -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_ROLE'")"
if [ "$ROLE_EXISTS" = "1" ]; then
  "${DB_ADMIN[@]}" -c "ALTER ROLE $DB_ROLE WITH LOGIN PASSWORD '$DB_PASSWORD'" >/dev/null
else
  "${DB_ADMIN[@]}" -c "CREATE ROLE $DB_ROLE WITH LOGIN PASSWORD '$DB_PASSWORD'" >/dev/null
fi

DATABASE_EXISTS="$("${DB_ADMIN[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")"
if [ "$DATABASE_EXISTS" = "1" ]; then
  "${DB_ADMIN[@]}" -c "ALTER DATABASE $DB_NAME OWNER TO $DB_ROLE" >/dev/null
else
  createdb -h "$PG_SOCKET_DIR" -p "$PG_PORT" -U "$(id -un)" -O "$DB_ROLE" "$DB_NAME"
  NEW_APP_DATABASE=true
fi

if [ "$REUSE_ENVIRONMENT" = "false" ]; then
  {
    printf 'DATABASE_URL=postgresql://%s:%s@127.0.0.1:%s/%s\n' "$DB_ROLE" "$DB_PASSWORD" "$PG_PORT" "$DB_NAME"
    printf 'AUTH_SECRET=%s\n' "$AUTH_SECRET"
    printf 'EMAIL_PROVIDER=preview\n'
    printf 'AUTOMATION_SCHEDULER_CONNECTED=false\n'
  } > "$APP_DIR/.env.local"
fi
chmod 600 "$APP_DIR/.env.local"

# The Node scripts intentionally respect already-exported values. Remove stale
# shell values so this Mac's freshly validated .env.local is authoritative.
unset DATABASE_URL POSTGRES_URL AUTH_SECRET NODE_ENV VERCEL VERCEL_ENV 2>/dev/null || true
unset BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_PASSWORD BOOTSTRAP_ADMIN_DISPLAY_NAME BOOTSTRAP_ADMIN_EMAIL 2>/dev/null || true
unset EMAIL_PROVIDER EMAIL_FROM EMAIL_REPLY_TO EMAIL_FORCE_TO RESEND_API_KEY AUTOMATION_SCHEDULER_CONNECTED 2>/dev/null || true

say "Installing clean Mac dependencies"
NODE_SIGNATURE="$(node -p '`${process.platform}-${process.arch}-${process.versions.modules}`')-$(shasum -a 256 "$APP_DIR/package-lock.json" | awk '{print $1}')"
INSTALL_MARKER="$APP_DIR/node_modules/.styleflow-install-signature"
INSTALLED_SIGNATURE=""
if [ -f "$INSTALL_MARKER" ]; then
  INSTALLED_SIGNATURE="$(sed -n '1p' "$INSTALL_MARKER")"
fi
if [ "$INSTALLED_SIGNATURE" != "$NODE_SIGNATURE" ] || [ ! -x "$APP_DIR/node_modules/.bin/next" ]; then
  # The application root and package identity were validated above; only its
  # generated dependency/build directories are replaced.
  rm -rf "$APP_DIR/node_modules" "$APP_DIR/.next"
  npm ci --no-audit --no-fund
  printf '%s\n' "$NODE_SIGNATURE" > "$INSTALL_MARKER"
else
  rm -rf "$APP_DIR/.next"
  printf 'Existing Mac dependencies are current; reinstall skipped.\n'
fi

say "Initialising and checking the database"
npm run db:init
npm run db:check

GENERATED_PLANS="$(PGPASSWORD="$DB_PASSWORD" psql -X -h 127.0.0.1 -p "$PG_PORT" -U "$DB_ROLE" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM batches WHERE status='generated'")"

if [ "${GENERATED_PLANS:-0}" = "0" ] || [ -f "$DEMO_IN_PROGRESS_MARKER" ]; then
  if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "Port $APP_PORT is already in use. Stop the old local server, then run this same command again."
  fi

  say "Loading the bundled Myntra/NOISE plan and 80% sample supplier mappings"
  printf 'Noise demo setup started for %s on port %s.\n' "$DB_NAME" "$PG_PORT" > "$DEMO_IN_PROGRESS_MARKER"
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/styleflow-setup.XXXXXX")"
  NEXT_LOG="$TEMP_DIR/next.log"
  COOKIE_JAR="$TEMP_DIR/cookies.txt"
  BASE_URL="http://127.0.0.1:$APP_PORT"

  "$APP_DIR/node_modules/.bin/next" dev --webpack --hostname 127.0.0.1 --port "$APP_PORT" > "$NEXT_LOG" 2>&1 &
  BOOTSTRAP_PID=$!

  SERVER_READY=false
  for attempt in $(seq 1 90); do
    if curl -fsS "$BASE_URL/login" >/dev/null 2>&1; then
      SERVER_READY=true
      break
    fi
    if ! kill -0 "$BOOTSTRAP_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if [ "$SERVER_READY" != "true" ]; then
    tail -n 80 "$NEXT_LOG" >&2 || true
    fail "The temporary setup server did not start."
  fi

  LOGIN_STATUS="$(curl -sS -o "$TEMP_DIR/login.json" -w '%{http_code}' \
    -c "$COOKIE_JAR" \
    -H 'Content-Type: application/json' \
    --data '{"username":"admin","password":"admin"}' \
    "$BASE_URL/api/auth/login")"
  if [ "$LOGIN_STATUS" != "200" ]; then
    cat "$TEMP_DIR/login.json" >&2 || true
    fail "The local admin bootstrap could not sign in."
  fi

  UPLOAD_STATUS="$(curl -sS -o "$TEMP_DIR/upload.json" -w '%{http_code}' \
    -b "$COOKIE_JAR" \
    -F 'coverageDays=45' \
    -F 'dohThreshold=80' \
    -F 'label=NOISE headphones · June 2026 New PO plan' \
    -F 'forecastMethod=auto' \
    -F "planning_workbook=@$APP_DIR/sample-data/methodology/Noise_113.xlsx;type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" \
    "$BASE_URL/api/upload")"
  if [ "$UPLOAD_STATUS" != "200" ]; then
    cat "$TEMP_DIR/upload.json" >&2 || true
    fail "The bundled NOISE workbook could not be loaded."
  fi
  SOURCE_BATCH_ID="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!value.batchId)process.exit(1);process.stdout.write(value.batchId)' "$TEMP_DIR/upload.json")" || fail "The upload response did not include a plan ID."

  printf '{"batchId":"%s","coverageDays":45}' "$SOURCE_BATCH_ID" > "$TEMP_DIR/generate-request.json"
  GENERATE_STATUS="$(curl -sS -o "$TEMP_DIR/generate.json" -w '%{http_code}' \
    -b "$COOKIE_JAR" \
    -H 'Content-Type: application/json' \
    --data-binary "@$TEMP_DIR/generate-request.json" \
    "$BASE_URL/api/generate")"
  if [ "$GENERATE_STATUS" != "200" ]; then
    cat "$TEMP_DIR/generate.json" >&2 || true
    fail "The initial recommendation plan could not be calculated."
  fi
  GENERATED_BATCH_ID="$(node -e 'const fs=require("fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!value.batchId)process.exit(1);process.stdout.write(value.batchId)' "$TEMP_DIR/generate.json")" || fail "The calculation response did not include a plan ID."

  STYLEFLOW_DEMO_SEED_CONFIRM=styleflow-demo-noise-80-v2 npm run sample:seed-noise -- --apply

  # Re-run once after mapping so the latest immutable plan itself carries the
  # populated supplier/commercial master used by the review and PO screens.
  printf '{"batchId":"%s","coverageDays":45}' "$GENERATED_BATCH_ID" > "$TEMP_DIR/regenerate-request.json"
  REGENERATE_STATUS="$(curl -sS -o "$TEMP_DIR/regenerate.json" -w '%{http_code}' \
    -b "$COOKIE_JAR" \
    -H 'Content-Type: application/json' \
    --data-binary "@$TEMP_DIR/regenerate-request.json" \
    "$BASE_URL/api/generate")"
  if [ "$REGENERATE_STATUS" != "200" ]; then
    cat "$TEMP_DIR/regenerate.json" >&2 || true
    fail "The supplier-enriched plan could not be calculated."
  fi

  cleanup
  for attempt in $(seq 1 40); do
    if ! lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "The temporary setup server did not release port $APP_PORT. Run this same command again."
  fi
  npm run db:check
  printf 'Noise demo v2 is ready in %s on port %s.\n' "$DB_NAME" "$PG_PORT" > "$DEMO_COMPLETE_MARKER"
  rm -f "$DEMO_IN_PROGRESS_MARKER"
fi

if lsof -nP -iTCP:"$APP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Port $APP_PORT is already in use. Stop the old local server, then run this same command again."
fi

say "Ready — starting StyleFlow at http://localhost:$APP_PORT"
if [ "$NEW_APP_DATABASE" = "true" ]; then
  printf '\nLogin: \033[1madmin\033[0m / \033[1madmin\033[0m\n'
else
  printf '\nLogin: use this Mac\047s existing StyleFlow account. A fresh local database starts as \033[1madmin / admin\033[0m.\n'
fi
printf 'Email mode is read from .env.local; every fresh install starts in safe preview mode.\n'
printf 'Keep this Terminal window open. Press Control-C once to stop the app and its private database.\n\n'

npm run dev -- --hostname 0.0.0.0 --port "$APP_PORT"
