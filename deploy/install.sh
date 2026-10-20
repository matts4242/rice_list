#!/usr/bin/env bash
#
# Install Rice List on an Ubuntu VPS (24.04 LTS or 26.04 LTS).
#
# Sets up Node, a locked-down service account, systemd, nginx and a Let's
# Encrypt certificate, then starts the site and checks that it answers.
#
# Re-running is safe: it upgrades the checkout, reinstalls dependencies and
# restarts the service, keeping the existing session secret, admin password
# and database. That makes this the update script too.
#
#   sudo ./deploy/install.sh --domain ads.example.com --email you@example.com
#
# Run with --help for the full list of options.

set -euo pipefail

# --- Defaults ---------------------------------------------------------------

REPO_URL="https://github.com/matts4242/rice_list.git"
BRANCH="main"
APP_DIR="/opt/ricelist"
DATA_DIR="/var/lib/ricelist"
SERVICE_USER="ricelist"
SERVICE_NAME="ricelist"
PORT="3000"
SITE_NAME="Rice List"
NODE_MAJOR_MIN="20"     # package.json requires >= 20
NODE_MAJOR_INSTALL="22" # what we pull from NodeSource if the distro is older
POLICY_RC_D="/usr/sbin/policy-rc.d"

DOMAIN=""
LETSENCRYPT_EMAIL=""
NO_TLS="no"
CONFIGURE_FIREWALL="no"
ADMIN_PASSWORD_FILE=""

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

# Undo whatever this run put in place only for its own duration, however it
# ends -- die, a failed command under set -e, or Ctrl-C. A policy-rc.d left
# behind would stop later package upgrades from restarting nginx.
POLICY_RC_D_OURS="no"
cleanup() {
  if [ "$POLICY_RC_D_OURS" = "yes" ]; then rm -f "$POLICY_RC_D"; fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage: sudo ./deploy/install.sh [options]

Options:
  --domain NAME             Domain the site will be served on. Required unless
                            --no-tls is given. Must already point at this host.
  --email ADDRESS           Address for Let's Encrypt expiry notices.
  --no-tls                  Skip certbot and serve plain HTTP on port 80. Only
                            correct when something in front of this box (a load
                            balancer, Cloudflare) terminates TLS -- see below.
  --admin-password-file F   Read the moderation password from file F instead of
                            prompting. The file is not modified or deleted.
  --repo URL                Git repository to install from.
                            (default: https://github.com/matts4242/rice_list.git)
  --branch NAME             Branch to check out. (default: main)
  --port N                  Port the app listens on, behind nginx. (default: 3000)
  --app-dir PATH            Where the code lives. (default: /opt/ricelist)
  --data-dir PATH           Where the database and uploads live, kept outside
                            the checkout so upgrades never touch it.
                            (default: /var/lib/ricelist)
  --site-name NAME          Name shown in the header and emails. (default: Rice List)
  --firewall                Configure and enable ufw (SSH and web only). Opens
                            every port sshd is really listening on first, and
                            refuses to enable ufw if it cannot find one. Off by
                            default: enabling a firewall over SSH can lock you
                            out, so opt in deliberately.
  -h, --help                Show this help.

The admin password can also come from the RICELIST_ADMIN_PASSWORD environment
variable. There is deliberately no --admin-password flag, because command line
arguments are visible to every user on the machine via ps.

A note on TLS. In production the session cookie is marked Secure, so a browser
will not store it over plain HTTP. Without TLS somewhere in the chain the site
still renders, but nobody can post an ad, send a message, report a listing or
sign in to moderation -- every form fails. Serve this over HTTPS.
USAGE
}

# --- Argument parsing -------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)              DOMAIN="${2:-}"; shift 2 ;;
    --email)               LETSENCRYPT_EMAIL="${2:-}"; shift 2 ;;
    --no-tls)              NO_TLS="yes"; shift ;;
    --admin-password-file) ADMIN_PASSWORD_FILE="${2:-}"; shift 2 ;;
    --repo)                REPO_URL="${2:-}"; shift 2 ;;
    --branch)              BRANCH="${2:-}"; shift 2 ;;
    --port)                PORT="${2:-}"; shift 2 ;;
    --app-dir)             APP_DIR="${2:-}"; shift 2 ;;
    --data-dir)            DATA_DIR="${2:-}"; shift 2 ;;
    --site-name)           SITE_NAME="${2:-}"; shift 2 ;;
    --firewall)            CONFIGURE_FIREWALL="yes"; shift ;;
    -h|--help)             usage; exit 0 ;;
    *)                     usage >&2; die "unknown option: $1" ;;
  esac
done

# --- Preflight --------------------------------------------------------------

step "Checking the environment"

[ "$(id -u)" -eq 0 ] || die "run this with sudo."

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "Detected ${PRETTY_NAME:-unknown system}"
  if [ "${ID:-}" != "ubuntu" ]; then
    warn "This script targets Ubuntu. ${ID:-This system} may need adjustments."
  elif [ "${VERSION_ID:-}" != "26.04" ] && [ "${VERSION_ID:-}" != "24.04" ]; then
    warn "Tested against Ubuntu 24.04 and 26.04; ${VERSION_ID:-this release} is untested."
  fi
else
  warn "No /etc/os-release; assuming a Debian-family system."
fi

command -v systemctl >/dev/null || die "systemd is required and was not found."

case "$PORT" in
  ''|*[!0-9]*) die "--port must be a number, got: $PORT" ;;
esac

if [ "$NO_TLS" = "no" ]; then
  [ -n "$DOMAIN" ] || die "--domain is required (or pass --no-tls). See --help."
fi

if [ -n "$DOMAIN" ]; then
  case "$DOMAIN" in
    *[!a-zA-Z0-9.-]*|-*|.*|*.) die "--domain does not look like a hostname: $DOMAIN" ;;
  esac
fi

if [ -n "$ADMIN_PASSWORD_FILE" ] && [ ! -r "$ADMIN_PASSWORD_FILE" ]; then
  die "cannot read --admin-password-file: $ADMIN_PASSWORD_FILE"
fi

# Something already on the port is nearly always an earlier hand-rolled run of
# this app. Left alone it would win the bind and the new service would crash
# loop, so say so now rather than fifteen steps from here.

# Is the process on the port one of ours? On an upgrade it always is -- the
# running service holds its own port -- and asking systemd alone is not enough
# to tell: a unit that is failed, activating, or was renamed still leaves a
# process listening, and blocking on that would refuse every legitimate
# re-run. Identify it by what it is rather than by what systemd says.
port_holder_is_ours() {
  local holder="$1" pid
  pid="$(printf '%s' "$holder" | grep -oE 'pid=[0-9]+' | head -n 1 | cut -d= -f2)"
  [ -n "$pid" ] || return 1
  if tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null | grep -qF "$APP_DIR"; then
    return 0
  fi
  [ "$(stat -c %U "/proc/${pid}" 2>/dev/null)" = "$SERVICE_USER" ]
}

if command -v ss >/dev/null 2>&1; then
  port_holder="$(ss -lntpH "sport = :${PORT}" 2>/dev/null || true)"
  if [ -n "$port_holder" ] \
     && ! systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null \
     && ! port_holder_is_ours "$port_holder"; then
    warn "Something is already listening on port ${PORT}:"
    warn "  $(printf '%s' "$port_holder" | head -n 1 | tr -s ' ')"
    warn "That is usually this app started by hand. Stop it before continuing,"
    warn "or pass --port to run alongside it. Note that a copy left running on"
    warn "a public interface stays reachable without TLS and bypasses nginx."
    if [ -t 0 ]; then
      printf '    Continue anyway? [y/N] '
      read -r reply
      case "$reply" in [yY]*) : ;; *) die "stopped." ;; esac
    else
      die "refusing to continue with port ${PORT} in use (no terminal to confirm on)."
    fi
  fi
fi

if [ "$NO_TLS" = "yes" ]; then
  warn "TLS is disabled. Unless something in front of this host terminates"
  warn "TLS and forwards X-Forwarded-Proto, every form on the site will fail:"
  warn "the session cookie is Secure in production and browsers drop it"
  warn "over plain HTTP. Nobody will be able to post, message or sign in."
fi

ENV_FILE="$APP_DIR/.env"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NGINX_SITE="/etc/nginx/sites-available/${SERVICE_NAME}"

# Collect the admin password before any long-running work, so an interactive
# run does not sit waiting for input ten minutes in.
ADMIN_PASSWORD=""
if [ -n "$ADMIN_PASSWORD_FILE" ]; then
  ADMIN_PASSWORD="$(head -n 1 "$ADMIN_PASSWORD_FILE")"
  [ -n "$ADMIN_PASSWORD" ] || die "--admin-password-file is empty."
elif [ -n "${RICELIST_ADMIN_PASSWORD:-}" ]; then
  ADMIN_PASSWORD="$RICELIST_ADMIN_PASSWORD"
elif grep -qs '^ADMIN_PASSWORD_HASH=.\+' "$ENV_FILE"; then
  info "Keeping the moderation password already configured."
elif [ -t 0 ]; then
  printf '    Moderation password (blank to leave the panel disabled): '
  read -rs ADMIN_PASSWORD; printf '\n'
  if [ -n "$ADMIN_PASSWORD" ]; then
    printf '    Confirm: '
    read -rs confirm_password; printf '\n'
    [ "$ADMIN_PASSWORD" = "$confirm_password" ] || die "passwords did not match."
    unset confirm_password
  fi
else
  warn "No admin password given and no terminal to prompt on."
  warn "The moderation panel will stay disabled; re-run later to set one."
fi

# Every TCP port SSH can be reached on, asked three ways because each one
# alone can miss the port you are connected through: sshd -T reports sshd's
# own config, but on Ubuntu 24.04 systemd's ssh.socket owns the listener and
# a port moved with a socket drop-in never shows up there; ss shows what is
# really listening, but names systemd, not sshd, as the owner of an
# activated socket; and ssh.socket's Listen= covers exactly that case.
# Allowing a port nothing uses costs nothing; missing the real one locks the
# operator out the moment this session drops.
ssh_ports() {
  local sshd_settings
  {
    if command -v sshd >/dev/null 2>&1; then
      # sshd -T refuses to run without its privilege separation directory,
      # which ssh.service creates -- on 24.04 only once someone has logged in
      # over SSH since boot.
      install -d -m 0755 /run/sshd
      if sshd_settings="$(sshd -T 2>/dev/null)"; then
        printf '%s\n' "$sshd_settings" | awk '
          $1 == "port" { print $2 }
          $1 == "listenaddress" { sub(/.*:/, "", $2); print $2 }'
      else
        warn "sshd -T could not read the SSH configuration; going by the listening sockets alone."
      fi
    fi
    if command -v ss >/dev/null 2>&1; then
      ss -Htlnp 2>/dev/null \
        | awk '/users:\(\("sshd",/ { n = split($4, part, ":"); print part[n] }' || true
    fi
    if systemctl is-active --quiet ssh.socket 2>/dev/null \
       || systemctl is-enabled --quiet ssh.socket 2>/dev/null; then
      systemctl show -p Listen --value ssh.socket 2>/dev/null \
        | awk '{ n = split($1, part, ":"); print part[n] }' || true
    fi
  } | awk '/^[0-9]+$/ && $1 > 0 && $1 < 65536' | sort -un | tr '\n' ' ' | sed 's/ $//'
}

ufw_is_active() {
  command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'
}

# Worked out now, before anything is installed, so that a box we cannot read
# stops here rather than half way through with the firewall still to do.
SSH_PORTS=""
if [ "$CONFIGURE_FIREWALL" = "yes" ]; then
  SSH_PORTS="$(ssh_ports)"
  if [ -n "$SSH_PORTS" ]; then
    info "SSH is listening on: ${SSH_PORTS}"
  elif ufw_is_active; then
    warn "Could not tell which port SSH listens on; ufw is already active, so"
    warn "only the web rules will be added and its SSH rules are left as they are."
  else
    die "--firewall: could not tell which port SSH is listening on, and enabling
     ufw without allowing it would cut this session off for good. Allow your
     SSH port and enable ufw by hand (ufw allow PORT/tcp && ufw enable) -- with
     ufw already active this script only adds rules -- or drop --firewall."
  fi
fi

ok "Preflight checks passed"

# --- Packages ---------------------------------------------------------------

step "Installing system packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# nginx's package starts nginx the moment it is configured, with its stock
# default site -- which listens on [::]:80. On a kernel booted with
# ipv6.disable=1 that start fails, so dpkg fails, apt fails, and nginx is left
# half-configured: every later apt run, this script's re-runs included, fails
# the same way before our own IPv6 handling is ever reached. On such a host,
# hold nginx's start with a policy-rc.d for the length of the install, then
# take the default site out and start nginx ourselves. The policy denies
# nginx alone (invoke-rc.d passes "nginx", deb-systemd-invoke "nginx.service")
# and allows everything else, and the EXIT trap removes it however the run
# ends: left behind, it would stop later upgrades from restarting nginx.
POLICY_RC_D_MARK="# Written by deploy/install.sh to hold nginx's first start."
if grep -qsxF "$POLICY_RC_D_MARK" "$POLICY_RC_D"; then
  rm -f "$POLICY_RC_D"  # left behind by a run that was killed outright
fi
HOLD_NGINX_START="no"
# shellcheck disable=SC2016  # ${Status} is dpkg-query's field, not a variable
if [ ! -f /proc/net/if_inet6 ] \
   && [ "$(dpkg-query -W -f='${Status}' nginx 2>/dev/null || true)" != "install ok installed" ]; then
  if [ -e "$POLICY_RC_D" ]; then
    warn "No IPv6 on this host, and ${POLICY_RC_D} already exists, so this script"
    warn "cannot hold nginx's first start. If installing nginx fails, take the"
    warn "[::] listen out of /etc/nginx/sites-available/default, then re-run."
  else
    info "No IPv6 on this host; holding nginx's first start until its default site is out."
    POLICY_RC_D_OURS="yes"
    cat > "$POLICY_RC_D" <<POLICY
#!/bin/sh
${POLICY_RC_D_MARK}
for arg in "\$@"; do
  case "\$arg" in nginx|nginx.service) exit 101 ;; esac
done
exit 0
POLICY
    chmod 0755 "$POLICY_RC_D"
    HOLD_NGINX_START="yes"
  fi
fi

# build-essential and python3 are only needed if a native module (better-sqlite3,
# sharp) has no prebuilt binary for this platform and has to compile.
apt-get install -y -qq \
  ca-certificates curl git gnupg nginx build-essential python3 >/dev/null

if [ "$HOLD_NGINX_START" = "yes" ]; then
  rm -f "$POLICY_RC_D"
  POLICY_RC_D_OURS="no"
  # The packaged default site is what cannot start here; ours replaces it
  # further down in any case.
  rm -f /etc/nginx/sites-enabled/default
  systemctl start nginx || die "nginx did not start; see: journalctl -u nginx"
fi
ok "Base packages installed"

# --- Node -------------------------------------------------------------------

step "Installing Node.js"

node_major() {
  command -v node >/dev/null || return 1
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || return 1
}

install_node_from_nodesource() {
  info "Adding the NodeSource repository for Node ${NODE_MAJOR_INSTALL}.x"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR_INSTALL}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
}

current_major="$(node_major || echo 0)"
if [ "${current_major:-0}" -ge "$NODE_MAJOR_MIN" ]; then
  ok "Node $(node -v) already present"
else
  # Prefer the distro package when it is new enough; Ubuntu 26.04 ships a
  # current Node, older releases do not.
  candidate="$(apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ {print $2}')"
  candidate_major="$(printf '%s' "$candidate" | sed -n 's/^\([0-9]\{1,\}\).*/\1/p')"
  if [ -n "$candidate_major" ] && [ "$candidate_major" -ge "$NODE_MAJOR_MIN" ]; then
    info "Installing nodejs $candidate from the Ubuntu archive"
    apt-get install -y -qq nodejs npm >/dev/null
  else
    install_node_from_nodesource
  fi

  current_major="$(node_major || echo 0)"
  [ "${current_major:-0}" -ge "$NODE_MAJOR_MIN" ] \
    || die "Node >= ${NODE_MAJOR_MIN} is required; got $(node -v 2>/dev/null || echo none)."
  ok "Node $(node -v) installed"
fi

command -v npm >/dev/null || die "npm was not installed alongside Node."

# Pin the interpreter. A machine can carry more than one Node -- a system
# package plus an nvm build, say -- and root's PATH and sudo's secure_path can
# resolve different ones. Native modules like better-sqlite3 are compiled for
# the exact ABI of whichever node ran npm, so if the service then starts under
# a different node it dies on ERR_DLOPEN_FAILED. Build and run with the same
# binary by putting it first on the PATH for every command we run as the
# service user, and naming it in the unit.
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
SERVICE_PATH="${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
info "Using ${NODE_BIN} for both the build and the service"

# --- Service account and directories ----------------------------------------

step "Creating the service account"

if id -u "$SERVICE_USER" >/dev/null 2>&1; then
  ok "User $SERVICE_USER already exists"
else
  useradd --system --create-home --home-dir "$DATA_DIR" \
          --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "Created system user $SERVICE_USER"
fi

install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$APP_DIR"
ok "Data directory ready at $DATA_DIR"

# --- Code -------------------------------------------------------------------

step "Fetching the application"

run_as_service() {
  sudo -u "$SERVICE_USER" env "PATH=$SERVICE_PATH" "HOME=$DATA_DIR" "$@"
}

if [ -d "$APP_DIR/.git" ]; then
  info "Updating the existing checkout"
  run_as_service git -C "$APP_DIR" remote set-url origin "$REPO_URL"
  run_as_service git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  run_as_service git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
else
  # A non-empty directory that is not a checkout is almost certainly a mistake
  # or a previous install; refuse rather than clobber whatever is in it.
  if [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    die "$APP_DIR is not empty and is not a git checkout. Move it aside first."
  fi
  info "Cloning $REPO_URL ($BRANCH)"
  run_as_service git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

# Record the branch this install follows where deploy/redeploy.sh looks for
# it. Once HEAD is detached -- deploying a tag does that, and so did every
# redeploy before -- the checkout itself no longer says, and redeploy's guess
# was the remote's default branch: a plain update shipped main to an install
# of --branch stable. As the service user, like every git command here: git's
# safe.directory check refuses root in a repository owned by somebody else.
run_as_service git -C "$APP_DIR" config ricelist.branch "$BRANCH"
ok "Source at $(run_as_service git -C "$APP_DIR" rev-parse --short HEAD), tracking ${BRANCH}"

step "Installing dependencies"

# Runs as the service user, so npm lifecycle scripts never execute as root.
install_dependencies() {
  run_as_service npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund
}

# npm's exit code is not evidence that anything was installed. Its "Exit
# handler never called" bug leaves the dependency directories behind as empty
# shells and still exits 0, which produces a service that crash loops on
# MODULE_NOT_FOUND while the installer claims success. Ask the question that
# actually matters instead: do the declared dependencies load?
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

if [ -n "$missing" ]; then
  die "dependencies are still missing after a clean retry: ${missing}
     The service cannot start without them. Look at the npm output above;
     a native module that has to compile needs build-essential and python3,
     which this script installs, and enough memory to run the compiler.
     Retry by hand with:
       sudo -u ${SERVICE_USER} HOME=${DATA_DIR} npm --prefix ${APP_DIR} ci --omit=dev"
fi
ok "Dependencies installed and verified"

# --- Configuration ----------------------------------------------------------

step "Writing configuration"

# Reuse the existing session secret. Regenerating it would sign every visitor
# out and invalidate the CSRF token in every open form.
if [ -f "$ENV_FILE" ] && grep -q '^SESSION_SECRET=.\+' "$ENV_FILE"; then
  SESSION_SECRET="$(sed -n 's/^SESSION_SECRET=//p' "$ENV_FILE" | head -n 1)"
  info "Reusing the existing session secret"
else
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  info "Generated a new session secret"
fi

# Likewise the admin hash, unless a new password was supplied this run.
ADMIN_PASSWORD_HASH=""
if [ -n "$ADMIN_PASSWORD" ]; then
  # Hashed via stdin rather than argv so the password never appears in ps.
  ADMIN_PASSWORD_HASH="$(
    printf '%s' "$ADMIN_PASSWORD" | run_as_service node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", () => {
        const { hashPassword } = require(process.argv[1] + "/src/lib/passwords");
        process.stdout.write(hashPassword(input));
      });
    ' "$APP_DIR"
  )"
  unset ADMIN_PASSWORD
  info "Moderation password set"
elif [ -f "$ENV_FILE" ]; then
  ADMIN_PASSWORD_HASH="$(sed -n 's/^ADMIN_PASSWORD_HASH=//p' "$ENV_FILE" | head -n 1)"
fi

if [ "$NO_TLS" = "yes" ]; then
  SITE_URL="http://${DOMAIN:-localhost}"
else
  SITE_URL="https://${DOMAIN}"
fi

# Uploads have to fit through nginx: the app accepts MAX_IMAGES_PER_LISTING
# files of MAX_IMAGE_BYTES each, and nginx's 1 MB default would reject them
# with a 413 long before the app saw them.
MAX_IMAGE_BYTES=8388608
MAX_IMAGES=6
UPLOAD_LIMIT_MB=$(( (MAX_IMAGE_BYTES * MAX_IMAGES) / 1048576 + 8 ))

umask 077
cat > "$ENV_FILE" <<ENVFILE
# Written by deploy/install.sh. Re-running the installer preserves
# SESSION_SECRET and ADMIN_PASSWORD_HASH; everything else is regenerated.

NODE_ENV=production
PORT=${PORT}

# Loopback only. nginx reaches the app over 127.0.0.1, and binding no wider
# means nothing can skip it: with TRUST_PROXY=1 below, a client that reached
# this port directly could set X-Forwarded-For and pick its own identity,
# which would let it walk straight through every rate limit.
HOST=127.0.0.1

SITE_NAME=${SITE_NAME}
SITE_URL=${SITE_URL}
SESSION_SECRET=${SESSION_SECRET}

# nginx is the only thing talking to this process, so trust its forwarded
# headers -- without this every request looks like it came from 127.0.0.1 and
# the rate limits apply to the whole internet at once.
TRUST_PROXY=1

# Kept outside the checkout so upgrades never touch the database or uploads.
DATA_DIR=${DATA_DIR}

ADMIN_PASSWORD_HASH=${ADMIN_PASSWORD_HASH}

LISTINGS_PER_PAGE=24
LISTING_EXPIRY_DAYS=45
MAX_IMAGES_PER_LISTING=${MAX_IMAGES}
MAX_IMAGE_BYTES=${MAX_IMAGE_BYTES}
POSTS_PER_HOUR=5
MESSAGES_PER_HOUR=10
EDITS_PER_HOUR=30
AUTO_HIDE_FLAG_COUNT=5

# Without SMTP the site still works: messages are stored and shown in the
# seller's inbox, they are just not emailed. Fill these in to relay them.
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
MAIL_FROM=${SITE_NAME} <no-reply@${DOMAIN:-localhost}>
ENVFILE
umask 022

chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "Wrote $ENV_FILE (owner $SERVICE_USER, mode 600)"

if [ -z "$ADMIN_PASSWORD_HASH" ]; then
  warn "No moderation password is set, so /admin/login is disabled."
  warn "Re-run this script to set one."
fi

# --- systemd ----------------------------------------------------------------

step "Installing the systemd service"

cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=${SITE_NAME}
Documentation=https://github.com/matts4242/rice_list
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/src/server.js
Restart=on-failure
RestartSec=5s
# server.js closes the listener on SIGTERM, which systemd sends by default.
TimeoutStopSec=20s

# Hardening. The service owns its code directory so deploys can write to it,
# but ProtectSystem=strict means the running process cannot: the only writable
# path is the data directory.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${DATA_DIR}
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
# MemoryDenyWriteExecute is deliberately not set: it breaks V8's JIT and the
# process would fail to start.

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --quiet "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
ok "Service ${SERVICE_NAME} enabled and started"

# --- nginx ------------------------------------------------------------------

step "Configuring nginx"

SERVER_NAME="${DOMAIN:-_}"

# In no-TLS mode an upstream proxy may already have terminated TLS, so pass its
# X-Forwarded-Proto through when present and fall back to our own scheme. With
# our own certificate the scheme here is authoritative, so use it directly and
# ignore anything the client claims.
if [ "$NO_TLS" = "yes" ]; then
  cat > /etc/nginx/conf.d/${SERVICE_NAME}-forwarded.conf <<'MAP'
map $http_x_forwarded_proto $ricelist_forwarded_proto {
    default   $scheme;
    "~^https$" https;
    "~^http$"  http;
}
MAP
  # Single-quoted on purpose: nginx expands these, not bash.
  # shellcheck disable=SC2016
  FORWARDED_PROTO='$ricelist_forwarded_proto'
else
  rm -f /etc/nginx/conf.d/${SERVICE_NAME}-forwarded.conf
  # shellcheck disable=SC2016
  FORWARDED_PROTO='$scheme'
fi

# Only bind IPv6 where the kernel actually has it: on a host with IPv6
# disabled, "listen [::]:80" makes nginx fail to start outright.
LISTEN_DIRECTIVES="    listen 80;"
if [ -f /proc/net/if_inet6 ]; then
  LISTEN_DIRECTIVES="${LISTEN_DIRECTIVES}"$'\n'"    listen [::]:80;"
else
  info "No IPv6 on this host; nginx will listen on IPv4 only."
fi

cat > "$NGINX_SITE" <<NGINX
server {
${LISTEN_DIRECTIVES}
    server_name ${SERVER_NAME};

    # Large enough for ${MAX_IMAGES} images of $(( MAX_IMAGE_BYTES / 1048576 )) MB.
    # nginx defaults to 1 MB and would reject uploads with a 413.
    client_max_body_size ${UPLOAD_LIMIT_MB}m;

    # The app sets its own security headers via helmet; nothing to add here.
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto ${FORWARDED_PROTO};
        proxy_read_timeout 60s;
    }
}
NGINX

ln -sfn "$NGINX_SITE" "/etc/nginx/sites-enabled/${SERVICE_NAME}"
# Ubuntu's packaged default site answers on port 80 for every hostname and
# would otherwise shadow ours when no domain is set.
rm -f /etc/nginx/sites-enabled/default

nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx rejected its configuration."; }
# reload-or-restart rather than reload: it also starts an nginx that is not
# running, as after a package install whose start a policy-rc.d held back.
systemctl reload-or-restart nginx
ok "nginx serving ${SERVER_NAME} on port 80"

# --- TLS --------------------------------------------------------------------

if [ "$NO_TLS" = "yes" ]; then
  step "Skipping TLS (--no-tls)"
  warn "Remember: without HTTPS the session cookie is never stored and every"
  warn "form on the site will fail. Put TLS in front of this host."
else
  step "Obtaining a certificate for ${DOMAIN}"
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null

  certbot_args=(--nginx --non-interactive --agree-tos --redirect -d "$DOMAIN")
  if [ -n "$LETSENCRYPT_EMAIL" ]; then
    certbot_args+=(--email "$LETSENCRYPT_EMAIL")
  else
    certbot_args+=(--register-unsafely-without-email)
    warn "No --email given; Let's Encrypt cannot warn you before expiry."
  fi

  if certbot "${certbot_args[@]}"; then
    ok "HTTPS enabled, with HTTP redirecting to it"
    systemctl reload nginx
  else
    warn "certbot failed. The site is up on plain HTTP, but forms will not"
    warn "work until TLS is in place. The usual cause is DNS: ${DOMAIN} must"
    warn "already resolve to this machine, and ports 80 and 443 must be open."
    warn "Fix that, then run: certbot --nginx -d ${DOMAIN}"
  fi
fi

# --- Firewall ---------------------------------------------------------------

if [ "$CONFIGURE_FIREWALL" = "yes" ]; then
  step "Configuring the firewall"
  apt-get install -y -qq ufw >/dev/null
  ufw_was_active="no"
  if ufw_is_active; then ufw_was_active="yes"; fi
  [ -n "$SSH_PORTS" ] || [ "$ufw_was_active" = "yes" ] \
    || die "no SSH port known; refusing to enable ufw."

  # SSH first, on every port it was found listening on. The OpenSSH profile
  # is port 22 only, so on a box whose sshd uses another one it let the
  # firewall cut off every new connection the moment this session ended.
  for port in $SSH_PORTS; do
    ufw allow "${port}/tcp" comment "SSH" >/dev/null
  done
  ufw allow 'Nginx Full' >/dev/null

  if [ "$ufw_was_active" = "yes" ]; then
    # Already enforcing the operator's own rules; adding ours is enough.
    ok "ufw was already active; allowed SSH (${SSH_PORTS:-left as it was}) and web traffic"
  else
    ufw --force enable >/dev/null
    ok "ufw enabled, allowing SSH on ${SSH_PORTS} and web traffic"
  fi
else
  step "Firewall left alone"
  info "Enabling a firewall over SSH can lock you out, so it is opt-in."
  info "To do it later, re-run with --firewall: it allows every port sshd is"
  info "really listening on before enabling ufw."
fi

# --- Verify -----------------------------------------------------------------

step "Checking the site is up"

health_ok="no"
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    health_ok="yes"
    break
  fi
  sleep 1
done

if [ "$health_ok" != "yes" ]; then
  printf '\n'
  systemctl status "$SERVICE_NAME" --no-pager --lines=30 || true
  die "the service did not answer on /health. Its log is above; follow it with:
     journalctl -u ${SERVICE_NAME} -f"
fi
ok "Application responding on port ${PORT}"

if [ -n "$DOMAIN" ] && [ "$NO_TLS" = "no" ]; then
  if curl -fsS --max-time 10 "https://${DOMAIN}/health" >/dev/null 2>&1; then
    ok "https://${DOMAIN} reachable"
  else
    warn "Could not reach https://${DOMAIN}/health from this host."
    warn "Check DNS and that ports 80/443 are open."
  fi
fi

# --- Summary ----------------------------------------------------------------

cat <<SUMMARY

${C_GREEN}${C_BOLD}${SITE_NAME} is installed.${C_RESET}

  URL             ${SITE_URL}
  Moderation      ${SITE_URL}/admin/login$([ -z "$ADMIN_PASSWORD_HASH" ] && printf '  (disabled: no password set)')
  Code            ${APP_DIR}
  Data            ${DATA_DIR}   ${C_BOLD}<- back this up${C_RESET}
  Config          ${ENV_FILE}

Everyday commands:

  systemctl status ${SERVICE_NAME}
  systemctl restart ${SERVICE_NAME}
  journalctl -u ${SERVICE_NAME} -f

To update to the latest release, re-run this script with the same options.
Your database, uploads, session secret and admin password are preserved.

To back up, stop the service and copy the data directory (it holds both the
database and the uploaded images):

  systemctl stop ${SERVICE_NAME}
  tar czf ricelist-backup-\$(date +%F).tar.gz -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
  systemctl start ${SERVICE_NAME}

SUMMARY
