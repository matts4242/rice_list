#!/usr/bin/env bash
#
# Redeploy Rice List: pull the latest code, reinstall dependencies, restart,
# and confirm the site came back. Takes a database backup first, and puts the
# previous version back automatically if the new one fails to start.
#
# This is the routine update. deploy/install.sh can also upgrade, but it
# re-checks the whole machine; this only touches the application, is quick,
# and knows how to undo itself.
#
#   sudo ./deploy/redeploy.sh                 # latest of the current branch
#   sudo ./deploy/redeploy.sh --ref v1.2.0    # a tag, branch or commit
#
# Run with --help for the full list of options.

set -euo pipefail

# --- Defaults ---------------------------------------------------------------

APP_DIR="/opt/ricelist"
SERVICE_NAME="ricelist"
SERVICE_USER="ricelist"
BACKUP_DIR="/var/backups/ricelist"
REF=""
KEEP=10
ROLLBACK="yes"
SKIP_BACKUP="no"
FORCE="no"

# --- Output helpers ---------------------------------------------------------

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"; }
info() { printf '    %s\n' "$1"; }
ok()   { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1" >&2; }
die()  { printf '\n%serror:%s %s\n' "$C_RED" "$C_RESET" "$1" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: sudo ./deploy/redeploy.sh [options]

Options:
  --ref REF          Branch, tag or commit to deploy. Default: the latest
                     commit on whichever branch is currently checked out.
  --keep N           Database backups to retain. (default: 10)
  --skip-backup      Do not back up the database first. Not recommended.
  --no-rollback      Leave the new code in place even if it fails to start,
                     instead of restoring the previous commit.
  --force            Redeploy even when already on the target commit.
  --app-dir PATH     Installation directory. (default: /opt/ricelist)
  --service NAME     systemd unit name. (default: ricelist)
  -h, --help         Show this help.

What it does, in order: back up the database, fetch and check out the target
revision, reinstall dependencies, restart the service, and poll /health. If
the site does not come back, it restores the previous commit and restarts
again, so a bad deploy self-corrects.

The database is never rolled back automatically -- that could throw away
writes made after the backup. If a release damages your data, restore the
backup this script points you at, by hand.
USAGE
}

# --- Argument parsing -------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)         REF="${2:-}"; shift 2 ;;
    --keep)        KEEP="${2:-}"; shift 2 ;;
    --skip-backup) SKIP_BACKUP="yes"; shift ;;
    --no-rollback) ROLLBACK="no"; shift ;;
    --force)       FORCE="yes"; shift ;;
    --app-dir)     APP_DIR="${2:-}"; shift 2 ;;
    --service)     SERVICE_NAME="${2:-}"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown option: $1" ;;
  esac
done

case "$KEEP" in
  ''|*[!0-9]*) die "--keep must be a number, got: $KEEP" ;;
esac

# --- Preflight --------------------------------------------------------------

step "Checking the installation"

[ "$(id -u)" -eq 0 ] || die "run this with sudo."

ENV_FILE="$APP_DIR/.env"
[ -d "$APP_DIR/.git" ] || die "no git checkout at ${APP_DIR}.
     This script updates an existing install; use deploy/install.sh first."
[ -f "$ENV_FILE" ] || die "no ${ENV_FILE}. Use deploy/install.sh first."
id -u "$SERVICE_USER" >/dev/null 2>&1 || die "the ${SERVICE_USER} user does not exist."

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | head -n 1; }

PORT="$(env_value PORT)"; [ -n "$PORT" ] || PORT=3000
DATA_DIR="$(env_value DATA_DIR)"; [ -n "$DATA_DIR" ] || DATA_DIR="$APP_DIR/data"
DB_PATH="$(env_value DATABASE_PATH)"; [ -n "$DB_PATH" ] || DB_PATH="$DATA_DIR/rice-list.db"

# Use the very node the unit runs. A machine can carry more than one, and
# native modules are compiled for one ABI: building with a different node than
# systemd starts leaves the service dying on ERR_DLOPEN_FAILED. Reading it out
# of ExecStart means the build cannot disagree with the runtime.
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="$(sed -n 's/^ExecStart=//p' "$UNIT_FILE" 2>/dev/null | awk '{print $1}' | head -n 1)"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -x "$NODE_BIN" ] || die "cannot find the node binary the service runs."
SERVICE_PATH="$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

run_as_service() {
  sudo -u "$SERVICE_USER" env "PATH=$SERVICE_PATH" "HOME=$DATA_DIR" "$@"
}
git_app() { run_as_service git -C "$APP_DIR" "$@"; }

PREVIOUS_COMMIT="$(git_app rev-parse HEAD)"
BRANCH="$(git_app rev-parse --abbrev-ref HEAD)"
info "Currently on ${BRANCH} at $(git_app rev-parse --short HEAD)"
info "Port ${PORT}, data in ${DATA_DIR}"
info "Node ${NODE_BIN}"
ok "Installation looks healthy"

# --- Backup -----------------------------------------------------------------

BACKUP_FILE=""
if [ "$SKIP_BACKUP" = "no" ] && [ -f "$DB_PATH" ]; then
  step "Backing up the database"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$BACKUP_DIR"
  BACKUP_FILE="${BACKUP_DIR}/rice-list-$(date +%Y%m%d-%H%M%S).db"

  # SQLite's own backup API rather than a file copy: the database runs in WAL
  # mode, so a copy taken while the service is writing can be torn.
  if run_as_service node -e '
      const Database = require(process.argv[1] + "/node_modules/better-sqlite3");
      const source = new Database(process.argv[2], { readonly: true });
      source.backup(process.argv[3])
        .then(() => process.exit(0))
        .catch((error) => { console.error(error.message); process.exit(1); });
    ' "$APP_DIR" "$DB_PATH" "$BACKUP_FILE"; then
    ok "Saved $(du -h "$BACKUP_FILE" | cut -f1) to ${BACKUP_FILE}"
  else
    die "the database backup failed, so nothing was changed.
     Re-run with --skip-backup only if you accept losing the ability to
     restore this release."
  fi

  # Keep the newest $KEEP, drop the rest. The timestamp in the name is
  # fixed-width, so sorting the names is sorting by age.
  existing_backups=()
  for candidate in "${BACKUP_DIR}"/rice-list-*.db; do
    [ -e "$candidate" ] && existing_backups+=("$candidate")
  done
  if [ "${#existing_backups[@]}" -gt "$KEEP" ]; then
    mapfile -t old_backups < <(printf '%s\n' "${existing_backups[@]}" | sort -r | tail -n "+$((KEEP + 1))")
    for stale in "${old_backups[@]}"; do
      # Anything that opens a backup leaves -wal/-shm beside it. Take those
      # with it, or they outlive every backup they belong to.
      rm -f "$stale" "${stale}-wal" "${stale}-shm"
    done
    info "Pruned ${#old_backups[@]} backup(s), keeping the newest ${KEEP}."
  fi

  # Sweep sidecars whose database is already gone, so a directory that was
  # pruned before this cleanup existed tidies itself up.
  for sidecar in "${BACKUP_DIR}"/rice-list-*.db-wal "${BACKUP_DIR}"/rice-list-*.db-shm; do
    [ -e "$sidecar" ] || continue
    [ -e "${sidecar%-*}" ] || rm -f "$sidecar"
  done
elif [ "$SKIP_BACKUP" = "yes" ]; then
  step "Skipping the backup (--skip-backup)"
  warn "Nothing to restore from if this release goes wrong."
fi

# --- Fetch ------------------------------------------------------------------

step "Fetching the latest code"

TARGET_REF="${REF:-$BRANCH}"
git_app fetch --quiet --tags origin

# Prefer the remote branch when the ref names one; otherwise take it literally,
# so a tag or a bare commit works the same way.
if git_app rev-parse --verify --quiet "origin/${TARGET_REF}" >/dev/null; then
  TARGET_COMMIT="$(git_app rev-parse "origin/${TARGET_REF}")"
elif git_app rev-parse --verify --quiet "${TARGET_REF}" >/dev/null; then
  TARGET_COMMIT="$(git_app rev-parse "${TARGET_REF}")"
else
  die "cannot resolve '${TARGET_REF}' to anything in the repository."
fi

info "Target ${TARGET_REF} -> $(git_app rev-parse --short "$TARGET_COMMIT")"

if [ "$TARGET_COMMIT" = "$PREVIOUS_COMMIT" ] && [ "$FORCE" = "no" ]; then
  ok "Already running that commit; nothing to do."
  info "Use --force to redeploy it anyway."
  exit 0
fi

git_app checkout --quiet --force "$TARGET_COMMIT"
ok "Checked out $(git_app rev-parse --short HEAD)"

git_app --no-pager log --oneline -5 "${PREVIOUS_COMMIT}..${TARGET_COMMIT}" 2>/dev/null \
  | sed 's/^/    /' || true

# --- Dependencies -----------------------------------------------------------

step "Installing dependencies"

install_dependencies() {
  run_as_service npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund
}

# npm can exit 0 having installed nothing (its "Exit handler never called"
# bug leaves empty directories behind), so check that the dependencies load
# rather than trusting the exit code.
missing_dependencies() {
  run_as_service node -e '
    const path = require("node:path");
    const root = process.argv[1];
    const pkg = require(path.join(root, "package.json"));
    const missing = Object.keys(pkg.dependencies || {}).filter((dep) => {
      try {
        require.resolve(dep, { paths: [root] });
        return false;
      } catch {
        return true;
      }
    });
    process.stdout.write(missing.join(" "));
  ' "$APP_DIR" 2>/dev/null || printf 'unknown'
}

install_dependencies || warn "npm reported a failure; checking what landed."
missing="$(missing_dependencies)"
if [ -n "$missing" ]; then
  warn "These dependencies did not install: ${missing}"
  warn "Clearing node_modules and trying once more."
  run_as_service rm -rf "$APP_DIR/node_modules"
  install_dependencies || true
  missing="$(missing_dependencies)"
fi
[ -z "$missing" ] || die "dependencies are still missing: ${missing}"
ok "Dependencies installed and verified"

# --- Restart and verify -----------------------------------------------------

site_is_up() {
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

step "Restarting the service"
systemctl restart "$SERVICE_NAME"

if site_is_up; then
  ok "Site is answering on port ${PORT}"
else
  warn "The site did not come back after the restart."

  if [ "$ROLLBACK" = "no" ]; then
    printf '\n'
    systemctl status "$SERVICE_NAME" --no-pager --lines=30 || true
    die "deploy failed and --no-rollback was given, so the new code is still
     in place and the site is down. Roll back by hand with:
       sudo ./deploy/redeploy.sh --ref ${PREVIOUS_COMMIT}"
  fi

  step "Rolling back to the previous version"
  info "Restoring $(git_app rev-parse --short "$PREVIOUS_COMMIT")"
  git_app checkout --quiet --force "$PREVIOUS_COMMIT"
  install_dependencies || true
  systemctl restart "$SERVICE_NAME"

  if site_is_up; then
    printf '\n%s%sDeploy failed; the previous version is back up.%s\n\n' \
      "$C_YELLOW" "$C_BOLD" "$C_RESET"
    info "Running again: $(git_app rev-parse --short HEAD)"
    info "The release that failed: $(git rev-parse --short "$TARGET_COMMIT" 2>/dev/null || echo "$TARGET_COMMIT")"
    [ -n "$BACKUP_FILE" ] && info "Database backup: ${BACKUP_FILE}"
    printf '\n'
    info "What went wrong is in the log from the failed start:"
    info "  journalctl -u ${SERVICE_NAME} --since '5 minutes ago'"
    exit 1
  fi

  printf '\n'
  systemctl status "$SERVICE_NAME" --no-pager --lines=30 || true
  die "the rollback also failed to start, so the site is down.
     The database backup is at ${BACKUP_FILE:-<none taken>}.
     Investigate with: journalctl -u ${SERVICE_NAME} -n 50"
fi

# --- Summary ----------------------------------------------------------------

SITE_URL="$(env_value SITE_URL)"

cat <<SUMMARY

${C_GREEN}${C_BOLD}Redeployed.${C_RESET}

  Version    $(git_app rev-parse --short HEAD)  ($(git_app log -1 --format=%s | cut -c1-56))
  Was        $(git rev-parse --short "$PREVIOUS_COMMIT" 2>/dev/null || echo "${PREVIOUS_COMMIT:0:7}")
  URL        ${SITE_URL:-http://localhost:$PORT}
  Backup     ${BACKUP_FILE:-<skipped>}

  Roll back with:
    sudo $0 --ref ${PREVIOUS_COMMIT}

SUMMARY
