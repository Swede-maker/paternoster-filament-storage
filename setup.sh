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
# It asks what this Pi should be, then does everything:
#
#   1  FILAMENT ONLY   web app only — spools, shelves, printers. No motors, no GPIO.
#   2  MASTER          web app + drives ONE carousel from this Pi + hotspot fallback
#                      + provisions slaves. This Pi is the host for the whole system.
#   3  SLAVE           drives one carousel and follows the master (Pi Zero 2 W)
#
# For 2 and 3 it also asks which motors are wired up (integrated servos or DC
# motors) and how many shelves the carousel has.
#
# The answers are remembered in /etc/pax-install.conf. Running the same command
# again on an installed Pi does NOT start over: it shows what is installed and
# offers to update it, add carousel control to a filament-only install, change
# the motor type, or reconfigure. Your data is never touched by any of these:
#
#   /var/lib/pax/paternoster.db     spools, shelves, storage units, printers, history
#   /var/lib/pax-agent/motor.json   motor tuning (pulses/rev, speeds, hold timeout)
#   /etc/paxnet.conf                hotspot name + password
#
# A timestamped copy of paternoster.db is made in /var/lib/pax/backups before
# every update (the five newest are kept).
#
# Non-interactive use (for scripting / re-imaging):
#   sudo ./setup.sh --role app
#   sudo ./setup.sh --role master --motor servo --shelves 9
#   sudo ./setup.sh --role slave  --motor dc --number 1 --shelves 9 --master pax-master.local --ap-psk <pw>
#   sudo ./setup.sh -y            # re-run with the saved answers (update only)
#
set -euo pipefail

# --------------------------------------------------------------------------
# Edit this ONE line when you publish the project. Everything else derives.
# --------------------------------------------------------------------------
PAX_REPO="${PAX_REPO:-https://github.com/Swede-maker/paternoster-filament-storage.git}"
PAX_BRANCH="${PAX_BRANCH:-main}"

APP_PORT="${APP_PORT:-80}"
AGENT_PORT=8765
DATA_DIR=/var/lib/pax
STATE_FILE=/etc/pax-install.conf
MOTOR_CONF=/var/lib/pax-agent/motor.json

ROLE=""
MOTOR=""
SHELVES=""
NUMBER=""
MASTER_HOST=""
AP_PSK=""
AP_SSID=""
ASSUME_YES=0
RECONFIGURE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --motor) MOTOR="$2"; shift 2 ;;
    --shelves) SHELVES="$2"; shift 2 ;;
    --number) NUMBER="$2"; shift 2 ;;
    --master) MASTER_HOST="$2"; shift 2 ;;
    --ap-ssid) AP_SSID="$2"; shift 2 ;;
    --ap-psk) AP_PSK="$2"; shift 2 ;;
    --repo) PAX_REPO="$2"; shift 2 ;;
    --branch) PAX_BRANCH="$2"; shift 2 ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,39p' "$0"; exit 0 ;;
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
tty_say() { printf '%s\n' "$*" > /dev/tty; }

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

role_label() {
  case "$1" in
    app) printf 'FILAMENT ONLY (web app, no motors)' ;;
    master) printf 'MASTER (web app + this carousel + hotspot fallback)' ;;
    slave) printf 'SLAVE (carousel only, follows the master)' ;;
    *) printf '%s' "$1" ;;
  esac
}
motor_label() {
  case "$1" in
    servo) printf 'integrated servos (PUL/DIR)' ;;
    dc) printf 'DC motors (H-bridge)' ;;
    *) printf 'not set' ;;
  esac
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
# What is already here? (saved answers from a previous run)
# --------------------------------------------------------------------------
OLD_ROLE=""; OLD_MOTOR=""; OLD_SHELVES=""; OLD_NUMBER=""; OLD_MASTER=""; OLD_APP_DIR=""; OLD_HOSTNAME=""
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  OLD_ROLE="$(awk -F= '$1=="role"{print $2}' "$STATE_FILE")"
  OLD_MOTOR="$(awk -F= '$1=="motor"{print $2}' "$STATE_FILE")"
  OLD_SHELVES="$(awk -F= '$1=="shelves"{print $2}' "$STATE_FILE")"
  OLD_NUMBER="$(awk -F= '$1=="number"{print $2}' "$STATE_FILE")"
  OLD_MASTER="$(awk -F= '$1=="master_host"{print $2}' "$STATE_FILE")"
  OLD_APP_DIR="$(awk -F= '$1=="app_dir"{print $2}' "$STATE_FILE")"
  OLD_HOSTNAME="$(awk -F= '$1=="hostname"{print $2}' "$STATE_FILE")"
fi
# Older installs (before the state file existed) can still be recognised by
# their services. Treat them as master/slave so we do not ask from scratch.
if [[ -z "$OLD_ROLE" ]]; then
  if systemctl list-unit-files 2>/dev/null | grep -q '^pax-app.service'; then
    if systemctl list-unit-files 2>/dev/null | grep -q '^paternoster-agent.service'; then OLD_ROLE=master; else OLD_ROLE=app; fi
  elif systemctl list-unit-files 2>/dev/null | grep -q '^paternoster-agent.service'; then
    OLD_ROLE=slave
  fi
  if [[ -n "$OLD_ROLE" && -f "$MOTOR_CONF" ]]; then
    OLD_MOTOR="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mode",""))' "$MOTOR_CONF" 2>/dev/null || true)"
  fi
fi

# What the user is doing this run. "update" = same setup, no questions.
ACTION="install"
if [[ -n "$OLD_ROLE" && $RECONFIGURE -eq 0 && -z "$ROLE" ]]; then
  tty_say "${GREEN}PAX is already installed on this Pi.${RESET}"
  tty_say "    setup   : $(role_label "$OLD_ROLE")"
  [[ "$OLD_ROLE" != "app" ]] && tty_say "    motors  : $(motor_label "$OLD_MOTOR")${OLD_SHELVES:+, $OLD_SHELVES shelves}"
  [[ -f "$DATA_DIR/paternoster.db" ]] && tty_say "    data    : $DATA_DIR/paternoster.db ($(du -h "$DATA_DIR/paternoster.db" | cut -f1)) — will be kept"
  tty_say ""
  tty_say "What do you want to do?"
  tty_say "  ${BOLD}1${RESET}) Update to the latest version, keep this setup"
  case "$OLD_ROLE" in
    app)
      tty_say "  ${BOLD}2${RESET}) Add carousel control: make this Pi the MASTER that drives a paternoster"
      ;;
    master|slave)
      tty_say "  ${BOLD}2${RESET}) Change the motor type (currently $(motor_label "$OLD_MOTOR"))"
      ;;
  esac
  tty_say "  ${BOLD}3${RESET}) Reconfigure from the start (asks every question again; data is still kept)"
  case "$(ask "Choose" "1")" in
    1) ACTION="update" ;;
    2) if [[ "$OLD_ROLE" == "app" ]]; then ACTION="add-hardware"; else ACTION="change-motor"; fi ;;
    3) ACTION="reconfigure" ;;
    *) die "answer 1, 2 or 3" ;;
  esac
  printf '\n'
elif [[ -n "$OLD_ROLE" && $RECONFIGURE -eq 1 ]]; then
  ACTION="reconfigure"
elif [[ -n "$OLD_ROLE" && -n "$ROLE" ]]; then
  ACTION="reconfigure"   # flags given explicitly: honour them, fill gaps from saved answers
fi

case "$ACTION" in
  update)
    ROLE="$OLD_ROLE"; MOTOR="${MOTOR:-$OLD_MOTOR}"; SHELVES="${SHELVES:-$OLD_SHELVES}"
    NUMBER="${NUMBER:-$OLD_NUMBER}"; MASTER_HOST="${MASTER_HOST:-$OLD_MASTER}"
    ;;
  add-hardware)
    ROLE="master"
    ;;
  change-motor)
    ROLE="$OLD_ROLE"; SHELVES="${SHELVES:-$OLD_SHELVES}"; NUMBER="${NUMBER:-$OLD_NUMBER}"; MASTER_HOST="${MASTER_HOST:-$OLD_MASTER}"
    MOTOR=""   # force the question
    ;;
  reconfigure)
    # Saved answers become defaults, not silent choices.
    ;;
esac

# --------------------------------------------------------------------------
# Question 1: what is this Pi?
# --------------------------------------------------------------------------
if [[ -z "$ROLE" ]]; then
  tty_say "What should this Raspberry Pi do?"
  tty_say "  ${BOLD}1${RESET}) FILAMENT ONLY – the web app for spools, shelves and printers. No motors, no wiring."
  tty_say "  ${BOLD}2${RESET}) MASTER        – the web app ${BOLD}and${RESET} it drives one paternoster carousel itself. This Pi"
  tty_say "                     is the host for the whole system (hotspot fallback, provisions slaves)."
  tty_say "  ${BOLD}3${RESET}) SLAVE         – drives one carousel and follows the master (Pi Zero 2 W is enough)."
  DEFAULT_CHOICE=1
  case "$OLD_ROLE" in master) DEFAULT_CHOICE=2 ;; slave) DEFAULT_CHOICE=3 ;; esac
  case "$(ask "Choose" "$DEFAULT_CHOICE")" in
    1|a|app|f|filament) ROLE=app ;;
    2|m|master|M)       ROLE=master ;;
    3|s|slave|S)        ROLE=slave ;;
    *) die "answer 1, 2 or 3" ;;
  esac
fi
[[ "$ROLE" == "app" || "$ROLE" == "master" || "$ROLE" == "slave" ]] || die "--role must be app, master or slave"

if [[ "$ROLE" != "slave" && "$MODEL" == *"Zero"* ]]; then
  warn "a Pi Zero cannot build or comfortably serve the web app; the web app belongs on a Pi 4/5"
fi

HAS_APP=0; HAS_AGENT=0
[[ "$ROLE" == "app" || "$ROLE" == "master" ]] && HAS_APP=1
[[ "$ROLE" == "master" || "$ROLE" == "slave" ]] && HAS_AGENT=1

# --------------------------------------------------------------------------
# Question 2: motors (carousel roles only)
# --------------------------------------------------------------------------
if [[ $HAS_AGENT -eq 1 && -z "$MOTOR" ]]; then
  tty_say ""
  tty_say "Which motors turn this carousel?"
  tty_say "  ${BOLD}1${RESET}) Integrated servos – iSV57T or similar, PUL/DIR step pulses, holds position, ALM feedback"
  tty_say "  ${BOLD}2${RESET}) DC motors         – brushed motors on an H-bridge (L298N / BTS7960), PWM speed"
  DEFAULT_MOTOR=1
  [[ "$OLD_MOTOR" == "dc" ]] && DEFAULT_MOTOR=2
  case "$(ask "Choose" "$DEFAULT_MOTOR")" in
    1|s|servo|servos) MOTOR=servo ;;
    2|d|dc|DC)        MOTOR=dc ;;
    *) die "answer 1 or 2" ;;
  esac
fi
if [[ $HAS_AGENT -eq 1 ]]; then
  [[ "$MOTOR" == "servo" || "$MOTOR" == "dc" ]] || die "--motor must be servo or dc"
fi

# --------------------------------------------------------------------------
# Question 3: shelves, and for a slave its number + master hotspot password
# --------------------------------------------------------------------------
if [[ $HAS_AGENT -eq 1 ]]; then
  SHELVES="${SHELVES:-$(ask "How many shelves does this carousel have?" "${OLD_SHELVES:-9}")}"
  [[ "$SHELVES" =~ ^[0-9]+$ && "$SHELVES" -ge 2 ]] || die "shelves must be a number (2 or more)"
fi

CUR_HOST="$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo raspberrypi)"
if [[ "$ROLE" == "app" ]]; then
  HOSTNAME_NEW="${OLD_HOSTNAME:-pax}"
  [[ "$CUR_HOST" != "raspberrypi" && -n "$CUR_HOST" ]] && HOSTNAME_NEW="$CUR_HOST"
  UNIT_NAME=""
elif [[ "$ROLE" == "master" ]]; then
  HOSTNAME_NEW="pax-master"
  # A filament-only Pi being upgraded already has an address people use;
  # keep it unless they want the standard one.
  if [[ "$ACTION" == "add-hardware" && "$CUR_HOST" != "raspberrypi" && "$CUR_HOST" != "pax-master" ]]; then
    HOSTNAME_NEW="$(ask "Hostname for this master (slaves will look for it)" "$CUR_HOST")"
  fi
  UNIT_NAME="Paternoster 1"
else
  NUMBER="${NUMBER:-$(ask "Which slave is this? (1 for the first, 2 for the second …)" "${OLD_NUMBER:-1}")}"
  [[ "$NUMBER" =~ ^[0-9]+$ ]] || die "slave number must be a number"
  HOSTNAME_NEW="pax-slave-$NUMBER"
  UNIT_NAME="Paternoster $((NUMBER + 1))"
  MASTER_HOST="${MASTER_HOST:-$(ask "Master hostname" "${OLD_MASTER:-pax-master.local}")}"
  if [[ -z "$AP_PSK" && $ASSUME_YES -eq 0 && "$ACTION" != "update" && "$ACTION" != "change-motor" ]]; then
    tty_say "${DIM}The master printed a hotspot password when it was installed. Enter it so this slave"
    tty_say "can always find the master, or press Enter to skip if both Pis are on the same Wi-Fi now.${RESET}"
    AP_PSK="$(ask_secret "Master hotspot password (optional)")"
  fi
  if [[ -n "$AP_PSK" && -z "$AP_SSID" ]]; then
    AP_SSID="$(ask "Master hotspot name" "PAX-Setup")"
  fi
fi

printf '\n'
SUMMARY="$(role_label "$ROLE")"
[[ $HAS_AGENT -eq 1 ]] && SUMMARY="$SUMMARY — $(motor_label "$MOTOR"), $SHELVES shelves"
say "Installing: ${BOLD}$SUMMARY${RESET}"
note "hostname $HOSTNAME_NEW.local"
[[ "$ACTION" == "add-hardware" ]] && note "your existing filament data stays exactly as it is"
printf '\n'

# --------------------------------------------------------------------------
# Get the code
# --------------------------------------------------------------------------
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || true)"
if [[ -n "$SELF_DIR" && -f "$SELF_DIR/pi-agent/install.sh" && -f "$SELF_DIR/package.json" ]]; then
  APP_DIR="$SELF_DIR"
  say "Using this checkout: $APP_DIR"
else
  APP_DIR="${OLD_APP_DIR:-$RUN_HOME/pax}"
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
# Data: keep it, back it up
# --------------------------------------------------------------------------
# Data lives outside the checkout so updates and re-clones never touch it.
mkdir -p "$DATA_DIR"
if [[ -f "$APP_DIR/paternoster.db" && ! -f "$DATA_DIR/paternoster.db" ]]; then
  say "Moving existing paternoster.db to $DATA_DIR"
  mv "$APP_DIR/paternoster.db" "$DATA_DIR/paternoster.db"
  for side in -wal -shm; do
    [[ -f "$APP_DIR/paternoster.db$side" ]] && mv "$APP_DIR/paternoster.db$side" "$DATA_DIR/paternoster.db$side"
  done
fi
if [[ -f "$DATA_DIR/paternoster.db" ]]; then
  # Stop the app first so the copy is consistent, then snapshot.
  systemctl stop pax-app >/dev/null 2>&1 || true
  mkdir -p "$DATA_DIR/backups"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  cp -p "$DATA_DIR/paternoster.db" "$DATA_DIR/backups/paternoster-$STAMP.db"
  [[ -f "$DATA_DIR/paternoster.db-wal" ]] && cp -p "$DATA_DIR/paternoster.db-wal" "$DATA_DIR/backups/paternoster-$STAMP.db-wal"
  ls -1t "$DATA_DIR/backups"/paternoster-*.db 2>/dev/null | tail -n +6 | while read -r old; do rm -f "$old" "$old-wal"; done
  say "Backed up your data to $DATA_DIR/backups/paternoster-$STAMP.db"
fi
chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"

# --------------------------------------------------------------------------
# Web app (filament-only and master)
# --------------------------------------------------------------------------
if [[ $HAS_APP -eq 1 ]]; then
  say "Installing build tools"
  apt-get update -qq
  apt-get install -y -qq build-essential python3 ca-certificates curl avahi-daemon >/dev/null
  systemctl enable --now avahi-daemon >/dev/null 2>&1 || true

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
Environment=PAX_DATA_DIR=$DATA_DIR
Environment=PAX_BRANCH=$PAX_BRANCH
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

  # ---- Update from Settings -------------------------------------------------
  # The app runs unprivileged (NoNewPrivileges), so it cannot run this script
  # itself. Instead it drops a request file in DATA_DIR; a systemd path unit
  # sees it and starts pax-update.service as root, which pulls the newest
  # code and re-runs this installer non-interactively. Progress goes to
  # DATA_DIR/update.log, which the app tails for the user.
  say "Installing the in-app updater"
  cat > /usr/local/sbin/pax-update <<EOF
#!/usr/bin/env bash
# Started by pax-update.path when the app writes $DATA_DIR/update.request.
set -uo pipefail
DATA_DIR="$DATA_DIR"
APP_DIR="$APP_DIR"
RUN_USER="$RUN_USER"
BRANCH="\${PAX_BRANCH:-$PAX_BRANCH}"
LOG="\$DATA_DIR/update.log"
RESULT="\$DATA_DIR/update.result"
rm -f "\$DATA_DIR/update.request" "\$RESULT"
: > "\$LOG"
chown "\$RUN_USER:\$RUN_USER" "\$LOG"
exec >>"\$LOG" 2>&1
echo "==> Update started \$(date -Iseconds)"
finish() {
  local code=\$1
  if [[ \$code -eq 0 ]]; then echo "==> Update finished \$(date -Iseconds)"; echo "ok \$(date -Iseconds)" > "\$RESULT"
  else echo "==> Update FAILED (exit \$code) \$(date -Iseconds)"; echo "failed \$code \$(date -Iseconds)" > "\$RESULT"; fi
  chown "\$RUN_USER:\$RUN_USER" "\$RESULT"
  # The installer stops the app while building; make sure it is back either way.
  systemctl start pax-app >/dev/null 2>&1 || true
}
echo "==> Fetching origin/\$BRANCH"
sudo -u "\$RUN_USER" git -C "\$APP_DIR" fetch -q origin "\$BRANCH" || { finish 10; exit 0; }
sudo -u "\$RUN_USER" git -C "\$APP_DIR" reset -q --hard "origin/\$BRANCH" || { finish 11; exit 0; }
echo "    now at \$(sudo -u "\$RUN_USER" git -C "\$APP_DIR" log -1 --format='%h %s')"
# Run the freshly pulled installer with the saved answers (no questions).
PAX_BRANCH="\$BRANCH" bash "\$APP_DIR/setup.sh" -y
finish \$?
EOF
  chmod 755 /usr/local/sbin/pax-update

  cat > /etc/systemd/system/pax-update.service <<EOF
[Unit]
Description=PAX update requested from the web app
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/pax-update
TimeoutStartSec=3600
EOF

  cat > /etc/systemd/system/pax-update.path <<EOF
[Unit]
Description=Watch for a PAX update request from the web app

[Path]
PathExists=$DATA_DIR/update.request
Unit=pax-update.service

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now pax-update.path >/dev/null 2>&1
fi

# --------------------------------------------------------------------------
# Filament-only: a friendly .local name, nothing else touches the system
# --------------------------------------------------------------------------
if [[ "$ROLE" == "app" ]]; then
  if [[ "$HOSTNAME_NEW" != "$CUR_HOST" ]]; then
    say "Hostname → $HOSTNAME_NEW ($HOSTNAME_NEW.local)"
    hostnamectl set-hostname "$HOSTNAME_NEW"
    if grep -qE '^127\.0\.1\.1\s' /etc/hosts; then
      sed -i -E "s/^127\.0\.1\.1\s.*/127.0.1.1\t$HOSTNAME_NEW/" /etc/hosts
    else
      printf '127.0.1.1\t%s\n' "$HOSTNAME_NEW" >> /etc/hosts
    fi
  fi
  # A previous master/slave install being downgraded: stop driving motors.
  if systemctl list-unit-files 2>/dev/null | grep -q '^paternoster-agent.service'; then
    say "Disabling the carousel agent (filament-only setup)"
    systemctl disable --now paternoster-agent >/dev/null 2>&1 || true
  fi
fi

# --------------------------------------------------------------------------
# Carousel agent + networking (master and slave; delegates to pi-agent/install.sh)
# --------------------------------------------------------------------------
if [[ $HAS_AGENT -eq 1 ]]; then
  say "Installing the carousel agent ($(motor_label "$MOTOR")) and network manager"
  AGENT_ARGS=(--role "$ROLE" --hostname "$HOSTNAME_NEW" --name "$UNIT_NAME" --shelves "$SHELVES" --port "$AGENT_PORT" --motor "$MOTOR")
  if [[ "$ROLE" == "slave" ]]; then
    AGENT_ARGS+=(--master "$MASTER_HOST")
    [[ -n "$AP_SSID" ]] && AGENT_ARGS+=(--ap-ssid "$AP_SSID")
    [[ -n "$AP_PSK" ]] && AGENT_ARGS+=(--ap-psk "$AP_PSK")
  fi
  chmod +x "$APP_DIR/pi-agent/install.sh"
  # install.sh prints its own networking summary (including the hotspot password).
  SUDO_USER="$RUN_USER" "$APP_DIR/pi-agent/install.sh" "${AGENT_ARGS[@]}" | grep -vE '^\[install\] (installing|detected|added|wrote|sudoers|hotspot profile|fallback profile|adopted|service is running|verify GPIO|motor drive|           journalctl)' || die "agent installation failed"
fi

# --------------------------------------------------------------------------
# Remember the answers for next time
# --------------------------------------------------------------------------
cat > "$STATE_FILE" <<EOF
# Written by PAX setup.sh — re-running the installer reads this to offer an update.
role=$ROLE
motor=$MOTOR
shelves=$SHELVES
number=$NUMBER
master_host=$MASTER_HOST
hostname=$HOSTNAME_NEW
app_dir=$APP_DIR
branch=$PAX_BRANCH
installed_at=$(date -Iseconds)
EOF
chmod 644 "$STATE_FILE"

# --------------------------------------------------------------------------
# Done
# --------------------------------------------------------------------------
printf '\n'
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ $HAS_APP -eq 1 ]]; then
  sleep 2
  if systemctl is-active --quiet pax-app; then
    URL="http://$HOSTNAME_NEW.local"; [[ "$APP_PORT" != "80" ]] && URL="$URL:$APP_PORT"
    printf '%s\n' "${GREEN}${BOLD}Done.${RESET} Open the app from any device on the same Wi-Fi:"
    printf '\n    %s\n' "${BOLD}$URL${RESET}"
    [[ -n "$IP" ]] && printf '    %s\n' "${DIM}or http://$IP${APP_PORT/#80/}${RESET}"
    if [[ "$ROLE" == "master" ]]; then
      printf '\n%s\n' "In the app, under Settings → Storage units, set the master paternoster's address to"
      printf '%s\n' "${BOLD}127.0.0.1${RESET} (this Pi drives its own carousel) and pick ${BOLD}$(motor_label "$MOTOR")${RESET}"
      printf '%s\n' "under Motor drive. Link slaves as ${BOLD}pax-slave-1.local${RESET}, …"
      printf '\n%s\n' "Write down the hotspot password printed above. If the Wi-Fi ever disappears, this Pi"
      printf '%s\n' "opens that hotspot and the app is at ${BOLD}http://10.42.0.1${RESET}."
      printf '\n%s\n' "${DIM}Install a slave: run this same command on it and answer 3.${RESET}"
    else
      printf '\n%s\n' "This Pi only runs the filament manager — no motors are driven from here."
      printf '%s\n' "${DIM}Want it to control a paternoster later? Run this same command again and choose"
      printf '%s\n' "\"Add carousel control\". Everything you have entered is kept.${RESET}"
    fi
  else
    warn "the web app did not start. Log:"
    journalctl -u pax-app -n 20 --no-pager >&2
    exit 1
  fi
else
  printf '%s\n' "${GREEN}${BOLD}Done.${RESET} This slave ($(motor_label "$MOTOR")) is now following ${BOLD}$MASTER_HOST${RESET}."
  printf '%s\n' "It appears under Settings → Network → Slave units on the master within a minute."
  printf '%s\n' "Link it in the app as ${BOLD}$HOSTNAME_NEW.local${RESET} (port $AGENT_PORT) and pick"
  printf '%s\n' "${BOLD}$(motor_label "$MOTOR")${RESET} under Motor drive for that unit."
fi
printf '\n%s\n' "${DIM}Update later with the same command — it recognises this install. Logs: journalctl -u pax-app -f  /  journalctl -u paternoster-agent -f${RESET}"
