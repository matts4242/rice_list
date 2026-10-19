#!/usr/bin/env bash
#
# Redeploy Rice List: pull the latest code, reinstall dependencies, restart,
# and confirm the site came back. Takes a database backup first, and puts the
# previous version back automatically if the new one fails to install or start.
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

# How long a release must stay up after it first answers to count as working.
SETTLE_SECONDS=5

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
                     commit on the branch this install follows (see below).
  --keep N           Database backups to retain, counting the one this run
                     takes, so at least 1. (default: 10)
  --skip-backup      Do not back up the database first. Not recommended.
  --no-rollback      Leave the new code in place even if it fails to start,
                     instead of restoring the previous commit.
  --force            Redeploy even when already on the target commit.
  --app-dir PATH     Installation directory. (default: /opt/ricelist)
  --service NAME     systemd unit name. (default: ricelist)
  -h, --help         Show this help.

The branch a plain run follows is the one checked out or, when a tag or a
commit is checked out, the one recorded in the checkout's git config as
ricelist.branch. Deploying a branch with --ref makes it the one followed from
then on. Deploying a tag or a commit does not, so the next plain run goes
back to the branch.

What it does, in order: back up the database, fetch and check out the target
revision, reinstall dependencies, restart the service, and check the result:
/health and the front page must both answer 200, and a few seconds later the
service must still be running without systemd having restarted it. If the
install or the check fails, it restores the previous commit together with the
node_modules it was running with, and restarts that, so a bad deploy
self-corrects.

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
# Base 10, so a leading zero is not read as octal by the arithmetic below.
KEEP=$((10#$KEEP))
# The count includes the backup this run takes. Zero would prune that backup
# the moment it was written, and the summary would still name it.
[ "$KEEP" -ge 1 ] || die "--keep must be at least 1; the backup this run takes is one of them."

# HEAD names whatever happens to be checked out, so it is not a target.
[ "$REF" != "HEAD" ] || die "--ref HEAD is not a target; name a branch, tag or commit."

# --- Preflight --------------------------------------------------------------

step "Checking the installation"

[ "$(id -u)" -eq 0 ] || die "run this with sudo."

ENV_FILE="$APP_DIR/.env"
[ -d "$APP_DIR/.git" ] || die "no git checkout at ${APP_DIR}.
     This script updates an existing install; use deploy/install.sh first."
[ -f "$ENV_FILE" ] || die "no ${ENV_FILE}. Use deploy/install.sh first."
id -u "$SERVICE_USER" >/dev/null 2>&1 || die "the ${SERVICE_USER} user does not exist."

# Use the very node the unit runs. A machine can carry more than one, and
# native modules are compiled for one ABI: building with a different node than
# systemd starts leaves the service dying on ERR_DLOPEN_FAILED. Reading it out
# of ExecStart means the build cannot disagree with the runtime.
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="$(sed -n 's/^ExecStart=//p' "$UNIT_FILE" 2>/dev/null | awk '{print $1}' | head -n 1)"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -x "$NODE_BIN" ] || die "cannot find the node binary the service runs."
SERVICE_PATH="$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# HOME is the data directory, which is where install.sh made the account's
# home. DATA_DIR is itself read out of .env through this, before it is known;
# that needs no HOME, hence the fallback.
DATA_DIR=""
run_as_service() {
  sudo -u "$SERVICE_USER" env "PATH=$SERVICE_PATH" "HOME=${DATA_DIR:-$APP_DIR}" "$@"
}
git_app() { run_as_service git -C "$APP_DIR" "$@"; }

# Read a setting the way the app will. It loads .env with dotenv, which strips
# quotes and trailing comments and lets a later line override an earlier one,
# so ask the app's own dotenv, through the service's node and as the service
# user. node_modules can be missing or broken -- sometimes that is why you are
# redeploying -- so fall back to the same rules done by hand rather than
# stopping before the backup.
env_value() {
  local value
  if value="$(run_as_service node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const dotenv = require(path.join(process.argv[1], "node_modules", "dotenv"));
      const parsed = dotenv.parse(fs.readFileSync(path.join(process.argv[1], ".env")));
      process.stdout.write(parsed[process.argv[2]] ?? "");
    ' "$APP_DIR" "$1" 2>/dev/null)"; then
    printf '%s' "$value"
    return 0
  fi
  value="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" \
    | tail -n 1 | tr -d '\r')"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    \`*) value="${value#\`}"; value="${value%%\`*}" ;;
    *)   value="${value%%#*}"; value="${value%"${value##*[![:space:]]}"}" ;;
  esac
  printf '%s' "$value"
}

# config.js resolves a relative DATA_DIR or DATABASE_PATH against the app
# directory, not against wherever it was started from, and so does this.
app_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *)  printf '%s/%s' "$APP_DIR" "$1" ;;
  esac
}

PORT="$(env_value PORT)"; [ -n "$PORT" ] || PORT=3000
case "$PORT" in
  *[!0-9]*) die "PORT in ${ENV_FILE} is '${PORT}', which is not a port number." ;;
esac
DATA_DIR="$(env_value DATA_DIR)"
DATA_DIR="$(app_path "${DATA_DIR:-data}")"
DB_PATH="$(env_value DATABASE_PATH)"
if [ -n "$DB_PATH" ]; then
  DB_PATH="$(app_path "$DB_PATH")"
else
  DB_PATH="$DATA_DIR/rice-list.db"
fi

PREVIOUS_COMMIT="$(git_app rev-parse HEAD)"
# Empty when HEAD is detached: deploying a tag or a commit leaves it so, and
# older versions of this script left it so after every run.
PREVIOUS_BRANCH="$(git_app symbolic-ref --quiet --short HEAD || true)"
RECORDED_BRANCH="$(git_app config --get ricelist.branch || true)"

# Write the branch down while HEAD still names it. Deploying a tag detaches
# HEAD, and a later plain run would otherwise have nothing to go on.
if [ -n "$PREVIOUS_BRANCH" ] && [ "$PREVIOUS_BRANCH" != "$RECORDED_BRANCH" ]; then
  git_app config ricelist.branch "$PREVIOUS_BRANCH"
  RECORDED_BRANCH="$PREVIOUS_BRANCH"
fi

# With no --ref, update the branch this install follows, and refuse to guess
# when there is none. A detached HEAD's "current branch" is the literal HEAD,
# which resolves to the remote's default branch: a redeploy that silently
# ships whatever is on main to an install that follows another branch.
TARGET_REF="${REF:-$RECORDED_BRANCH}"
if [ -z "$TARGET_REF" ]; then
  die "HEAD is detached at $(git_app rev-parse --short HEAD) and no branch is recorded,
     so there is no current branch to update. Name the branch this install
     follows, once -- main, unless install.sh was given --branch:
       sudo $0 --ref main
     It is remembered, and later plain runs follow it."
fi

if [ -n "$PREVIOUS_BRANCH" ]; then
  info "Currently on ${PREVIOUS_BRANCH} at $(git_app rev-parse --short HEAD)"
else
  info "Currently at $(git_app rev-parse --short HEAD), detached${RECORDED_BRANCH:+; following ${RECORDED_BRANCH}}"
fi
info "Port ${PORT}, database ${DB_PATH}"
info "Node ${NODE_BIN}"
ok "Installation looks healthy"

# --- Backup -----------------------------------------------------------------

BACKUP_FILE=""
if [ "$SKIP_BACKUP" = "no" ]; then
  step "Backing up the database"

  # A database that is not where .env says means this script and the app
  # disagree about where the data lives. Carrying on would ship the release
  # with nothing to restore from, which is what a backup is for.
  [ -f "$DB_PATH" ] || die "there is no database at ${DB_PATH}, which is where ${ENV_FILE}
     puts it, so nothing was backed up and nothing was changed. If this
     install has genuinely never created one, re-run with --skip-backup."

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
else
  step "Skipping the backup (--skip-backup)"
  warn "Nothing to restore from if this release goes wrong."
fi

# --- Fetch ------------------------------------------------------------------

step "Fetching the latest code"

git_app fetch --quiet --tags origin

# A branch is deployed by moving the local branch of that name to the remote's
# tip and checking it out, so HEAD stays on the branch. A tag or a commit is
# checked out detached, and ricelist.branch still says where to go back to.
# The branch wins when a name could be either, as it always has.
TARGET_BRANCH=""
if [ "$TARGET_REF" != "HEAD" ] \
    && git_app show-ref --verify --quiet "refs/remotes/origin/${TARGET_REF}"; then
  TARGET_BRANCH="$TARGET_REF"
  TARGET_COMMIT="$(git_app rev-parse "refs/remotes/origin/${TARGET_REF}")"
elif git_app rev-parse --verify --quiet "${TARGET_REF}^{commit}" >/dev/null; then
  # ^{commit} peels an annotated tag to the commit it names, so it compares
  # equal to HEAD when that commit is already deployed.
  TARGET_COMMIT="$(git_app rev-parse "${TARGET_REF}^{commit}")"
else
  die "cannot resolve '${TARGET_REF}' to anything in the repository."
fi

info "Target ${TARGET_REF} -> $(git_app rev-parse --short "$TARGET_COMMIT")"

# A branch named with --ref becomes the one followed, but only once it is
# deployed (or found already deployed): a failed deploy changes nothing.
remember_target_branch() {
  if [ -n "$TARGET_BRANCH" ] && [ "$TARGET_BRANCH" != "$RECORDED_BRANCH" ]; then
    git_app config ricelist.branch "$TARGET_BRANCH"
    info "Plain redeploys follow ${TARGET_BRANCH} from now on."
  fi
}

if [ "$TARGET_COMMIT" = "$PREVIOUS_COMMIT" ] && [ "$FORCE" = "no" ]; then
  remember_target_branch
  ok "Already running that commit; nothing to do."
  info "Use --force to redeploy it anyway."
  exit 0
fi

# Check out a commit: on the given branch, moving the branch to it, or
# detached when the branch is empty.
checkout_release() {
  if [ -n "$1" ]; then
    git_app checkout --quiet --force -B "$1" "$2"
  else
    git_app checkout --quiet --force "$2"
  fi
}

checkout_release "$TARGET_BRANCH" "$TARGET_COMMIT"
ok "Checked out $(git_app rev-parse --short HEAD)${TARGET_BRANCH:+ on ${TARGET_BRANCH}}"

git_app --no-pager log --oneline -5 "${PREVIOUS_COMMIT}..${TARGET_COMMIT}" 2>/dev/null \
  | sed 's/^/    /' || true

# --- Dependencies -----------------------------------------------------------

step "Installing dependencies"

NODE_MODULES="$APP_DIR/node_modules"
SAVED_MODULES="$APP_DIR/node_modules.prev"

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

# Put the previous release back as it was: its commit, on its branch if it was
# on one, with the node_modules it was running with. Reinstalling the old
# commit's dependencies instead would need the registry, which may be the very
# thing that just failed, and would empty node_modules again on the way.
restore_previous_release() {
  checkout_release "$PREVIOUS_BRANCH" "$PREVIOUS_COMMIT"
  run_as_service rm -rf "$NODE_MODULES"
  if [ -d "$SAVED_MODULES" ]; then
    run_as_service mv "$SAVED_MODULES" "$NODE_MODULES"
    ok "Restored $(git_app rev-parse --short HEAD) and the node_modules it ran with"
  else
    ok "Restored $(git_app rev-parse --short HEAD)"
    warn "It had no node_modules before this run either, so there is none to put back."
  fi
}

# npm ci starts by deleting node_modules, and until the new tree is installed,
# verified and serving, the running release's copy is the only one known to
# work. Move it aside instead of letting npm destroy it. One left over from an
# interrupted run belongs to a commit that is no longer the previous one, so
# it protects nothing.
if [ -e "$SAVED_MODULES" ]; then
  run_as_service rm -rf "$SAVED_MODULES"
fi
if [ -d "$NODE_MODULES" ]; then
  run_as_service mv "$NODE_MODULES" "$SAVED_MODULES"
fi

install_dependencies || warn "npm reported a failure; checking what landed."
missing="$(missing_dependencies)"
if [ -n "$missing" ]; then
  warn "These dependencies did not install: ${missing}"
  warn "Clearing node_modules and trying once more."
  run_as_service rm -rf "$NODE_MODULES"
  install_dependencies || true
  missing="$(missing_dependencies)"
fi
if [ -n "$missing" ]; then
  warn "These dependencies are still missing: ${missing}"
  step "Putting the previous version back"
  restore_previous_release
  die "the new release's dependencies would not install, so nothing changed:
     the service was not restarted and is still running the previous version.
     Fix whatever stopped npm (network, disk space, memory) and run this again."
fi
ok "Dependencies installed and verified"

# --- Restart and verify -----------------------------------------------------

# The status code of a GET to the app itself, 000 if nothing answered. curl
# does not follow redirects, so a 3xx comes back as itself.
http_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 3 \
    "http://127.0.0.1:${PORT}$1" 2>/dev/null || true
}

# /health does no real work -- it touches neither the database nor a view --
# so on its own it shows only that something is listening. The front page
# runs the category and listing queries and renders a template, so a release
# that fails every real page (a schema change with no migration, say) fails
# here too. Both must be exactly 200: a redirect or a 4xx is not a working
# site either.
site_answers() {
  local path code
  for path in /health /; do
    code="$(http_status "$path")"
    if [ "$code" != "200" ]; then
      if [ "${code:-000}" = "000" ]; then
        FAILURE="nothing answered GET ${path} on port ${PORT}"
      else
        FAILURE="GET ${path} answered ${code}"
      fi
      return 1
    fi
  done
}

restart_count() {
  systemctl show --property=NRestarts --value "$SERVICE_NAME" 2>/dev/null || true
}

# Restart the service and decide whether what it now runs works. Answering
# once is not enough: a process that binds, serves a request and then crashes
# would pass, and systemd would quietly restart it into a loop. So once it
# answers, wait, then require the unit to be active still, systemd not to have
# restarted it meanwhile, and the site to answer again. On failure FAILURE
# says why.
restart_and_verify() {
  local restarts now attempt=1
  FAILURE=""
  if ! systemctl restart "$SERVICE_NAME"; then
    FAILURE="systemctl could not restart ${SERVICE_NAME}"
    return 1
  fi
  restarts="$(restart_count)"
  until site_answers; do
    [ "$attempt" -lt 20 ] || return 1
    attempt=$((attempt + 1))
    sleep 1
  done
  sleep "$SETTLE_SECONDS"
  if ! systemctl is-active --quiet "$SERVICE_NAME"; then
    FAILURE="${SERVICE_NAME} stopped running within ${SETTLE_SECONDS}s of answering"
    return 1
  fi
  now="$(restart_count)"
  if [ "$now" != "$restarts" ]; then
    FAILURE="${SERVICE_NAME} crashed and systemd restarted it (NRestarts ${restarts} -> ${now})"
    return 1
  fi
  site_answers
}

step "Restarting the service"

if restart_and_verify; then
  ok "Site is answering on port ${PORT}, and still was ${SETTLE_SECONDS}s later"
else
  warn "The new release is not working: ${FAILURE}."

  if [ "$ROLLBACK" = "no" ]; then
    # Nothing is going to put the saved node_modules back now.
    run_as_service rm -rf "$SAVED_MODULES"
    printf '\n'
    systemctl status "$SERVICE_NAME" --no-pager --lines=30 || true
    die "deploy failed and --no-rollback was given, so the new code is still
     in place and the site is not working. Roll back by hand with:
       sudo ./deploy/redeploy.sh --ref ${PREVIOUS_COMMIT}"
  fi

  step "Rolling back to the previous version"
  restore_previous_release
  # Only when there was nothing to put back: a reinstall needs the registry.
  [ -d "$NODE_MODULES" ] || install_dependencies || true

  if restart_and_verify; then
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
  die "the rollback is not working either (${FAILURE}), so the site is down.
     The database backup is at ${BACKUP_FILE:-<none taken>}.
     Investigate with: journalctl -u ${SERVICE_NAME} -n 50"
fi

# The new release is serving, so the old node_modules has done its job.
run_as_service rm -rf "$SAVED_MODULES"
remember_target_branch

# --- Summary ----------------------------------------------------------------

SITE_URL="$(env_value SITE_URL)"

if [ -n "$TARGET_BRANCH" ]; then
  FOLLOWING="$TARGET_BRANCH"
elif [ -n "$RECORDED_BRANCH" ]; then
  FOLLOWING="${RECORDED_BRANCH}  (a plain redeploy returns to it)"
else
  FOLLOWING="<none recorded>  (a plain redeploy will need --ref BRANCH)"
fi

cat <<SUMMARY

${C_GREEN}${C_BOLD}Redeployed.${C_RESET}

  Version    $(git_app rev-parse --short HEAD)  ($(git_app log -1 --format=%s | cut -c1-56))
  Was        $(git rev-parse --short "$PREVIOUS_COMMIT" 2>/dev/null || echo "${PREVIOUS_COMMIT:0:7}")
  Branch     ${FOLLOWING}
  URL        ${SITE_URL:-http://localhost:$PORT}
  Backup     ${BACKUP_FILE:-<skipped>}

  Roll back with:
    sudo $0 --ref ${PREVIOUS_COMMIT}

SUMMARY
