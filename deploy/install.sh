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
  --firewall                Configure and enable ufw (SSH and web only). Off by
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
if command -v ss >/dev/null 2>&1; then
  port_holder="$(ss -lntpH "sport = :${PORT}" 2>/dev/null || true)"
  if [ -n "$port_holder" ] && ! systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
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

ok "Preflight checks passed"

# --- Packages ---------------------------------------------------------------

step "Installing system packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# build-essential and python3 are only needed if a native module (better-sqlite3,
# sharp) has no prebuilt binary for this platform and has to compile.
apt-get install -y -qq \
  ca-certificates curl git gnupg nginx build-essential python3 >/dev/null
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

run_as_service() { sudo -u "$SERVICE_USER" HOME="$DATA_DIR" "$@"; }

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
ok "Source at $(run_as_service git -C "$APP_DIR" rev-parse --short HEAD)"

step "Installing dependencies"
# Runs as the service user, so npm lifecycle scripts never execute as root.
if ! run_as_service npm --prefix "$APP_DIR" ci --omit=dev --no-audit --no-fund; then
  die "npm ci failed. The output above says why; native modules usually need
     build-essential and python3, which this script installs."
fi
ok "Dependencies installed"

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
ExecStart=$(command -v node) ${APP_DIR}/src/server.js
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
systemctl reload nginx
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
  # SSH first, so enabling the firewall cannot cut off this session.
  ufw allow OpenSSH >/dev/null
  ufw allow 'Nginx Full' >/dev/null
  ufw --force enable >/dev/null
  ok "ufw enabled, allowing SSH and web traffic"
else
  step "Firewall left alone"
  info "Enabling a firewall over SSH can lock you out, so it is opt-in."
  info "To do it later:"
  info "  ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable"
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
