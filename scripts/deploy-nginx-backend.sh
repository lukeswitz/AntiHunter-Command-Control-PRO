#!/usr/bin/env bash
set -euo pipefail

INSTALL_USER="${INSTALL_USER:-ahcc}"
INSTALL_DIR="${INSTALL_DIR:-/opt/ahcc}"
REPO_DIR="${REPO_DIR:-$INSTALL_DIR/AntiHunter-Command-Control-PRO}"
BACKEND_DIR="$REPO_DIR/apps/backend"
FRONTEND_DIR="$REPO_DIR/apps/frontend"
NGINX_ROOT="${NGINX_ROOT:-/var/www/ahcc-frontend}"
BACKEND_SERVICE="${BACKEND_SERVICE:-ahcc-backend}"
BACKEND_PORT="${BACKEND_PORT:-3000}"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-$INSTALL_DIR/scripts/backup-db.sh}"
GIT_REF="${GIT_REF:-}"

log() { echo -e "\033[1;32m[$(date '+%Y-%m-%d %H:%M:%S')]\033[0m $*"; }
warn() { echo -e "\033[1;33m[WARN]\033[0m $*"; }
error_exit() { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

as_user() { sudo -u "$INSTALL_USER" -H "$@"; }

preflight() {
  [[ $EUID -eq 0 ]] || error_exit "Run with sudo: sudo $0"
  id "$INSTALL_USER" >/dev/null 2>&1 || error_exit "User $INSTALL_USER not found. Set up the server with scripts/deploy-production.sh first."
  [[ -d "$REPO_DIR/.git" ]] || error_exit "No repository at $REPO_DIR. Set up the server with scripts/deploy-production.sh first."
  [[ -f "$BACKEND_DIR/.env" ]] || error_exit "No $BACKEND_DIR/.env. Set up the server with scripts/deploy-production.sh first."
  systemctl cat "$BACKEND_SERVICE" >/dev/null 2>&1 || error_exit "Service $BACKEND_SERVICE not found. Set up the server with scripts/deploy-production.sh first."
  for cmd in git node pnpm nginx rsync curl; do
    command -v "$cmd" >/dev/null 2>&1 || error_exit "$cmd not found"
  done
  if [[ -n "$(as_user git -C "$REPO_DIR" status --porcelain --untracked-files=no)" ]]; then
    error_exit "$REPO_DIR has local changes to tracked files. Commit or discard them, then rerun."
  fi
}

backup_database() {
  if [[ -x "$BACKUP_SCRIPT" ]]; then
    log "Backing up the database..."
    as_user "$BACKUP_SCRIPT" || error_exit "Backup failed. Fix it or set BACKUP_SCRIPT=/bin/true to skip, then rerun."
  else
    warn "No backup script at $BACKUP_SCRIPT; continuing without a pre-update backup."
  fi
}

update_code() {
  PREVIOUS_COMMIT="$(as_user git -C "$REPO_DIR" rev-parse HEAD)"
  log "Current commit: $PREVIOUS_COMMIT"
  as_user git -C "$REPO_DIR" fetch --tags origin
  if [[ -n "$GIT_REF" ]]; then
    as_user git -C "$REPO_DIR" checkout "$GIT_REF"
  else
    as_user git -C "$REPO_DIR" pull --ff-only
  fi
  log "Updated to: $(as_user git -C "$REPO_DIR" rev-parse HEAD)"
}

build_all() {
  log "Installing dependencies..."
  as_user bash -c "cd '$REPO_DIR' && pnpm install --frozen-lockfile"
  log "Generating Prisma client..."
  as_user bash -c "cd '$BACKEND_DIR' && pnpm prisma:generate"
  log "Building backend..."
  as_user bash -c "cd '$BACKEND_DIR' && pnpm build"
  [[ -f "$BACKEND_DIR/dist/main.js" ]] || error_exit "Backend build missing dist/main.js"
  log "Building frontend..."
  as_user bash -c "cd '$FRONTEND_DIR' && NODE_ENV=production pnpm build"
  [[ -f "$FRONTEND_DIR/dist/index.html" ]] || error_exit "Frontend build missing dist/index.html"
}

update_database() {
  log "Updating the database..."
  as_user bash -c "cd '$REPO_DIR' && AHCC_DB_MISMATCH='${AHCC_DB_MISMATCH:-}' node scripts/db-update-helper.mjs" || \
    error_exit "Database update did not finish. The running service was not restarted. Previous commit: $PREVIOUS_COMMIT"
}

publish() {
  log "Publishing frontend to $NGINX_ROOT..."
  mkdir -p "$NGINX_ROOT"
  rsync -a --delete "$FRONTEND_DIR/dist/" "$NGINX_ROOT/"
  chown -R root:root "$NGINX_ROOT"
  find "$NGINX_ROOT" -type d -exec chmod 755 {} +
  find "$NGINX_ROOT" -type f -exec chmod 644 {} +

  log "Restarting $BACKEND_SERVICE..."
  systemctl restart "$BACKEND_SERVICE"
  local attempt=0
  until curl -sf --max-time 5 "http://127.0.0.1:$BACKEND_PORT/healthz" >/dev/null; do
    attempt=$((attempt + 1))
    if (( attempt >= 30 )); then
      journalctl -u "$BACKEND_SERVICE" -n 40 --no-pager || true
      error_exit "Backend did not pass /healthz. Roll back with: sudo GIT_REF=$PREVIOUS_COMMIT $0"
    fi
    sleep 3
  done
  log "Backend healthy"

  nginx -t
  systemctl reload nginx
}

main() {
  preflight
  backup_database
  update_code
  build_all
  update_database
  publish
  log "Update complete: $(as_user git -C "$REPO_DIR" log -1 --format='%h %s')"
}

main "$@"
