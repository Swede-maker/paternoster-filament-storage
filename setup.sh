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
#   1  MASTER          the host for the whole system: web app, database, slave
#                      sign-in and Wi-Fi provisioning. There is only ever ONE.
#                      It then asks: a PC or a Raspberry Pi?
#        a  PC           SERVER: no carousel, no GPIO, no hotspot; this
#                        computer's own network is left alone. Every carousel
#                        is installed as a SLAVE.
#        b  Pi           then: is a carousel wired to this Pi?
#             no         PI SERVER: no carousel, no GPIO, but opens the
#                        PAX-Setup hotspot if the router disappears.
#             yes        + CAROUSEL: also drives one carousel, with hotspot.
#   2  SLAVE           drives one carousel and follows the master (Pi Zero 2 W)
#
# (Older "filament only" installs keep working and can be upgraded to a
# SERVER master in place; --role app still installs one for scripting.)
#
# For carousels it also asks which motors are wired up (integrated servos,
# closed-loop steppers, AC servos or DC motors) and how many shelves the
# carousel has. Closed-loop steppers and AC servos are pulsed by an ESP32
# (pi-agent/esp32-servo), so for those it also asks how the ESP32 is connected.
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
#   sudo ./setup.sh --role server
#   sudo ./setup.sh --role pi-server
#   sudo ./setup.sh --role master --motor servo --shelves 9
#   sudo ./setup.sh --role master --pulse-drive closed-loop-stepper --esp32-link usb --shelves 9
#   sudo ./setup.sh --role slave  --motor dc --number 1 --shelves 9 --master pax-master.local --ap-psk <pw>
#
#   --pulse-drive integrated-servo|closed-loop-stepper|ac-servo   (implies --motor servo)
#   --servo-driver gpio|esp32       who makes the pulses (default: gpio for
#                                   integrated servos, esp32 for the others)
#   --esp32-link usb|uart|wifi      how the ESP32 reaches this Pi
#   --esp32-host <host[:port]>      the ESP32's address when --esp32-link wifi
#   sudo ./setup.sh -y            # re-run with the saved answers (update only)
#
# One-line update over SSH (never asks anything, never installs from scratch):
#   curl -fsSL https://raw.githubusercontent.com/OWNER/REPO/main/setup.sh | sudo bash -s -- --update
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
PULSE_DRIVE=""
SERVO_DRIVER=""
ESP32_LINK=""
ESP32_HOST=""
SHELVES=""
NUMBER=""
MASTER_HOST=""
AP_PSK=""
AP_SSID=""
ASSUME_YES=0
RECONFIGURE=0
UPDATE_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --motor) MOTOR="$2"; shift 2 ;;
    --pulse-drive) PULSE_DRIVE="$2"; shift 2 ;;
    --servo-driver) SERVO_DRIVER="$2"; shift 2 ;;
    --esp32-link) ESP32_LINK="$2"; shift 2 ;;
    --esp32-host) ESP32_HOST="$2"; shift 2 ;;
    --shelves) SHELVES="$2"; shift 2 ;;
    --number) NUMBER="$2"; shift 2 ;;
    --master) MASTER_HOST="$2"; shift 2 ;;
    --ap-ssid) AP_SSID="$2"; shift 2 ;;
    --ap-psk) AP_PSK="$2"; shift 2 ;;
    --repo) PAX_REPO="$2"; shift 2 ;;
    --branch) PAX_BRANCH="$2"; shift 2 ;;
    --reconfigure) RECONFIGURE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --update) UPDATE_ONLY=1; ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,58p' "$0"; exit 0 ;;
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

# Any unexpected failure under `set -e` used to drop straight back to the
# prompt with no message. Say where it stopped instead.
on_error() {
  local code=$? line=$1 cmd=$2
  printf '\n%s\n' "${RED}error:${RESET} the installer stopped at line ${line} (exit ${code}):" >&2
  printf '%s\n' "    ${DIM}${cmd}${RESET}" >&2
  printf '%s\n' "Nothing is half-removed: your data and backups are untouched. Fix the cause and run the same command again." >&2
  exit "$code"
}
trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

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
    server) printf 'MASTER – SERVER (web app + slave sign-in, no carousel)' ;;
    pi-server) printf 'MASTER – PI SERVER (web app + slave sign-in + hotspot, no carousel)' ;;
    master) printf 'MASTER + CAROUSEL (web app + this carousel + hotspot fallback)' ;;
    slave) printf 'SLAVE (carousel only, follows the master)' ;;
    *) printf '%s' "$1" ;;
  esac
}
# motor_label <mode> [pulse drive] [servo driver] [esp32 link]
motor_label() {
  local via=""
  [[ "${3:-}" == "esp32" ]] && via=" via ESP32 (${4:-usb})"
  case "$1" in
    servo)
      case "${2:-}" in
        closed-loop-stepper) printf 'closed-loop steppers (PUL/DIR)%s' "$via" ;;
        ac-servo) printf 'AC servos (PUL/DIR)%s' "$via" ;;
        *) printf 'integrated servos (PUL/DIR)%s' "$via" ;;
      esac
      ;;
    dc) printf 'DC motors (H-bridge)' ;;
    *) printf 'not set' ;;
  esac
}

[[ $EUID -eq 0 ]] || die "run with sudo:  curl -fsSL .../setup.sh | sudo bash"
command -v apt-get >/dev/null || die "this installer needs a Debian-based system (Raspberry Pi OS, Debian, Ubuntu, Mint)"

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
OLD_PULSE_DRIVE=""; OLD_SERVO_DRIVER=""; OLD_ESP32_LINK=""; OLD_ESP32_HOST=""
if [[ -f "$STATE_FILE" ]]; then
  # shellcheck disable=SC1090
  OLD_ROLE="$(awk -F= '$1=="role"{print $2}' "$STATE_FILE")"
  OLD_MOTOR="$(awk -F= '$1=="motor"{print $2}' "$STATE_FILE")"
  OLD_SHELVES="$(awk -F= '$1=="shelves"{print $2}' "$STATE_FILE")"
  OLD_NUMBER="$(awk -F= '$1=="number"{print $2}' "$STATE_FILE")"
  OLD_MASTER="$(awk -F= '$1=="master_host"{print $2}' "$STATE_FILE")"
  OLD_APP_DIR="$(awk -F= '$1=="app_dir"{print $2}' "$STATE_FILE")"
  OLD_HOSTNAME="$(awk -F= '$1=="hostname"{print $2}' "$STATE_FILE")"
  OLD_PULSE_DRIVE="$(awk -F= '$1=="pulse_drive"{print $2}' "$STATE_FILE")"
  OLD_SERVO_DRIVER="$(awk -F= '$1=="servo_driver"{print $2}' "$STATE_FILE")"
  OLD_ESP32_LINK="$(awk -F= '$1=="esp32_link"{print $2}' "$STATE_FILE")"
  OLD_ESP32_HOST="$(awk -F= '$1=="esp32_host"{print $2}' "$STATE_FILE")"
fi
# Installs from before these questions existed: the agent's motor.json knows
# what the app picked, so show and default to that.
if [[ -f "$MOTOR_CONF" && -z "$OLD_PULSE_DRIVE$OLD_SERVO_DRIVER" ]]; then
  read -r OLD_PULSE_DRIVE OLD_SERVO_DRIVER OLD_ESP32_LINK < <(python3 -c '
import json, sys
c = json.load(open(sys.argv[1]))
print(c.get("pulseDrive") or "-", c.get("servoDriver") or "-", c.get("esp32Link") or "-")
' "$MOTOR_CONF" 2>/dev/null || echo "- - -")
  [[ "$OLD_PULSE_DRIVE" == "-" ]] && OLD_PULSE_DRIVE=""
  [[ "$OLD_SERVO_DRIVER" == "-" ]] && OLD_SERVO_DRIVER=""
  [[ "$OLD_ESP32_LINK" == "-" ]] && OLD_ESP32_LINK=""
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
if [[ $UPDATE_ONLY -eq 1 ]]; then
  # An update must never turn into a silent fresh install with default answers.
  [[ -n "$OLD_ROLE" ]] || die "PAX is not installed on this Pi yet. Run the install command first (without --update)."
  ACTION="update"
  say "Updating: $(role_label "$OLD_ROLE")"
  [[ -f "$DATA_DIR/paternoster.db" ]] && note "data: $DATA_DIR/paternoster.db — kept, backed up first"
  printf '\n'
elif [[ -n "$OLD_ROLE" && $RECONFIGURE -eq 0 && -z "$ROLE" ]]; then
  tty_say "${GREEN}PAX is already installed on this Pi.${RESET}"
  tty_say "    setup   : $(role_label "$OLD_ROLE")"
  [[ "$OLD_ROLE" == "master" || "$OLD_ROLE" == "slave" ]] && tty_say "    motors  : $(motor_label "$OLD_MOTOR" "$OLD_PULSE_DRIVE" "$OLD_SERVO_DRIVER" "$OLD_ESP32_LINK")${OLD_SHELVES:+, $OLD_SHELVES shelves}"
  [[ -f "$DATA_DIR/paternoster.db" ]] && tty_say "    data    : $DATA_DIR/paternoster.db ($(du -h "$DATA_DIR/paternoster.db" | cut -f1)) — will be kept"
  tty_say ""
  tty_say "What do you want to do?"
  tty_say "  ${BOLD}1${RESET}) Update to the latest version, keep this setup"
  case "$OLD_ROLE" in
    app)
      tty_say "  ${BOLD}2${RESET}) Make this the MASTER (as a SERVER, or with a carousel wired to it)"
      ;;
    server|pi-server)
      tty_say "  ${BOLD}2${RESET}) Wire a carousel to this computer too (becomes MASTER + CAROUSEL)"
      ;;
    master|slave)
      tty_say "  ${BOLD}2${RESET}) Change the motor type (currently $(motor_label "$OLD_MOTOR" "$OLD_PULSE_DRIVE" "$OLD_SERVO_DRIVER" "$OLD_ESP32_LINK"))"
      ;;
  esac
  tty_say "  ${BOLD}3${RESET}) Reconfigure from the start (asks every question again; data is still kept)"
  case "$(ask "Choose" "1")" in
    1) ACTION="update" ;;
    2) case "$OLD_ROLE" in
         app) ACTION="make-master" ;;
         server|pi-server) ACTION="add-hardware" ;;
         *) ACTION="change-motor" ;;
       esac ;;
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
    # Only re-send drive choices the installer itself saved; otherwise leave
    # motor.json (what the app chose) untouched.
    PULSE_DRIVE="${PULSE_DRIVE:-$(awk -F= '$1=="pulse_drive"{print $2}' "$STATE_FILE" 2>/dev/null || true)}"
    SERVO_DRIVER="${SERVO_DRIVER:-$(awk -F= '$1=="servo_driver"{print $2}' "$STATE_FILE" 2>/dev/null || true)}"
    ESP32_LINK="${ESP32_LINK:-$(awk -F= '$1=="esp32_link"{print $2}' "$STATE_FILE" 2>/dev/null || true)}"
    ESP32_HOST="${ESP32_HOST:-$(awk -F= '$1=="esp32_host"{print $2}' "$STATE_FILE" 2>/dev/null || true)}"
    DRIVE_ASKED=1
    ;;
  add-hardware)
    ROLE="master"
    ;;
  make-master)
    ROLE="master-ask"
    ;;
  change-motor)
    ROLE="$OLD_ROLE"; SHELVES="${SHELVES:-$OLD_SHELVES}"; NUMBER="${NUMBER:-$OLD_NUMBER}"; MASTER_HOST="${MASTER_HOST:-$OLD_MASTER}"
    MOTOR=""; PULSE_DRIVE=""; SERVO_DRIVER=""; ESP32_LINK=""; ESP32_HOST=""   # force the questions
    ;;
  reconfigure)
    # Saved answers become defaults, not silent choices.
    ;;
esac

# --------------------------------------------------------------------------
# Question 1: what is this Pi?
# --------------------------------------------------------------------------
if [[ -z "$ROLE" ]]; then
  tty_say "What should this device be?"
  tty_say "  ${BOLD}1${RESET}) MASTER – the host for the whole system: web app and database."
  tty_say "              Every slave signs in here. You need exactly ${BOLD}one${RESET}."
  tty_say "  ${BOLD}2${RESET}) SLAVE  – drives one carousel and follows the master."
  tty_say "              A Pi Zero 2 W is enough."
  DEFAULT_CHOICE=1
  [[ "$OLD_ROLE" == "slave" ]] && DEFAULT_CHOICE=2
  case "$(ask "Choose" "$DEFAULT_CHOICE")" in
    1|m|master|M) ROLE=master-ask ;;
    2|s|slave|S)  ROLE=slave ;;
    *) die "answer 1 or 2" ;;
  esac
fi

if [[ "$ROLE" == "master-ask" ]]; then
  tty_say ""
  tty_say "What kind of computer is this master?"
  tty_say "  ${BOLD}1${RESET}) PC – a Linux PC that is always on. SERVER only."
  tty_say "         No wiring, no GPIO; this computer's network is left alone."
  tty_say "         Install every carousel as a SLAVE pointing at this server."
  tty_say "  ${BOLD}2${RESET}) Raspberry Pi"
  DEFAULT_DEVICE=1
  [[ "$MODEL" == *"Raspberry Pi"* ]] && DEFAULT_DEVICE=2
  [[ "$OLD_ROLE" == "server" ]] && DEFAULT_DEVICE=1
  [[ "$OLD_ROLE" == "pi-server" || "$OLD_ROLE" == "master" ]] && DEFAULT_DEVICE=2
  case "$(ask "Choose" "$DEFAULT_DEVICE")" in
    1|pc|PC) ROLE=server ;;
    2|pi|Pi) ROLE=pi-ask ;;
    *) die "answer 1 or 2" ;;
  esac
fi

if [[ "$ROLE" == "pi-ask" ]]; then
  tty_say ""
  tty_say "Is a carousel wired to this Pi?"
  tty_say "  ${BOLD}1${RESET}) No  – PI SERVER: web app and slave sign-in only."
  tty_say "           No motors, no GPIO. Still opens the PAX-Setup hotspot"
  tty_say "           if the router disappears."
  tty_say "  ${BOLD}2${RESET}) Yes – this Pi also drives one carousel, and opens the"
  tty_say "           PAX-Setup hotspot if the router disappears."
  DEFAULT_KIND=1
  [[ "$OLD_ROLE" == "master" ]] && DEFAULT_KIND=2
  case "$(ask "Choose" "$DEFAULT_KIND")" in
    1|n|no|server) ROLE=pi-server ;;
    2|y|yes|carousel) ROLE=master ;;
    *) die "answer 1 or 2" ;;
  esac
fi
[[ "$ROLE" == "app" || "$ROLE" == "server" || "$ROLE" == "pi-server" || "$ROLE" == "master" || "$ROLE" == "slave" ]] \
  || die "--role must be server, pi-server, master or slave"

if [[ "$ROLE" != "slave" && "$MODEL" == *"Zero"* ]]; then
  warn "a Pi Zero cannot build or comfortably serve the web app; the web app belongs on a Pi 4/5 or a PC"
fi

# HAS_AGENT: runs the agent (slave sign-in / networking). HAS_CAROUSEL: has motors.
HAS_APP=0; HAS_AGENT=0; HAS_CAROUSEL=0
[[ "$ROLE" == "app" || "$ROLE" == "server" || "$ROLE" == "pi-server" || "$ROLE" == "master" ]] && HAS_APP=1
[[ "$ROLE" == "server" || "$ROLE" == "pi-server" || "$ROLE" == "master" || "$ROLE" == "slave" ]] && HAS_AGENT=1
[[ "$ROLE" == "master" || "$ROLE" == "slave" ]] && HAS_CAROUSEL=1
if [[ "$ROLE" == "server" || "$ROLE" == "pi-server" || "$ROLE" == "app" ]]; then
  MOTOR=""; PULSE_DRIVE=""; SERVO_DRIVER=""; ESP32_LINK=""; ESP32_HOST=""; SHELVES=""
fi

# --------------------------------------------------------------------------
# Question 2: motors (carousel roles only)
# --------------------------------------------------------------------------
if [[ -n "$PULSE_DRIVE" ]]; then
  case "$PULSE_DRIVE" in integrated-servo|closed-loop-stepper|ac-servo) ;; *) die "--pulse-drive must be integrated-servo, closed-loop-stepper or ac-servo" ;; esac
  [[ "$MOTOR" == "dc" ]] && die "--pulse-drive needs --motor servo"
  MOTOR=servo
fi
if [[ $HAS_CAROUSEL -eq 1 && -z "$MOTOR" ]]; then
  tty_say ""
  tty_say "Which motors turn this carousel?"
  tty_say "  ${BOLD}1${RESET}) Integrated servos    – iSV57T or similar, drive built into the motor,"
  tty_say "                            pulsed from this Pi"
  tty_say "  ${BOLD}2${RESET}) Closed-loop steppers – CL57T / CL86Y or similar with a separate drive,"
  tty_say "                            pulsed by an ESP32"
  tty_say "  ${BOLD}3${RESET}) AC servos            – A6-RS or similar with a separate drive,"
  tty_say "                            pulsed by an ESP32"
  tty_say "  ${BOLD}4${RESET}) DC motors            – brushed motors on an H-bridge (L298N / BTS7960),"
  tty_say "                            PWM speed"
  DEFAULT_MOTOR=1
  if [[ "$OLD_MOTOR" == "dc" ]]; then DEFAULT_MOTOR=4
  elif [[ "$OLD_PULSE_DRIVE" == "closed-loop-stepper" ]]; then DEFAULT_MOTOR=2
  elif [[ "$OLD_PULSE_DRIVE" == "ac-servo" ]]; then DEFAULT_MOTOR=3
  fi
  case "$(ask "Choose" "$DEFAULT_MOTOR")" in
    1|s|servo|servos) MOTOR=servo; PULSE_DRIVE=integrated-servo ;;
    2|c|stepper|cl)   MOTOR=servo; PULSE_DRIVE=closed-loop-stepper ;;
    3|ac)             MOTOR=servo; PULSE_DRIVE=ac-servo ;;
    4|d|dc|DC)        MOTOR=dc ;;
    *) die "answer 1, 2, 3 or 4" ;;
  esac
fi
if [[ $HAS_CAROUSEL -eq 1 ]]; then
  [[ "$MOTOR" == "servo" || "$MOTOR" == "dc" ]] || die "--motor must be servo or dc"
fi

# Who makes the step pulses. Separate drives (closed-loop stepper, AC servo)
# need an ESP32 running pi-agent/esp32-servo; integrated servos are pulsed
# from the Pi header unless told otherwise.
if [[ $HAS_CAROUSEL -eq 1 && "$MOTOR" == "servo" && "${DRIVE_ASKED:-0}" -eq 0 ]]; then
  if [[ -z "$SERVO_DRIVER" ]]; then
    if [[ -n "$ESP32_LINK" || ( -n "$PULSE_DRIVE" && "$PULSE_DRIVE" != "integrated-servo" ) ]]; then
      SERVO_DRIVER=esp32
    else
      SERVO_DRIVER=gpio
    fi
  fi
  [[ "$SERVO_DRIVER" == "gpio" || "$SERVO_DRIVER" == "esp32" ]] || die "--servo-driver must be gpio or esp32"
  if [[ "$SERVO_DRIVER" == "esp32" && -z "$ESP32_LINK" ]]; then
    tty_say ""
    tty_say "How is the ESP32 motor controller connected to this Pi?"
    tty_say "${DIM}(flash it first with pi-agent/esp32-servo — see its README)${RESET}"
    tty_say "  ${BOLD}1${RESET}) USB cable – DevKit micro-USB to a Pi USB port, also powers the ESP32"
    tty_say "  ${BOLD}2${RESET}) UART      – 3 wires on the Pi header (GPIO14/15 + GND), needs one reboot"
    tty_say "  ${BOLD}3${RESET}) Wi-Fi     – ESP32 on its own, no cable; you enter its hostname"
    DEFAULT_LINK=1
    case "$OLD_ESP32_LINK" in uart) DEFAULT_LINK=2 ;; wifi) DEFAULT_LINK=3 ;; esac
    case "$(ask "Choose" "$DEFAULT_LINK")" in
      1|usb)  ESP32_LINK=usb ;;
      2|uart) ESP32_LINK=uart ;;
      3|wifi) ESP32_LINK=wifi ;;
      *) die "answer 1, 2 or 3" ;;
    esac
  fi
  if [[ "$ESP32_LINK" == "wifi" && -z "$ESP32_HOST" ]]; then
    ESP32_HOST="$(ask "ESP32 hostname or IP (printed on its USB console)" "${OLD_ESP32_HOST:-pax-esp32-xxxx.local}")"
    [[ "$ESP32_HOST" == *xxxx* ]] && die "enter the ESP32's real hostname, e.g. pax-esp32-1a2b.local"
  fi
fi
[[ "$MOTOR" == "dc" ]] && { PULSE_DRIVE=""; SERVO_DRIVER=""; ESP32_LINK=""; ESP32_HOST=""; }

# --------------------------------------------------------------------------
# Question 3: shelves, and for a slave its number + master hotspot password
# --------------------------------------------------------------------------
if [[ $HAS_CAROUSEL -eq 1 ]]; then
  SHELVES="${SHELVES:-$(ask "How many shelves does this carousel have?" "${OLD_SHELVES:-9}")}"
  [[ "$SHELVES" =~ ^[0-9]+$ && "$SHELVES" -ge 2 ]] || die "shelves must be a number (2 or more)"
fi

CUR_HOST="$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo raspberrypi)"
if [[ "$ROLE" == "server" ]]; then
  # Slaves default to looking for pax-master.local, so offer that name. A PC
  # being renamed is a real change, hence the question; updates keep it.
  if [[ "$ACTION" == "update" && -n "$OLD_HOSTNAME" ]]; then
    HOSTNAME_NEW="$OLD_HOSTNAME"
  else
    HOSTNAME_NEW="$(ask "Hostname for this server (slaves find it as <name>.local)" "${OLD_HOSTNAME:-pax-master}")"
  fi
  [[ "$HOSTNAME_NEW" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
    || die "hostname must be lowercase letters, digits and dashes (e.g. pax-master)"
  UNIT_NAME=""
elif [[ "$ROLE" == "app" ]]; then
  HOSTNAME_NEW="${OLD_HOSTNAME:-pax}"
  [[ "$CUR_HOST" != "raspberrypi" && -n "$CUR_HOST" ]] && HOSTNAME_NEW="$CUR_HOST"
  UNIT_NAME=""
elif [[ "$ROLE" == "pi-server" ]]; then
  HOSTNAME_NEW="pax-master"
  [[ "$ACTION" == "update" && -n "$OLD_HOSTNAME" ]] && HOSTNAME_NEW="$OLD_HOSTNAME"
  UNIT_NAME="PAX server"
elif [[ "$ROLE" == "master" ]]; then
  HOSTNAME_NEW="pax-master"
  # An update keeps whatever address slaves and phones already use.
  [[ "$ACTION" == "update" && -n "$OLD_HOSTNAME" ]] && HOSTNAME_NEW="$OLD_HOSTNAME"
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
    tty_say "${DIM}A master on a Raspberry Pi printed a hotspot password when it was"
    tty_say "installed. Enter it so this slave can always find the master. Press"
    tty_say "Enter to skip if the master is a PC SERVER (it has no hotspot) or both"
    tty_say "are on the same Wi-Fi now.${RESET}"
    AP_PSK="$(ask_secret "Master hotspot password (optional)")"
  fi
  if [[ -n "$AP_PSK" && -z "$AP_SSID" ]]; then
    AP_SSID="$(ask "Master hotspot name" "PAX-Setup")"
  fi
fi

printf '\n'
SUMMARY="$(role_label "$ROLE")"
MOTOR_TEXT="$(motor_label "$MOTOR" "$PULSE_DRIVE" "$SERVO_DRIVER" "$ESP32_LINK")"
[[ $HAS_CAROUSEL -eq 1 ]] && SUMMARY="$SUMMARY — $MOTOR_TEXT, $SHELVES shelves"
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
  # Raspberry Pi OS ships its own nodejs package without npm, so a Node that
  # is new enough but has no npm still gets replaced by NodeSource (npm bundled).
  NEED_NODE=1
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    [[ "$NODE_MAJOR" -ge 20 ]] && NEED_NODE=0
  fi
  if [[ $NEED_NODE -eq 1 ]]; then
    say "Installing Node.js 22 (with npm)"
    if curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1; then
      apt-get install -y -qq nodejs >/dev/null || true
    fi
    hash -r
    if ! command -v npm >/dev/null 2>&1; then
      note "NodeSource did not provide npm, installing the system npm package"
      apt-get install -y -qq nodejs npm >/dev/null || true
      hash -r
    fi
  fi
  command -v node >/dev/null 2>&1 || die "Node.js could not be installed. Check the internet connection and re-run setup.sh"
  command -v npm >/dev/null 2>&1 || die "npm could not be installed. Run 'sudo apt-get install npm' and re-run setup.sh"
  note "node $(node -v), npm $(npm -v)"
  if ! command -v pnpm >/dev/null 2>&1; then
    # Pinned to 10.x: newer pnpm majors drop Node 20, and an unpinned install
    # fails on Pis that already have Node 20.
    say "Installing pnpm"
    if ! PNPM_LOG="$(npm install -g pnpm@10 2>&1)"; then
      printf '%s\n' "$PNPM_LOG" | tail -n 15 >&2
      die "could not install pnpm (see the npm output above). Check the internet connection and re-run setup.sh"
    fi
    hash -r
    command -v pnpm >/dev/null 2>&1 || die "pnpm was installed but is not on PATH ($(npm prefix -g)/bin)"
  fi
  note "pnpm $(pnpm -v)"

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
if [[ "$ROLE" == "server" ]]; then
  say "Installing the master service (slave sign-in + Wi-Fi provisioning, no carousel)"
  chmod +x "$APP_DIR/pi-agent/install.sh"
  SUDO_USER="$RUN_USER" "$APP_DIR/pi-agent/install.sh" --server --hostname "$HOSTNAME_NEW" --name "PAX server" --port "$AGENT_PORT" \
    | grep -vE '^\[install\] (installing|detected|added|wrote|service is running|verify GPIO|           journalctl)' || die "master service installation failed"
elif [[ "$ROLE" == "pi-server" ]]; then
  say "Installing the master service (slave sign-in + hotspot fallback, no carousel)"
  chmod +x "$APP_DIR/pi-agent/install.sh"
  # install.sh prints its own networking summary (including the hotspot password).
  SUDO_USER="$RUN_USER" "$APP_DIR/pi-agent/install.sh" --no-carousel --role master --hostname "$HOSTNAME_NEW" --name "$UNIT_NAME" --port "$AGENT_PORT" \
    | grep -vE '^\[install\] (installing|detected|added|wrote|sudoers|hotspot profile|fallback profile|adopted|service is running|verify GPIO|           journalctl)' || die "master service installation failed"
elif [[ $HAS_AGENT -eq 1 ]]; then
  say "Installing the carousel agent ($MOTOR_TEXT) and network manager"
  AGENT_ARGS=(--role "$ROLE" --hostname "$HOSTNAME_NEW" --name "$UNIT_NAME" --shelves "$SHELVES" --port "$AGENT_PORT" --motor "$MOTOR")
  [[ -n "$PULSE_DRIVE" ]] && AGENT_ARGS+=(--pulse-drive "$PULSE_DRIVE")
  [[ -n "$SERVO_DRIVER" ]] && AGENT_ARGS+=(--servo-driver "$SERVO_DRIVER")
  [[ -n "$ESP32_LINK" ]] && AGENT_ARGS+=(--esp32-link "$ESP32_LINK")
  [[ -n "$ESP32_HOST" ]] && AGENT_ARGS+=(--esp32-host "$ESP32_HOST")
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
pulse_drive=$PULSE_DRIVE
servo_driver=$SERVO_DRIVER
esp32_link=$ESP32_LINK
esp32_host=$ESP32_HOST
shelves=$SHELVES
number=$NUMBER
master_host=$MASTER_HOST
hostname=$HOSTNAME_NEW
app_dir=$APP_DIR
data_dir=$DATA_DIR
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
    if [[ "$ROLE" == "server" ]]; then
      printf '\n%s\n' "This is the MASTER (server). No carousel is driven from here and its network is untouched."
      printf '%s\n' "Install each carousel as a SLAVE: run this same command on it, answer 2, and give"
      printf '%s\n' "${BOLD}$HOSTNAME_NEW.local${RESET} as the master hostname. Then link it in the app as"
      printf '%s\n' "${BOLD}pax-slave-1.local${RESET} (port $AGENT_PORT), …"
      printf '%s\n' "${DIM}Slaves appear under Settings → Network → Slave units; Wi-Fi changes are pushed to them.${RESET}"
    elif [[ "$ROLE" == "pi-server" ]]; then
      printf '\n%s\n' "This Pi is the MASTER (Pi server). No carousel is driven from here."
      printf '%s\n' "Install each carousel as a SLAVE: run this same command on it, answer 2, and give"
      printf '%s\n' "${BOLD}$HOSTNAME_NEW.local${RESET} as the master hostname. Then link it in the app as"
      printf '%s\n' "${BOLD}pax-slave-1.local${RESET} (port $AGENT_PORT), …"
      printf '\n%s\n' "Write down the hotspot password printed above. If the Wi-Fi ever disappears, this Pi"
      printf '%s\n' "opens that hotspot and the app is at ${BOLD}http://10.42.0.1${RESET}."
    elif [[ "$ROLE" == "master" ]]; then
      printf '\n%s\n' "In the app, under Settings → Storage units, set the master paternoster's address to"
      printf '%s\n' "${BOLD}127.0.0.1${RESET} (this Pi drives its own carousel) and pick ${BOLD}$MOTOR_TEXT${RESET}"
      printf '%s\n' "under Motor drive. Link slaves as ${BOLD}pax-slave-1.local${RESET}, …"
      printf '%s\n' "${DIM}A slave can also be an ESP32 with no Pi at all: see esp32-agent/README.md.${RESET}"
      printf '\n%s\n' "Write down the hotspot password printed above. If the Wi-Fi ever disappears, this Pi"
      printf '%s\n' "opens that hotspot and the app is at ${BOLD}http://10.42.0.1${RESET}."
      printf '\n%s\n' "${DIM}Install a slave: run this same command on it and answer 2.${RESET}"
    else
      printf '\n%s\n' "This Pi only runs the filament manager — no motors are driven from here."
      printf '%s\n' "${DIM}Want it to control a paternoster later? Run this same command again and choose"
      printf '%s\n' "\"Make this the MASTER\". Everything you have entered is kept.${RESET}"
    fi
  else
    warn "the web app did not start. Log:"
    journalctl -u pax-app -n 20 --no-pager >&2
    exit 1
  fi
else
  printf '%s\n' "${GREEN}${BOLD}Done.${RESET} This slave ($MOTOR_TEXT) is now following ${BOLD}$MASTER_HOST${RESET}."
  printf '%s\n' "It appears under Settings → Network → Slave units on the master within a minute."
  printf '%s\n' "Link it in the app as ${BOLD}$HOSTNAME_NEW.local${RESET} (port $AGENT_PORT) and pick"
  printf '%s\n' "${BOLD}$MOTOR_TEXT${RESET} under Motor drive for that unit."
fi
if [[ $HAS_CAROUSEL -eq 1 && "$SERVO_DRIVER" == "esp32" ]]; then
  printf '\n%s\n' "${BOLD}ESP32 motor controller:${RESET} flash pi-agent/esp32-servo onto the ESP32 if you have not yet,"
  printf '%s\n' "and wire the drives and both sensors to the ESP32, not to this Pi (pi-agent/esp32-servo/README.md)."
  [[ "$ESP32_LINK" == "uart" ]] && printf '%s\n' "${YELLOW}Reboot this Pi once${RESET} so the UART on GPIO14/15 is free for the ESP32:  sudo reboot"
fi
printf '\n%s\n' "${DIM}Update later from Settings → Update, or over SSH:  curl -fsSL <same URL>/setup.sh | sudo bash -s -- --update"
printf '%s\n' "${DIM} Logs: journalctl -u pax-app -f  /  journalctl -u paternoster-agent -f${RESET}"
