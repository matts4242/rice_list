#!/usr/bin/env bash
#
# Prepare a fresh Ubuntu VPS to host Rice List: updates, a swap file, an admin
# account, SSH hardening, a firewall, fail2ban and automatic security updates.
#
# This is the step *before* deploy/install.sh. It configures the machine;
# install.sh installs the application.
#
#   sudo ./deploy/setup-vps.sh --dry-run --hostname ricelist   # see the plan
#   sudo ./deploy/setup-vps.sh --hostname ricelist \
#        --admin-user matt --ssh-key-file ~/id_ed25519.pub --harden-ssh
#
# Locking yourself out of a VPS is the expensive mistake here, so the parts
# that could do it are opt-in, refuse to run without a working key in place,
# and never touch the firewall before SSH is allowed through it.

set -euo pipefail

# --- Defaults ---------------------------------------------------------------

HOSTNAME_NEW=""
TIMEZONE=""
ADMIN_USER=""
SSH_KEY=""
SSH_KEY_FILE=""
HARDEN_SSH="no"
SWAP_SIZE=""
SKIP_FIREWALL="no"
SKIP_FAIL2BAN="no"
SKIP_AUTO_UPDATES="no"
SKIP_UPGRADE="no"
DRY_RUN="no"
WEB_PORTS="80,443"

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

# Every mutating action goes through run/write_file, which is what makes
# --dry-run trustworthy: if it is not routed through here, it does not happen.
run() {
  if [ "$DRY_RUN" = "yes" ]; then
    printf '    %s[dry-run]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"
  else
    "$@"
  fi
}

write_file() {
  local path="$1" mode="${2:-0644}" content
  content="$(cat)"
  if [ "$DRY_RUN" = "yes" ]; then
    printf '    %s[dry-run]%s write %s (mode %s):\n' "$C_YELLOW" "$C_RESET" "$path" "$mode"
    printf '%s\n' "$content" | sed 's/^/        | /'
  else
    install -D -m "$mode" /dev/null "$path"
    printf '%s\n' "$content" > "$path"
  fi
}

usage() {
  cat <<'USAGE'
Usage: sudo ./deploy/setup-vps.sh [options]

Options:
  --hostname NAME        Set the system hostname.
  --timezone ZONE        Set the timezone, e.g. Etc/UTC or America/New_York.
  --admin-user NAME      Create this user with passwordless sudo, for logging
                         in instead of root. Needs a key; see --ssh-key-file.
  --ssh-key-file PATH    Public key to authorise for the admin user (and for
                         root, so an existing root session keeps working).
  --ssh-key "ssh-ed25519 AAAA..."
                         Same, given inline.
  --harden-ssh           Disable root login and password authentication.
                         Refuses unless an authorised key is already in place.
  --swap SIZE            Swap file size, e.g. 2G or 512M. Default: 2G when the
                         machine has under 2 GB of RAM and no swap, otherwise
                         none. Shrunk or skipped to keep 1 GB of disk free.
  --web-ports LIST       Ports to open for the site. (default: 80,443)
  --no-firewall          Do not configure or enable ufw.
  --no-fail2ban          Do not install fail2ban.
  --no-auto-updates      Do not enable unattended security upgrades.
  --no-upgrade           Skip "apt-get upgrade" (still refreshes the index).
  --dry-run              Print every change without making any of them.
  -h, --help             Show this help.

Recommended order for a new box:

  1. sudo ./deploy/setup-vps.sh --dry-run ...      read the plan
  2. sudo ./deploy/setup-vps.sh ...                apply it
  3. open a second SSH session and confirm you can still log in
  4. sudo ./deploy/install.sh --domain ... --email ...
USAGE
}

# --- Argument parsing -------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --hostname)         HOSTNAME_NEW="${2:-}"; shift 2 ;;
    --timezone)         TIMEZONE="${2:-}"; shift 2 ;;
    --admin-user)       ADMIN_USER="${2:-}"; shift 2 ;;
    --ssh-key-file)     SSH_KEY_FILE="${2:-}"; shift 2 ;;
    --ssh-key)          SSH_KEY="${2:-}"; shift 2 ;;
    --harden-ssh)       HARDEN_SSH="yes"; shift ;;
    --swap)             SWAP_SIZE="${2:-}"; shift 2 ;;
    --web-ports)        WEB_PORTS="${2:-}"; shift 2 ;;
    --no-firewall)      SKIP_FIREWALL="yes"; shift ;;
    --no-fail2ban)      SKIP_FAIL2BAN="yes"; shift ;;
    --no-auto-updates)  SKIP_AUTO_UPDATES="yes"; shift ;;
    --no-upgrade)       SKIP_UPGRADE="yes"; shift ;;
    --dry-run)          DRY_RUN="yes"; shift ;;
    -h|--help)          usage; exit 0 ;;
    *)                  usage >&2; die "unknown option: $1" ;;
  esac
done

# --- Preflight --------------------------------------------------------------

step "Checking the environment"

[ "$(id -u)" -eq 0 ] || die "run this with sudo."

if [ "$DRY_RUN" = "yes" ]; then
  info "${C_BOLD}Dry run: nothing on this machine will be changed.${C_RESET}"
fi

if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  info "Detected ${PRETTY_NAME:-unknown system}"
  [ "${ID:-}" = "ubuntu" ] || warn "This targets Ubuntu; ${ID:-this system} may differ."
fi

if [ -n "$SSH_KEY_FILE" ]; then
  [ -r "$SSH_KEY_FILE" ] || die "cannot read --ssh-key-file: $SSH_KEY_FILE"
  SSH_KEY="$(head -n 1 "$SSH_KEY_FILE")"
fi

if [ -n "$SSH_KEY" ]; then
  case "$SSH_KEY" in
    ssh-rsa\ *|ssh-ed25519\ *|ecdsa-sha2-*\ *|sk-ssh-ed25519*\ *|sk-ecdsa-sha2-*\ *) : ;;
    *) die "that does not look like an SSH public key. Give the .pub file,
     not the private key." ;;
  esac
fi

if [ -n "$ADMIN_USER" ]; then
  case "$ADMIN_USER" in
    *[!a-z0-9_-]*|-*|"") die "--admin-user must be a plain lowercase name." ;;
  esac
fi

# Swap is sized in whole MB or GB so it can be checked against free space.
SWAP_MB=""
if [ -n "$SWAP_SIZE" ]; then
  [[ "$SWAP_SIZE" =~ ^([1-9][0-9]*)([MmGg])$ ]] \
    || die "--swap takes a size like 512M or 2G, not '$SWAP_SIZE'."
  SWAP_MB="${BASH_REMATCH[1]}"
  case "${BASH_REMATCH[2]}" in [Gg]) SWAP_MB=$(( SWAP_MB * 1024 )) ;; esac
fi

# sshd -T and sshd -t refuse to run without /run/sshd. ssh.service creates it
# when it starts, but on Ubuntu 24.04 that service is socket-activated and has
# not started at all if nobody has logged in over SSH since boot -- exactly
# the state of a box set up from the provider's console or by cloud-init. It
# is a runtime directory on tmpfs, made here just as ssh.service makes it.
ensure_privsep_dir() {
  [ -d /run/sshd ] || run install -d -m 0755 /run/sshd
}

# The configuration sshd would really run with, every Include and default
# resolved. Left empty only by a dry run that may not create /run/sshd.
SSHD_CONFIG=""
read_sshd_config() {
  ensure_privsep_dir
  if [ "$DRY_RUN" = "yes" ] && [ ! -d /run/sshd ]; then
    warn "No SSH login since boot, so no /run/sshd and sshd -T cannot run in a dry run; a real run creates it first."
    return 0
  fi
  SSHD_CONFIG="$(sshd -T)" \
    || die "sshd -T could not read the SSH configuration; fix what it reports above and re-run."
}

# Every TCP port sshd can be reached on. The config alone is not enough: a
# port passed with -p in SSHD_OPTS (/etc/default/ssh), or set by an
# ssh.socket override on 24.04, never shows up in sshd -T, and a config
# edited since sshd last restarted names ports nothing listens on yet. So
# take the union of what the config says, what sshd has open, and what
# ssh.socket listens on for it. A port too many costs nothing; missing the
# one in use locks everybody out the moment ufw is enabled.
ssh_ports() {
  {
    # "port 22", and "listenaddress 0.0.0.0:2222", whose own port wins.
    printf '%s\n' "$SSHD_CONFIG" \
      | awk '$1 == "port" { print $2 } $1 == "listenaddress" { n = split($2, a, ":"); print a[n] }'
    if command -v ss >/dev/null 2>&1; then
      ss -Htlnp | awk '$1 == "LISTEN" && /\("sshd",/ { n = split($4, a, ":"); print a[n] }' || true
    else
      warn "ss (iproute2) is missing, so the ports sshd has open cannot be checked."
    fi
    # With socket activation (24.04's default) systemd holds the listening
    # socket, so until the first login ss shows it owned by systemd (pid 1),
    # not sshd. Ask systemd what ssh.socket listens on.
    if systemctl is-active --quiet ssh.socket 2>/dev/null; then
      systemctl show -p Listen --value ssh.socket | awk '{ n = split($1, a, ":"); print a[n] }' || true
    fi
  } | awk '/^[0-9]+$/ && $1 > 0 && $1 < 65536' | sort -nu | tr '\n' ' ' | sed 's/ $//'
}

# Never a guessed default: the firewall allows exactly these ports before it
# is enabled, and fail2ban guards them.
SSH_PORTS=""
if [ "$SKIP_FIREWALL" = "no" ] || [ "$SKIP_FAIL2BAN" = "no" ]; then
  read_sshd_config
  SSH_PORTS="$(ssh_ports)"
  if [ -n "$SSH_PORTS" ]; then
    info "SSH is reachable on port(s) ${SSH_PORTS// /, }"
  elif [ "$DRY_RUN" = "yes" ]; then
    warn "Found no port sshd listens on yet; a real run reads them from sshd -T."
  else
    die "found no port sshd listens on, so enabling a firewall could lock you out.
     Check that sshd is installed and running, or pass --no-firewall --no-fail2ban."
  fi
fi

ok "Preflight checks passed"

# --- Updates ----------------------------------------------------------------

step "Updating the system"
export DEBIAN_FRONTEND=noninteractive

# A VPS booted a few minutes ago is usually still running apt-daily and
# unattended-upgrades, which hold apt's locks for minutes at a time, and
# apt-get gives up the moment it meets a held lock. DPkg::Lock::Timeout makes
# install and upgrade wait for the dpkg lock instead. It does not cover the
# package-lists lock that apt-get update takes (as of apt 2.8), so update is
# retried while that lock is busy -- and only then: any other failure, a
# broken sources.list say, stops the run at once rather than ten minutes on.
apt_get() {
  run apt-get -o DPkg::Lock::Timeout=600 "$@"
}

apt_update() {
  local out tries=0
  if [ "$DRY_RUN" = "yes" ]; then
    run apt-get update -qq
    return 0
  fi
  until out="$(LC_ALL=C apt-get update -qq 2>&1)"; do
    case "$out" in
      *"Could not get lock"*) ;;
      *) printf '%s\n' "$out" >&2; return 1 ;;
    esac
    tries=$(( tries + 1 ))
    if [ "$tries" -ge 60 ]; then
      printf '%s\n' "$out" >&2
      return 1
    fi
    if [ "$tries" -eq 1 ]; then
      info "apt is busy (on a new VPS, usually its own first update); waiting up to 10 minutes."
    fi
    sleep 10
  done
  if [ -n "$out" ]; then printf '%s\n' "$out" >&2; fi
}

apt_update || die "apt-get update failed; see the messages above."
if [ "$SKIP_UPGRADE" = "no" ]; then
  apt_get -y -qq -o Dpkg::Options::=--force-confold upgrade
  ok "Packages upgraded"
else
  info "Skipping upgrade (--no-upgrade)"
fi

# Everything the later steps need is installed here, before any account, SSH
# or firewall change. A package that fails to install then stops the run
# while nothing is half-configured -- not with SSH already hardened and the
# firewall and fail2ban still missing.
packages=(ca-certificates curl gnupg git)
if [ "$SKIP_FIREWALL" = "no" ]; then packages+=(ufw); fi
if [ "$SKIP_FAIL2BAN" = "no" ]; then packages+=(fail2ban); fi
if [ "$SKIP_AUTO_UPDATES" = "no" ]; then packages+=(unattended-upgrades); fi
apt_get install -y -qq "${packages[@]}"
ok "Packages present: ${packages[*]}"

# --- Identity ---------------------------------------------------------------

if [ -n "$HOSTNAME_NEW" ] || [ -n "$TIMEZONE" ]; then
  step "Setting identity"
  if [ -n "$HOSTNAME_NEW" ]; then
    run hostnamectl set-hostname "$HOSTNAME_NEW"
    ok "Hostname set to $HOSTNAME_NEW"
  fi
  if [ -n "$TIMEZONE" ]; then
    run timedatectl set-timezone "$TIMEZONE"
    ok "Timezone set to $TIMEZONE"
  fi
fi

# --- Swap -------------------------------------------------------------------

step "Checking memory and swap"

mem_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
mem_mb=$(( mem_kb / 1024 ))
swap_kb="$(awk '/^SwapTotal:/{print $2}' /proc/meminfo)"
info "RAM: ${mem_mb} MB, swap: $(( swap_kb / 1024 )) MB"

want_mb="$SWAP_MB"
if [ -z "$want_mb" ] && [ "$swap_kb" -eq 0 ] && [ "$mem_mb" -lt 2048 ]; then
  # sharp re-encodes uploads in memory and npm's native builds are hungry;
  # on a 1 GB box either can be killed by the OOM reaper without swap.
  want_mb=2048
  info "Small machine with no swap; adding 2G."
fi

swapfile_active() { awk 'NR > 1 && $1 == "/swapfile" { found = 1 } END { exit !found }' /proc/swaps; }
swapfile_in_fstab() { grep -qs '^[[:space:]]*/swapfile[[:space:]]' /etc/fstab; }

make_swapfile() {
  local mb="$1"
  if [ "$(stat -f -c %T /)" = "btrfs" ]; then
    # swapon rejects a fallocated file on btrfs, which is copy-on-write;
    # this makes the no-COW file it accepts, already formatted as swap.
    run btrfs filesystem mkswapfile --size "${mb}m" /swapfile || return 1
  else
    run fallocate -l "${mb}M" /swapfile || return 1
    run chmod 600 /swapfile || return 1
    run mkswap /swapfile || return 1
  fi
  run swapon /swapfile
}

add_swap() {
  local mb="$1" avail_mb room_mb reclaim_mb=0
  if [ -e /swapfile ]; then
    # Not in use and not in fstab: debris from an earlier attempt that died
    # part-way, quite possibly the very file that filled the disk.
    reclaim_mb="$(du -m /swapfile | cut -f1)"
    info "/swapfile is left over from an earlier attempt that failed; replacing it."
    run rm -f /swapfile
    [ "$DRY_RUN" = "yes" ] || reclaim_mb=0
  fi

  # A full root filesystem breaks apt, journald, install.sh and SQLite all
  # at once, which is far worse than no swap. Keep 1 GB of it free.
  avail_mb=$(( $(df -m --output=avail / | tail -n 1) + reclaim_mb ))
  room_mb=$(( avail_mb - 1024 ))
  if [ "$room_mb" -lt "$mb" ]; then
    if [ "$room_mb" -lt 256 ]; then
      warn "Only ${avail_mb} MB free on /; adding no swap, to keep 1 GB free."
      return 0
    fi
    warn "Only ${avail_mb} MB free on /; adding ${room_mb} MB of swap instead, to keep 1 GB free."
    mb="$room_mb"
  fi

  # Any step can fail part-way: fallocate stops at ENOSPC still holding the
  # space it got, and swapon refuses files it cannot use (ZFS, containers).
  # Delete the file again before anything refers to it, so a failure never
  # leaves it eating the disk. It is not in use and not in fstab, so this
  # can never remove live swap.
  if ! make_swapfile "$mb"; then
    swapfile_active || rm -f /swapfile
    warn "Could not set up swap; removed /swapfile again and carrying on without it."
    return 0
  fi
  if ! grep -qs '^/swapfile ' /etc/fstab; then
    if [ "$DRY_RUN" = "yes" ]; then
      info "[dry-run] append '/swapfile none swap sw 0 0' to /etc/fstab"
    else
      printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
    fi
  fi
  ok "Added ${mb} MB of swap"
}

if [ -z "$want_mb" ]; then
  ok "Swap is fine as it is"
elif [ "$swap_kb" -gt 0 ]; then
  info "Swap already active; leaving it alone."
elif [ -L /swapfile ] || { [ -e /swapfile ] && [ ! -f /swapfile ]; }; then
  warn "/swapfile exists but is not a plain file; leaving it alone."
elif [ -e /swapfile ] && { swapfile_active || swapfile_in_fstab; }; then
  warn "/swapfile is listed in /etc/fstab but not in use; leaving it alone."
else
  add_swap "$want_mb"
fi

# --- Admin user -------------------------------------------------------------

authorize_key_for() {
  local user="$1" home ssh_dir

  # In a dry run the adduser above did not actually happen, so the account we
  # are about to key may not exist yet. Say what would happen and move on.
  if [ "$DRY_RUN" = "yes" ] && ! id -u "$user" >/dev/null 2>&1; then
    info "[dry-run] authorise key for ${user} (created earlier in a real run)"
    return 0
  fi

  # getent exits 2 for an unknown user, which pipefail would turn into an
  # abort; absorb it and check for an empty result instead.
  home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)"
  [ -n "$home" ] || { warn "no home directory for $user; skipping key."; return 0; }
  ssh_dir="$home/.ssh"

  if [ "$DRY_RUN" = "yes" ]; then
    info "[dry-run] authorise key for ${user} in ${ssh_dir}/authorized_keys"
    return 0
  fi
  install -d -o "$user" -g "$user" -m 0700 "$ssh_dir"
  touch "$ssh_dir/authorized_keys"
  if ! grep -qxF "$SSH_KEY" "$ssh_dir/authorized_keys"; then
    printf '%s\n' "$SSH_KEY" >> "$ssh_dir/authorized_keys"
  fi
  chown "$user:$user" "$ssh_dir/authorized_keys"
  chmod 0600 "$ssh_dir/authorized_keys"
}

if [ -n "$ADMIN_USER" ]; then
  step "Setting up the admin account"
  if id -u "$ADMIN_USER" >/dev/null 2>&1; then
    ok "User $ADMIN_USER already exists"
  else
    run adduser --disabled-password --gecos "" "$ADMIN_USER"
    ok "Created $ADMIN_USER"
  fi
  run usermod -aG sudo "$ADMIN_USER"

  write_file "/etc/sudoers.d/90-${ADMIN_USER}" 0440 <<SUDOERS
${ADMIN_USER} ALL=(ALL) NOPASSWD:ALL
SUDOERS
  # A malformed sudoers file locks out sudo entirely, so check before trusting it.
  if [ "$DRY_RUN" = "no" ]; then
    visudo -cf "/etc/sudoers.d/90-${ADMIN_USER}" >/dev/null \
      || { rm -f "/etc/sudoers.d/90-${ADMIN_USER}"; die "generated sudoers file was invalid; removed it."; }
  fi
  ok "Passwordless sudo granted"

  if [ -n "$SSH_KEY" ]; then
    authorize_key_for "$ADMIN_USER"
    ok "SSH key authorised for $ADMIN_USER"
  else
    warn "No --ssh-key given, so $ADMIN_USER has no way to log in yet."
  fi
fi

# Keep the current root session working after hardening.
if [ -n "$SSH_KEY" ]; then
  authorize_key_for root
fi

# --- SSH hardening ----------------------------------------------------------

if [ "$HARDEN_SSH" = "yes" ]; then
  step "Hardening SSH"

  # Refuse to disable password login unless somebody can still get in by key.
  key_present="no"
  for candidate in ${ADMIN_USER:+/home/$ADMIN_USER/.ssh/authorized_keys} /root/.ssh/authorized_keys; do
    [ -s "$candidate" ] && key_present="yes"
  done
  if [ -n "$SSH_KEY" ]; then key_present="yes"; fi

  if [ "$key_present" != "yes" ]; then
    die "refusing to disable password authentication: no authorized_keys found.
     Pass --ssh-key-file with your public key, or set one up first.
     Doing this without a key would lock you out of the machine."
  fi

  # A drop-in rather than an edit of sshd_config: Ubuntu's default config ends
  # with an Include of this directory, so the last word is ours and the
  # packaged file stays pristine for the next release upgrade.
  write_file /etc/ssh/sshd_config.d/99-ricelist-hardening.conf 0644 <<'SSHD'
# Written by deploy/setup-vps.sh.
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
UsePAM yes
X11Forwarding no
MaxAuthTries 4
SSHD

  if [ "$DRY_RUN" = "no" ]; then
    sshd -t || { rm -f /etc/ssh/sshd_config.d/99-ricelist-hardening.conf
                 die "sshd rejected the hardening config; removed it and changed nothing."; }
  fi
  run systemctl reload ssh
  ok "Root password login and password authentication disabled"
  warn "Before closing this session, open a NEW one and confirm you can log in."
else
  step "Leaving SSH configuration alone"
  info "Pass --harden-ssh (with --ssh-key-file) to disable password logins."
fi

# --- Firewall ---------------------------------------------------------------

if [ "$SKIP_FIREWALL" = "no" ]; then
  step "Configuring the firewall"

  # SSH first, always, on every port sshd can be reached on. Enabling ufw
  # with the port in use missing refuses every new SSH connection, and the
  # machine is then only reachable through the provider's console.
  if [ -z "$SSH_PORTS" ]; then
    # Only a dry run gets here; a real run has already stopped in preflight.
    [ "$DRY_RUN" = "yes" ] || die "no SSH port known; refusing to enable the firewall."
    info "[dry-run] ufw allow <each port sshd -T reports>/tcp"
  fi
  for port in $SSH_PORTS; do
    run ufw allow "${port}/tcp" comment "SSH"
  done
  ok "Allowed SSH on ${SSH_PORTS:-its port(s)} (tcp)"

  old_ifs="$IFS"; IFS=','
  for port in $WEB_PORTS; do
    IFS="$old_ifs"
    port="$(printf '%s' "$port" | tr -d '[:space:]')"
    [ -n "$port" ] || continue
    run ufw allow "${port}/tcp" comment "Rice List web"
    IFS=','
  done
  IFS="$old_ifs"
  ok "Allowed web traffic on ${WEB_PORTS}"

  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw --force enable
  ok "Firewall enabled"
  info "The app's own port stays closed: nginx reaches it over loopback, and"
  info "reaching it directly would bypass TLS and defeat the rate limits."
else
  step "Firewall left alone (--no-firewall)"
  warn "Without a firewall, any port a process opens is exposed to the internet."
fi

# --- fail2ban ---------------------------------------------------------------

if [ "$SKIP_FAIL2BAN" = "no" ]; then
  step "Configuring fail2ban"

  f2b_ports="${SSH_PORTS// /,}"
  write_file /etc/fail2ban/jail.d/ricelist.local 0644 <<JAIL
# Written by deploy/setup-vps.sh.
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port    = ${f2b_ports:-<the SSH ports a real run finds>}
JAIL

  # On 24.04 the package starts fail2ban the moment it is installed, with
  # its stock sshd jail (port 22, 10 minute bans), and "enable --now" does
  # nothing to a unit that is already running: this file would not load
  # until a reboot. So check it parses, then restart to load it.
  if [ "$DRY_RUN" = "no" ] && ! f2b_test="$(fail2ban-client -t 2>&1)"; then
    printf '%s\n' "$f2b_test" >&2
    rm -f /etc/fail2ban/jail.d/ricelist.local
    die "fail2ban rejected its configuration (above); removed the jail file."
  fi
  run systemctl enable fail2ban
  run systemctl restart fail2ban

  # The unit is Type=simple: restart returns once the server process exists,
  # even if the sshd jail then fails to load. Ask the server itself.
  if [ "$DRY_RUN" = "no" ]; then
    tries=0
    until fail2ban-client status sshd >/dev/null 2>&1; do
      tries=$(( tries + 1 ))
      [ "$tries" -lt 20 ] \
        || die "fail2ban is not running its sshd jail; see 'journalctl -u fail2ban'."
      sleep 1
    done
  fi
  ok "fail2ban watching SSH on port(s) ${SSH_PORTS:-found by a real run}"
else
  step "Skipping fail2ban (--no-fail2ban)"
fi

# --- Automatic security updates ---------------------------------------------

if [ "$SKIP_AUTO_UPDATES" = "no" ]; then
  step "Enabling automatic security updates"

  write_file /etc/apt/apt.conf.d/20auto-upgrades 0644 <<'AUTOUP'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUTOUP

  run systemctl enable --now unattended-upgrades
  ok "Security updates will install themselves"
  info "Reboots are not automatic; check 'ls /var/run/reboot-required' now and then."
else
  step "Skipping automatic updates (--no-auto-updates)"
fi

# --- Summary ----------------------------------------------------------------

step "Summary"

if [ "$DRY_RUN" = "yes" ]; then
  cat <<SUMMARY

${C_YELLOW}${C_BOLD}Dry run: nothing was changed.${C_RESET}
Re-run without --dry-run to apply the plan above.

SUMMARY
  exit 0
fi

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"

cat <<SUMMARY

${C_GREEN}${C_BOLD}The VPS is configured.${C_RESET}

  Hostname     $(hostname)
  Public IP    ${PUBLIC_IP:-unknown}
  SSH port(s)  ${SSH_PORTS:-not checked}
  Admin user   ${ADMIN_USER:-<none created>}
  Firewall     $( [ "$SKIP_FIREWALL" = "no" ] && echo "on (SSH + ${WEB_PORTS})" || echo "not configured" )

${C_BOLD}Do this before you close this session:${C_RESET}

  Open a second terminal and confirm you can still log in$( [ -n "$ADMIN_USER" ] && printf ':\n    ssh %s@%s' "$ADMIN_USER" "${PUBLIC_IP:-<ip>}" )
  If that fails, you still have this session open to fix it.

${C_BOLD}Then point DNS at ${PUBLIC_IP:-this machine} and install the app:${C_RESET}

  sudo ./deploy/install.sh --domain your.domain --email you@example.com

SUMMARY
