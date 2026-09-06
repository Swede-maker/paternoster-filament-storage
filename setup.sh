#!/usr/bin/env bash
#
# PAX one-command installer for Raspberry Pi.
#
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/setup.sh | sudo bash
#
# or, from a checked-out copy:
#
#   sudo ./setup.sh
#
# Asks two or three questions, then does everything:
#
#   MASTER  (Pi 4/5)      web app + carousel agent + hotspot fallback + slave provisioning
#   SLAVE   (Pi Zero 2 W) carousel agent only, follows the master
#
# Re-running it on an installed system updates the code and restarts the
# services without touching your data (paternoster.db) or the hotspot password.
#
# Non-interactive use (for scripting / re-imaging):
#   sudo ./setup.sh --role master --shelves 9
#   sudo ./setup.sh --role slave --number 1 --shelves 9 --master pax-master.local --ap-psk <pw>
#
set -euo pipefail

# --------------------------------------------------------------------------
# Edit this ONE line when you publish the project. Everything else derives.
# --------------------------------------------------------------------------
PAX_REPO="${PAX_REPO:-https://github.com/YOUR-USERNAME/YOUR-REPO.git}"
PAX_BRANCH="${PAX_BRANCH:-main}"

APP_PORT="${APP_PORT:-80}"
AGENT_PORT=8765
DATA_DIR=/var/lib/pax

ROLE=""
SHELVES=""
NUMBER=""
MASTER_HOST=""
AP_PSK=""
AP_SSID=""
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --shelves) SHELVES="$2"; shift 2 ;;
    --number) NUMBER="$2"; shift 2 ;;
    --master) MASTER_HOST="$2"; shift 2 ;;
    --ap-ssid) AP_SSID="$2"; shift 2 ;;
    --ap-psk) AP_PSK="$2"; shift 2 ;;
    --repo) PAX_REPO="$2"; shift 2 ;;
    --branch) PAX_BRANCH="$2"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
say()  { printf '%s\n' "${BOLD}==>${RESET} $*"; }
note() { printf '%s\n' "    ${DIM}$*${RESET}"; }
warn() { printf '%s\n' "${YELLOW}warning:${RESET} $*" >&2; }
die()  { printf '%s\n' "${RED}error:${RESET} $*" >&2; exit 1; }

# Prompts read from the terminal, not stdin, so they work when the script is
# piped in from curl.
ask() {
  local prompt="$1" default="${2:-}" reply
  if [[ $ASSUME_YES -eq 1 ]]; then printf '%s' "$default"; return; fi
  if [[ -n "$default" ]]; then
    printf '%s [%s]: ' "$prompt" "$default" > /dev/tty
  else
    printf '%s: ' "$prompt" > /dev/tty
  fi
  IFS= read -r reply < /dev/tty || reply=""
  printf '%s' "${reply:-$default}"
}
ask_secret() {
  local prompt="$1" reply
  if [[ $ASSUME_YES -eq 1 ]]; then printf ''; return; fi
  printf '%s: ' "$prompt" > /dev/tty
  IFS= read -rs reply < /dev/tty || reply=""
  printf '\n' > /dev/tty
  printf '%s' "$reply"
}

[[ $EUID -eq 0 ]] || die "run with sudo:  curl -fsSL .../setup.sh | sudo bash"
command -v apt-get >/dev/null || die "this installer targets Raspberry Pi OS (Debian)"

# The human behind sudo owns the checkout and runs the services.
RUN_USER="${SUDO_USER:-}"
if [[ -z "$RUN_USER" || "$RUN_USER" == "root" ]]; then
  RUN_USER="$(awk -F: '$3>=1000 && $3<65534 {print $1; exit}' /etc/passwd)"
  [[ -n "$RUN_USER" ]] || die "could not find a normal user account; run as  sudo ./setup.sh  from your own login"
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo "unknown board")"
MEM_MB=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 ))

printf '\n%s\n' "${BOLD}PAX Paternoster installer${RESET}"
note "board: $MODEL, ${MEM_MB} MB RAM, user: $RUN_USER"
printf '\n'

# --------------------------------------------------------------------------
# Question 1: what is this Pi?
# --------------------------------------------------------------------------
if [[ -z "$ROLE" ]]; then
  printf '%s\n' "What is this Raspberry Pi?" > /dev/tty
  printf '%s\n' "  ${BOLD}1${RESET}) MASTER  – runs the PAX web app, drives a carousel, opens a hotspot if the Wi-Fi is gone" > /dev/tty
  printf '%s\n' "  ${BOLD}2${RESET}) SLAVE   – only drives a carousel and follows the master (Pi Zero 2 W)" > /dev/tty
  case "$(ask "Choose" "1")" in
    1|m|master|M) ROLE=master ;;
    2|s|slave|S)  ROLE=slave ;;
    *) die "answer 1 or 2" ;;
  esac
fi
[[ "$ROLE" == "master" || "$ROLE" == "slave" ]] || die "--role must be master or slave"

if [[ "$ROLE" == "slave" && "$MODEL" == *"Zero"* && -z "$SHELVES" ]]; then :; fi
if [[ "$ROLE" == "master" && "$MODEL" == *"Zero"* ]]; then
  warn "a Pi Zero cannot build or comfortably serve the web app; a master should be a Pi 4/5"
fi

# --------------------------------------------------------------------------
# Question 2/3: shelves, and for a slave its number + master hotspot password
# --------------------------------------------------------------------------
SHELVES="${SHELVES:-$(ask "How many shelves does this carousel have?" "9")}"
[[ "$SHELVES" =~ ^[0-9]+$ && "$SHELVES" -ge 2 ]] || die "shelves must be a number (2 or more)"

if [[ "$ROLE" == "master" ]]; then
  HOSTNAME_NEW="pax-master"
  UNIT_NAME="Paternoster 1"
else
  NUMBER="${NUMBER:-$(ask "Which slave is this? (1 for the first, 2 for the second …)" "1")}"
  [[ "$NUMBER" =~ ^[0-9]+$ ]] || die "slave number must be a number"
  HOSTNAME_NEW="pax-slave-$NUMBER"
  UNIT_NAME="Paternoster $((NUMBER + 1))"
  MASTER_HOST="${MASTER_HOST:-$(ask "Master hostname" "pax-master.local")}"
  if [[ -z "$AP_PSK" && $ASSUME_YES -eq 0 ]]; then
    printf '%s\n' "${DIM}The master printed a hotspot password when it was installed. Enter it so this slave" > /dev/tty
    printf '%s\n' "can always find the master, or press Enter to skip if both Pis are on the same Wi-Fi now.${RESET}" > /dev/tty
    AP_PSK="$(ask_secret "Master hotspot password (optional)")"
  fi
  if [[ -n "$AP_PSK" && -z "$AP_SSID" ]]; then
    AP_SSID="$(ask "Master hotspot name" "PAX-Setup")"
  fi
fi

printf '\n'
say "Installing as ${BOLD}$ROLE${RESET}: $UNIT_NAME, $SHELVES shelves, hostname $HOSTNAME_NEW.local"
printf '\n'

# --------------------------------------------------------------------------
# Get the code
# --------------------------------------------------------------------------
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || true)"
if [[ -n "$SELF_DIR" && -f "$SELF_DIR/pi-agent/install.sh" && -f "$SELF_DIR/package.json" ]]; then
  APP_DIR="$SELF_DIR"
  say "Using this checkout: $APP_DIR"
else
  APP_DIR="$RUN_HOME/pax"
  if [[ "$PAX_REPO" == *"YOUR-USERNAME"* ]]; then
    PAX_REPO="$(ask "Git URL of the PAX repository (https://github.com/…/….git)")"
    [[ -n "$PAX_REPO" ]] || die "need the repository URL (or edit PAX_REPO at the top of setup.sh)"
  fi
  say "Installing git"
  apt-get update -qq
  apt-get install -y -qq git >/dev/null
  if [[ -d "$APP_DIR/.git" ]]; then
    say "Updating $APP_DIR"
    sudo -u "$RUN_USER" git -C "$APP_DIR" fetch -q origin "$PAX_BRANCH"
    sudo -u "$RUN_USER" git -C "$APP_DIR" reset -q --hard "origin/$PAX_BRANCH"
  else
    say "Downloading to $APP_DIR"
    sudo -u "$RUN_USER" git clone -q --depth 1 -b "$PAX_BRANCH" "$PAX_REPO" "$APP_DIR"
  fi
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

# --------------------------------------------------------------------------
# Master only: the web app
# --------------------------------------------------------------------------
if [[ "$ROLE" == "master" ]]; then
  say "Installing build tools"
  apt-get update -qq
  apt-get install -y -qq build-essential python3 ca-certificates curl >/dev/null

  # Node 22 LTS from NodeSource; the Debian package is too old for Next 16.
  NEED_NODE=1
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [[ "$NODE_MAJOR" -ge 20 ]] && NEED_NODE=0
  fi
  if [[ $NEED_NODE -eq 1 ]]; then
    say "Installing Node.js 22"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
  note "node $(node -v)"
  if ! command -v pnpm >/dev/null 2>&1; then
    say "Installing pnpm"
    npm install -g pnpm >/dev/null 2>&1
  fi

  # `next build` peaks at ~1.5 GB. On a 2 GB Pi that only survives with swap.
  if [[ $MEM_MB -lt 3000 ]]; then
    SWAP_MB=$(( $(awk '/SwapTotal/{print $2}' /proc/meminfo) / 1024 ))
    if [[ $SWAP_MB -lt 2000 ]] && command -v dphys-swapfile >/dev/null 2>&1; then
      say "Enlarging swap to 2 GB so the build fits (${MEM_MB} MB RAM, ${SWAP_MB} MB swap)"
      dphys-swapfile swapoff >/dev/null 2>&1 || true
      sed -i 's/^#\?CONF_SWAPSIZE=.*/CONF_SWAPSIZE=2048/' /etc/dphys-swapfile
      dphys-swapfile setup >/dev/null && dphys-swapfile swapon
    fi
  fi

  # Stop a running app before the build: it holds ~120 MB we need.
  systemctl stop pax-app >/dev/null 2>&1 || true

  say "Installing app dependencies (compiles the SQLite module — a few minutes on a Pi)"
  sudo -u "$RUN_USER" -H bash -c "cd '$APP_DIR' && pnpm install --frozen-lockfile --prod=false 2>&1 | tail -n 3"

  # Skip the expensive build when a build copied over from a PC is present and
  # newer than the source (README §4b).
  if [[ -d "$APP_DIR/.next/server" && -f "$APP_DIR/.next/BUILD_ID" ]] \
     && [[ -z "$(find "$APP_DIR/app" "$APP_DIR/components" "$APP_DIR/lib" -newer "$APP_DIR/.next/BUILD_ID" -name '*.ts*' -print -quit 2>/dev/null)" ]]; then
    say "Using the existing build in .next (newer than the source)"
  else
    say "Building the web app (this is the slow part; 5–15 minutes on a Pi 4)"
    sudo -u "$RUN_USER" -H bash -c "cd '$APP_DIR' && pnpm build:pi 2>&1 | tail -n 5" \
      || die "build failed. On a 2 GB Pi build on a PC and copy .next over (README §4b), then re-run setup.sh"
  fi

  # Data lives outside the checkout so updates and re-clones never touch it.
  mkdir -p "$DATA_DIR"
  if [[ -f "$APP_DIR/paternoster.db" && ! -f "$DATA_DIR/paternoster.db" ]]; then
    say "Moving existing paternoster.db to $DATA_DIR"
    mv "$APP_DIR/paternoster.db" "$DATA_DIR/paternoster.db"
  fi
  chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"

  say "Installing the web app service (port $APP_PORT)"
  cat > /etc/systemd/system/pax-app.service <<EOF
[Unit]
Description=PAX Paternoster web app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$APP_PORT
Environment=PATERNOSTER_DB_PATH=$DATA_DIR/paternoster.db
ExecStart=$(command -v pnpm) start
Restart=always
RestartSec=3
# Lets a normal user bind port 80 so the address is just http://pax-master.local
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable pax-app >/dev/null 2>&1
  systemctl restart pax-app
fi

# --------------------------------------------------------------------------
# Both: the carousel agent + networking (delegates to pi-agent/install.sh)
# --------------------------------------------------------------------------
say "Installing the carousel agent and network manager"
AGENT_ARGS=(--role "$ROLE" --hostname "$HOSTNAME_NEW" --name "$UNIT_NAME" --shelves "$SHELVES" --port "$AGENT_PORT")
if [[ "$ROLE" == "slave" ]]; then
  AGENT_ARGS+=(--master "$MASTER_HOST")
  [[ -n "$AP_SSID" ]] && AGENT_ARGS+=(--ap-ssid "$AP_SSID")
  [[ -n "$AP_PSK" ]] && AGENT_ARGS+=(--ap-psk "$AP_PSK")
fi
chmod +x "$APP_DIR/pi-agent/install.sh"
# install.sh prints its own networking summary (including the hotspot password).
SUDO_USER="$RUN_USER" "$APP_DIR/pi-agent/install.sh" "${AGENT_ARGS[@]}" | grep -vE '^\[install\] (installing|detected|added|wrote|sudoers|hotspot profile|fallback profile|adopted|service is running|verify GPIO|           journalctl)' || die "agent installation failed"

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------
printf '\n'
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ "$ROLE" == "master" ]]; then
  sleep 2
  if systemctl is-active --quiet pax-app; then
    URL="http://$HOSTNAME_NEW.local"; [[ "$APP_PORT" != "80" ]] && URL="$URL:$APP_PORT"
    printf '%s\n' "${GREEN}${BOLD}Done.${RESET} Open the app from any device on the same Wi-Fi:"
    printf '\n    %s\n' "${BOLD}$URL${RESET}"
    [[ -n "$IP" ]] && printf '    %s\n' "${DIM}or http://$IP${APP_PORT/#80/}${RESET}"
    printf '\n%s\n' "In the app, under Settings → Storage units, set the master paternoster's address to"
    printf '%s\n' "${BOLD}127.0.0.1${RESET} (this Pi drives its own carousel), then link slaves as ${BOLD}pax-slave-1.local${RESET}, …"
    printf '\n%s\n' "Write down the hotspot password printed above. If the Wi-Fi ever disappears, this Pi"
    printf '%s\n' "opens that hotspot and the app is at ${BOLD}http://10.42.0.1${RESET}."
    printf '\n%s\n' "${DIM}Install a slave: run this same command on it and answer 2.${RESET}"
  else
    warn "the web app did not start. Log:"
    journalctl -u pax-app -n 20 --no-pager >&2
    exit 1
  fi
else
  printf '%s\n' "${GREEN}${BOLD}Done.${RESET} This slave is now following ${BOLD}$MASTER_HOST${RESET}."
  printf '%s\n' "It appears under Settings → Network → Slave units on the master within a minute."
  printf '%s\n' "Link it in the app as ${BOLD}$HOSTNAME_NEW.local${RESET} (port $AGENT_PORT)."
fi
printf '\n%s\n' "${DIM}Update later with the same command. Logs: journalctl -u paternoster-agent -f${RESET}"
