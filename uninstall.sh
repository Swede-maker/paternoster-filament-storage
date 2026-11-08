#!/usr/bin/env bash
#
# PAX uninstaller for Raspberry Pi / Linux PC.
#
# Over SSH (works on any installed device, no checkout needed):
#   curl -fsSL https://raw.githubusercontent.com/Swede-maker/paternoster-filament-storage/main/uninstall.sh | sudo bash
#
# or, from a checked-out copy:
#   sudo ./uninstall.sh
#
# Removes everything setup.sh / pi-agent/install.sh put on this device:
#   services   pax-app, pax-update (.path/.service), paternoster-agent,
#              paternoster-agent-<instance>, pax-camera
#   files      /usr/local/sbin/pax-update, /etc/sudoers.d/paxnet,
#              /etc/pax-install.conf, the app checkout (default ~/pax)
#   Wi-Fi      the PAX hotspot profiles (pax-ap, pax-master-ap). Your own
#              router Wi-Fi (pax-router) is KEPT and renamed back to its SSID,
#              so the device stays on the network and SSH keeps working.
#
# By default your DATA IS KEPT, so a later reinstall picks up where you left off:
#   /var/lib/pax         database + backups
#   /var/lib/pax-agent   motor tuning
#   /etc/paxnet.conf     hotspot name + password (slaves keep working after a reinstall)
#
# Options:
#   --purge       also delete the data above (cannot be undone)
#   --keep-code   leave the app checkout (~/pax) in place
#   -y, --yes     do not ask for confirmation (needed when there is no terminal)
#   -h, --help    show this help
#
# Left alone on purpose (shared with other software): Node.js, pnpm, avahi,
# git, build tools, the hostname, swap size, group memberships and any UART /
# boot-config changes.
set -uo pipefail

PURGE=0
KEEP_CODE=0
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --keep-code) KEEP_CODE=1; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,34p' "$0" 2>/dev/null || echo "see the header of uninstall.sh"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

BOLD=$'\e[1m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; RESET=$'\e[0m'
say()  { printf '%s\n' "${BOLD}==>${RESET} $*"; }
note() { printf '%s\n' "    ${DIM}$*${RESET}"; }
warn() { printf '%s\n' "${YELLOW}warning:${RESET} $*" >&2; }
die()  { printf '%s\n' "${RED}error:${RESET} $*" >&2; exit 1; }
has_tty() { { : > /dev/tty; } 2>/dev/null; }

[[ $EUID -eq 0 ]] || die "run with sudo:  curl -fsSL .../uninstall.sh | sudo bash"

STATE_FILE=/etc/pax-install.conf
DATA_DIR=/var/lib/pax
AGENT_DATA=/var/lib/pax-agent
NET_CONF=/etc/paxnet.conf

RUN_USER="${SUDO_USER:-}"
if [[ -z "$RUN_USER" || "$RUN_USER" == "root" ]]; then
  RUN_USER="$(awk -F: '$3>=1000 && $3<65534 {print $1; exit}' /etc/passwd)"
fi
RUN_HOME="$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6)"

ROLE=""; APP_DIR=""
if [[ -f "$STATE_FILE" ]]; then
  ROLE="$(awk -F= '$1=="role"{print $2}' "$STATE_FILE")"
  APP_DIR="$(awk -F= '$1=="app_dir"{print $2}' "$STATE_FILE")"
  DATA_DIR_SAVED="$(awk -F= '$1=="data_dir"{print $2}' "$STATE_FILE")"
  [[ -n "$DATA_DIR_SAVED" ]] && DATA_DIR="$DATA_DIR_SAVED"
fi
# Older installs without app_dir in the state file: the app unit knows.
if [[ -z "$APP_DIR" && -f /etc/systemd/system/pax-app.service ]]; then
  APP_DIR="$(awk -F= '$1=="WorkingDirectory"{print $2}' /etc/systemd/system/pax-app.service)"
fi
# The agent unit points at <checkout>/pi-agent on slaves.
if [[ -z "$APP_DIR" && -f /etc/systemd/system/paternoster-agent.service ]]; then
  AGENT_DIR="$(awk -F= '$1=="WorkingDirectory"{print $2}' /etc/systemd/system/paternoster-agent.service)"
  [[ "$AGENT_DIR" == */pi-agent ]] && APP_DIR="${AGENT_DIR%/pi-agent}"
fi
[[ -z "$APP_DIR" && -n "$RUN_HOME" && -d "$RUN_HOME/pax/.git" ]] && APP_DIR="$RUN_HOME/pax"

# All PAX units on this device, including extra ESP32 agent instances.
UNITS=()
for unit in pax-update.path pax-update.service pax-app.service paternoster-agent.service pax-camera.service; do
  [[ -f "/etc/systemd/system/$unit" ]] && UNITS+=("$unit")
done
for f in /etc/systemd/system/paternoster-agent-*.service; do
  [[ -f "$f" ]] && UNITS+=("$(basename "$f")")
done

# Only ever delete a directory that really is a PAX checkout.
CODE_OK=0
if [[ -n "$APP_DIR" && -d "$APP_DIR" && -f "$APP_DIR/package.json" && -f "$APP_DIR/pi-agent/install.sh" \
      && "$APP_DIR" != "/" && "$APP_DIR" != "$RUN_HOME" && "$APP_DIR" != "/home" && "$APP_DIR" != "/root" ]]; then
  CODE_OK=1
fi

NM=0
command -v nmcli >/dev/null 2>&1 && systemctl is-active --quiet NetworkManager 2>/dev/null && NM=1
NM_PROFILES=()
if [[ $NM -eq 1 ]]; then
  for p in pax-ap pax-master-ap pax-router; do
    nmcli -t -f NAME con show 2>/dev/null | grep -qx "$p" && NM_PROFILES+=("$p")
  done
fi

if [[ ${#UNITS[@]} -eq 0 && ! -f "$STATE_FILE" && $CODE_OK -eq 0 && ${#NM_PROFILES[@]} -eq 0 \
      && ! -f /etc/sudoers.d/paxnet && ! -f /usr/local/sbin/pax-update ]]; then
  printf '%s\n' "PAX is not installed on this device — nothing to remove."
  if [[ $PURGE -eq 1 && ( -d "$DATA_DIR" || -d "$AGENT_DATA" || -f "$NET_CONF" ) ]]; then
    note "leftover data found; continuing with --purge"
  else
    exit 0
  fi
fi

# --------------------------------------------------------------------------
# Show what will happen, then confirm
# --------------------------------------------------------------------------
printf '\n%s\n' "${BOLD}PAX uninstaller${RESET}"
[[ -n "$ROLE" ]] && note "installed as: $ROLE"
printf '\n%s\n' "This removes:"
for u in "${UNITS[@]}"; do printf '    service  %s\n' "$u"; done
[[ -f /usr/local/sbin/pax-update ]] && printf '    file     %s\n' /usr/local/sbin/pax-update
[[ -f /etc/sudoers.d/paxnet ]] && printf '    file     %s\n' /etc/sudoers.d/paxnet
[[ -f "$STATE_FILE" ]] && printf '    file     %s\n' "$STATE_FILE"
if [[ $CODE_OK -eq 1 && $KEEP_CODE -eq 0 ]]; then printf '    code     %s\n' "$APP_DIR"; fi
for p in "${NM_PROFILES[@]}"; do
  if [[ "$p" == "pax-router" ]]; then printf '    Wi-Fi    %s  (kept, renamed back to its network name)\n' "$p"
  else printf '    Wi-Fi    %s  (PAX hotspot profile)\n' "$p"; fi
done
if [[ $PURGE -eq 1 ]]; then
  printf '\n%s\n' "${RED}${BOLD}--purge: your data is deleted too:${RESET}"
  for d in "$DATA_DIR" "$AGENT_DATA" "$NET_CONF"; do [[ -e "$d" ]] && printf '    %s\n' "$d"; done
else
  printf '\n%s\n' "${GREEN}Kept (your data):${RESET}"
  for d in "$DATA_DIR" "$AGENT_DATA" "$NET_CONF"; do [[ -e "$d" ]] && printf '    %s\n' "$d"; done
  note "add --purge to delete these as well"
fi
printf '\n'

if [[ $ASSUME_YES -eq 0 ]]; then
  has_tty || die "no terminal to confirm on. Re-run with -y:  ... | sudo bash -s -- -y"
  if [[ $PURGE -eq 1 ]]; then
    printf '%s' "Type ${BOLD}delete${RESET} to remove PAX and all its data: " > /dev/tty
    IFS= read -r reply < /dev/tty || reply=""
    [[ "$reply" == "delete" ]] || die "cancelled — nothing was changed"
  else
    printf '%s' "Remove PAX from this device? [y/N]: " > /dev/tty
    IFS= read -r reply < /dev/tty || reply=""
    [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]] || die "cancelled — nothing was changed"
  fi
fi

# --------------------------------------------------------------------------
# Services
# --------------------------------------------------------------------------
if [[ ${#UNITS[@]} -gt 0 ]]; then
  say "Stopping and removing services"
  for u in "${UNITS[@]}"; do
    systemctl disable --now "$u" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$u"
    note "removed $u"
  done
  systemctl daemon-reload
  systemctl reset-failed >/dev/null 2>&1 || true
fi

# --------------------------------------------------------------------------
# Files
# --------------------------------------------------------------------------
say "Removing PAX files"
rm -f /usr/local/sbin/pax-update /usr/local/sbin/pax-update.new /usr/local/sbin/pax-agent-prestart
rm -f /etc/sudoers.d/paxnet /etc/udev/rules.d/99-pax-pwm.rules
rm -f "$STATE_FILE"
rm -f "$DATA_DIR/update.request" "$DATA_DIR/update.result" "$DATA_DIR/update.log"

if [[ $CODE_OK -eq 1 && $KEEP_CODE -eq 0 ]]; then
  # A database from before the data moved to /var/lib/pax would live here.
  if [[ $PURGE -eq 0 && -f "$APP_DIR/paternoster.db" ]]; then
    mkdir -p "$DATA_DIR"
    [[ -f "$DATA_DIR/paternoster.db" ]] || mv "$APP_DIR/paternoster.db"* "$DATA_DIR/" 2>/dev/null || true
    note "moved an old paternoster.db from the checkout to $DATA_DIR"
  fi
  rm -rf "$APP_DIR"
  note "removed $APP_DIR"
elif [[ -n "$APP_DIR" && $KEEP_CODE -eq 0 && -d "$APP_DIR" ]]; then
  warn "$APP_DIR does not look like a PAX checkout — left it alone"
fi

if [[ $PURGE -eq 1 ]]; then
  say "Deleting your data (--purge)"
  rm -rf "$DATA_DIR" "$AGENT_DATA"
  rm -f "$NET_CONF"
  note "removed $DATA_DIR, $AGENT_DATA and $NET_CONF"
fi

# --------------------------------------------------------------------------
# Wi-Fi profiles — last, because it can briefly drop an SSH session that
# came in over the PAX hotspot. Ignore SIGHUP so the script still finishes.
# --------------------------------------------------------------------------
ON_HOTSPOT=0
if [[ $NM -eq 1 && ${#NM_PROFILES[@]} -gt 0 ]]; then
  ACTIVE="$(nmcli -t -f NAME con show --active 2>/dev/null || true)"
  grep -qxE 'pax-ap|pax-master-ap' <<<"$ACTIVE" && ON_HOTSPOT=1
fi

printf '\n%s\n' "${GREEN}${BOLD}PAX has been removed.${RESET}"
if [[ $PURGE -eq 0 ]]; then
  note "Your data is still in $DATA_DIR — reinstalling picks it up again."
fi
note "Node.js, pnpm, avahi, the hostname ($(hostname)) and swap size were left as they are."
if [[ $ON_HOTSPOT -eq 1 ]]; then
  warn "this device is on the PAX hotspot right now; removing it will drop this SSH session."
  note "Reconnect over the router afterwards (or a cable) if you still need it."
fi

if [[ $NM -eq 1 && ${#NM_PROFILES[@]} -gt 0 ]]; then
  trap '' HUP
  say "Removing PAX Wi-Fi profiles"
  for p in "${NM_PROFILES[@]}"; do
    if [[ "$p" == "pax-router" ]]; then
      SSID="$(nmcli -g 802-11-wireless.ssid con show pax-router 2>/dev/null || true)"
      if [[ -n "$SSID" ]] && ! nmcli -t -f NAME con show 2>/dev/null | grep -qxF "$SSID"; then
        nmcli con modify pax-router connection.id "$SSID" >/dev/null 2>&1 && note "router Wi-Fi kept as '$SSID'"
      else
        note "router Wi-Fi kept as 'pax-router'"
      fi
    else
      nmcli con delete "$p" >/dev/null 2>&1 && note "removed $p"
    fi
  done
fi
exit 0
