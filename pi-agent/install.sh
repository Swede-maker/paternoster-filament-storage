#!/usr/bin/env bash
#
# Installs the paternoster agent as a systemd service.
#
#   sudo ./install.sh                      # defaults: "Paternoster 1", 9 shelves, port 8765, role master
#   sudo ./install.sh --name "Unit 2" --shelves 12 --port 8766
#
# Networking (Raspberry Pi OS Bookworm+ / NetworkManager):
#   sudo ./install.sh --role master --hostname pax-master
#       Master: runs the fallback hotspot `PAX-Setup-XXXX`, stores its password
#       in /etc/paxnet.conf (printed at the end — write it down), provisions
#       slaves with new router credentials.
#   sudo ./install.sh --role slave --hostname pax-slave-1 --master pax-master.local \
#                     --ap-ssid PAX-Setup-1A2B --ap-psk <master hotspot password>
#       Slave: follows the master. Keeps the master's hotspot as a fallback
#       network so it can always be reached and re-provisioned. --ap-ssid/--ap-psk
#       are optional if the slave is on the same network as the master right
#       now: it fetches them from the master on first registration.
#   --no-net            skip all Wi-Fi/hostname setup (wired lab bench)
#   --motor dc|servo    which drive is wired to this Pi; written to
#                       /var/lib/pax-agent/motor.json (other tuning kept)
#
# Detects the invoking user and this directory instead of assuming `pi` and
# /home/pi, which is what previously caused `status=217/USER` on systems where no
# `pi` user exists. Also selects the correct gpiozero pin factory, because the
# Pi 5's GPIO chip is unsupported by the default RPi.GPIO backend and the agent
# would otherwise fall back to faking motion.
set -euo pipefail

NAME="Paternoster 1"
SHELVES=9
PORT=8765
STRICT=1
ROLE="master"
HOSTNAME_NEW=""
MASTER_HOST="pax-master.local"
AP_SSID=""
AP_PSK=""
NET=1
MOTOR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --motor) MOTOR="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --shelves) SHELVES="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --allow-simulation) STRICT=0; shift ;;
    --role) ROLE="$2"; shift 2 ;;
    --hostname) HOSTNAME_NEW="$2"; shift 2 ;;
    --master) MASTER_HOST="$2"; shift 2 ;;
    --ap-ssid) AP_SSID="$2"; shift 2 ;;
    --ap-psk) AP_PSK="$2"; shift 2 ;;
    --no-net) NET=0; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ "$ROLE" != "master" && "$ROLE" != "slave" ]]; then
  echo "error: --role must be master or slave" >&2
  exit 2
fi
if [[ -n "$MOTOR" && "$MOTOR" != "dc" && "$MOTOR" != "servo" ]]; then
  echo "error: --motor must be dc or servo" >&2
  exit 2
fi

if [[ $EUID -ne 0 ]]; then
  echo "error: run with sudo (sudo ./install.sh)" >&2
  exit 1
fi

# SUDO_USER is the human who ran sudo; fall back to the owner of this directory
# for the rare case of a root shell. Never hardcode a username.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="${SUDO_USER:-$(stat -c '%U' "$DIR")}"

if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  echo "error: user '$RUN_USER' does not exist. Pass the right one via SUDO_USER." >&2
  exit 1
fi

if [[ ! -f "$DIR/paternoster_agent.py" ]]; then
  echo "error: paternoster_agent.py not found in $DIR" >&2
  exit 1
fi

echo "[install] user=$RUN_USER dir=$DIR name='$NAME' shelves=$SHELVES port=$PORT"

# --- dependencies -----------------------------------------------------------
echo "[install] installing python dependencies"
apt-get update -qq
apt-get install -y -qq python3-websockets python3-gpiozero >/dev/null

# --- pin factory ------------------------------------------------------------
# lgpio is installed on every model so a minimal OS image without any GPIO
# backend still works. Only the Pi 5 strictly needs it: its GPIO chip is
# unsupported by RPi.GPIO, so there the install must succeed and gpiozero is
# pinned to lgpio. On a Pi 3/4 a failed install is only a warning, and the
# factory is left unpinned so an optional pigpio setup keeps working.
ENVIRONMENT=""
MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)"
echo "[install] detected board: $MODEL"
if [[ "$MODEL" == *"Raspberry Pi 5"* ]]; then
  echo "[install] Pi 5 detected — installing lgpio pin factory"
  apt-get install -y -qq python3-lgpio >/dev/null
  ENVIRONMENT='Environment=GPIOZERO_PIN_FACTORY=lgpio'
else
  echo "[install] installing lgpio as a fallback GPIO backend"
  if ! apt-get install -y -qq python3-lgpio >/dev/null 2>&1; then
    echo "[install] warning: python3-lgpio unavailable — using the system's existing GPIO backend"
  fi
fi

# --- gpio access ------------------------------------------------------------
if getent group gpio >/dev/null 2>&1; then
  usermod -aG gpio "$RUN_USER"
  echo "[install] added $RUN_USER to the gpio group"
fi

# --- undo the hardware-PWM experiment -----------------------------------------
# An earlier installer added a pwm-2chan overlay on GPIO 12/13 and a root
# pre-start helper. The agent drives the pins directly through lgpio again, and
# with the overlay in place those two pins are kernel-owned ("GPIO busy"), so
# take both out. Removing the overlay only takes effect after a reboot.
NEED_REBOOT=0
for conf in /boot/firmware/config.txt /boot/config.txt; do
  [[ -f "$conf" ]] || continue
  if grep -q '^dtoverlay=pwm' "$conf"; then
    sed -i -e '/^# PAX: hardware PWM on GPIO 12\/13/d' -e '/^dtoverlay=pwm/d' "$conf"
    echo "[install] removed hardware PWM overlay from $conf (reboot to apply)"
    NEED_REBOOT=1
  fi
done
rm -f /usr/local/sbin/pax-agent-prestart /etc/udev/rules.d/99-pax-pwm.rules

# --- motor drive ------------------------------------------------------------
# Seed the agent's persisted drive choice so the right backend comes up on
# first boot. Only `mode` changes; pulses/rev, pulse rate, mirror and the
# hold timeout the app may already have tuned are kept.
MOTOR_CONF=/var/lib/pax-agent/motor.json
if [[ -n "$MOTOR" ]]; then
  mkdir -p "$(dirname "$MOTOR_CONF")"
  python3 - "$MOTOR_CONF" "$MOTOR" <<'PY'
import json, os, sys
path, mode = sys.argv[1], sys.argv[2]
conf = {}
try:
    with open(path, encoding="utf-8") as fh:
        conf = json.load(fh) or {}
except (OSError, ValueError):
    pass
conf["mode"] = mode
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(conf, fh)
os.replace(tmp, path)
PY
  chown -R "$RUN_USER:$RUN_USER" "$(dirname "$MOTOR_CONF")"
  echo "[install] motor drive → $MOTOR ($MOTOR_CONF)"
fi

EXTRA_ARGS=""
if [[ $STRICT -eq 1 ]]; then
  # Fail loudly rather than pretending the motor moved.
  EXTRA_ARGS="--strict-gpio"
fi
EXTRA_ARGS="$EXTRA_ARGS --role $ROLE"

# --- networking (paxnet) -----------------------------------------------------
# Hostname + mDNS so nodes address each other as `pax-*.local` and survive a
# move to a network with different IPs; NetworkManager profiles for the router
# and the fallback hotspot; a sudoers rule so the unprivileged agent may drive
# nmcli. All of it is skipped with --no-net.
CONF=/etc/paxnet.conf
if [[ $NET -eq 1 ]]; then
  if ! command -v nmcli >/dev/null 2>&1; then
    echo "error: nmcli not found. paxnet needs NetworkManager (Raspberry Pi OS Bookworm or newer)." >&2
    echo "       Re-run with --no-net to install the motor agent without Wi-Fi management." >&2
    exit 1
  fi
  if ! systemctl is-active --quiet NetworkManager; then
    echo "error: NetworkManager is installed but not running (dhcpcd-based image?)." >&2
    echo "       Switch to NetworkManager (raspi-config → Advanced → Network Config) or use --no-net." >&2
    exit 1
  fi

  echo "[install] installing avahi (mDNS) for .local hostnames"
  apt-get install -y -qq avahi-daemon >/dev/null
  systemctl enable --now avahi-daemon >/dev/null 2>&1 || true

  # Hostname: default to the role if none given and the current one is generic.
  if [[ -z "$HOSTNAME_NEW" ]]; then
    CUR="$(hostname)"
    if [[ "$CUR" == "raspberrypi" || -z "$CUR" ]]; then
      HOSTNAME_NEW="pax-$ROLE"
    fi
  fi
  if [[ -n "$HOSTNAME_NEW" ]]; then
    if [[ ! "$HOSTNAME_NEW" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
      echo "error: --hostname must be lowercase letters, digits and dashes (e.g. pax-slave-2)" >&2
      exit 2
    fi
    echo "[install] hostname → $HOSTNAME_NEW ($HOSTNAME_NEW.local)"
    hostnamectl set-hostname "$HOSTNAME_NEW"
    # Keep sudo happy: /etc/hosts must resolve the new name.
    if grep -qE '^127\.0\.1\.1\s' /etc/hosts; then
      sed -i -E "s/^127\.0\.1\.1\s.*/127.0.1.1\t$HOSTNAME_NEW/" /etc/hosts
    else
      printf '127.0.1.1\t%s\n' "$HOSTNAME_NEW" >> /etc/hosts
    fi
  fi

  # Wi-Fi interface + a stable hotspot SSID derived from its MAC.
  IFACE="$(nmcli -t -f DEVICE,TYPE dev status 2>/dev/null | awk -F: '$2=="wifi"{print $1; exit}')"
  IFACE="${IFACE:-wlan0}"
  MAC="$(tr -d ':' < "/sys/class/net/$IFACE/address" 2>/dev/null | tr 'a-f' 'A-F' || true)"
  DEFAULT_AP_SSID="PAX-Setup-${MAC: -4}"
  [[ -z "$MAC" ]] && DEFAULT_AP_SSID="PAX-Setup"

  # Existing config wins for the hotspot password: reinstalling must never
  # rotate it, or every slave provisioned against it would be orphaned.
  OLD_PSK=""; OLD_SSID=""; OLD_MODE="auto"
  if [[ -f "$CONF" ]]; then
    OLD_PSK="$(awk -F'=' '/^ap_psk/{gsub(/^[ \t]+|[ \t]+$/,"",$2); print $2}' "$CONF")"
    OLD_SSID="$(awk -F'=' '/^ap_ssid/{gsub(/^[ \t]+|[ \t]+$/,"",$2); print $2}' "$CONF")"
    OLD_MODE="$(awk -F'=' '/^mode/{gsub(/^[ \t]+|[ \t]+$/,"",$2); print $2}' "$CONF")"
    OLD_MODE="${OLD_MODE:-auto}"
  fi

  if [[ "$ROLE" == "master" ]]; then
    AP_SSID="${AP_SSID:-${OLD_SSID:-$DEFAULT_AP_SSID}}"
    if [[ -z "$AP_PSK" ]]; then
      AP_PSK="$OLD_PSK"
    fi
    if [[ -z "$AP_PSK" ]]; then
      # 12 chars from a-z0-9: easy to type on a phone, ~62 bits.
      AP_PSK="$(tr -dc 'a-z0-9' < /dev/urandom | head -c 12)"
      echo "[install] generated hotspot password"
    fi
  else
    # Slave: hotspot creds are the MASTER's. Optional here; the agent pulls
    # them from the master on first registration if left blank.
    AP_SSID="${AP_SSID:-$OLD_SSID}"
    AP_PSK="${AP_PSK:-$OLD_PSK}"
  fi

  if [[ -n "$AP_PSK" && ${#AP_PSK} -lt 8 ]]; then
    echo "error: --ap-psk must be at least 8 characters" >&2
    exit 2
  fi

  umask 077
  cat > "$CONF" <<EOF
[pax]
role = $ROLE
mode = $OLD_MODE
ap_ssid = $AP_SSID
ap_psk = $AP_PSK
iface = $IFACE
master_host = $MASTER_HOST
EOF
  chmod 600 "$CONF"
  umask 022
  echo "[install] wrote $CONF (role=$ROLE iface=$IFACE hotspot=$AP_SSID)"

  # Let the agent's user run nmcli and rewrite paxnet.conf without a password.
  # Scoped to exactly these binaries; nothing else gains privileges.
  SUDOERS=/etc/sudoers.d/paxnet
  cat > "$SUDOERS" <<EOF
# Installed by PAX install.sh — lets the paternoster agent manage Wi-Fi.
$RUN_USER ALL=(root) NOPASSWD: /usr/bin/nmcli, /usr/bin/tee $CONF, /usr/bin/chmod 600 $CONF
EOF
  chmod 440 "$SUDOERS"
  if ! visudo -cf "$SUDOERS" >/dev/null; then
    echo "error: generated sudoers rule failed validation; removing" >&2
    rm -f "$SUDOERS"
    exit 1
  fi
  echo "[install] sudoers rule for nmcli installed"

  # NetworkManager profiles. The watchdog brings `pax-ap` up itself, so it must
  # NOT autoconnect (or a master would boot straight into hotspot mode and
  # never try the router).
  if [[ "$ROLE" == "master" ]]; then
    if nmcli -t -f NAME con show | grep -qx "pax-ap"; then
      nmcli con modify pax-ap 802-11-wireless.ssid "$AP_SSID" wifi-sec.psk "$AP_PSK" >/dev/null
    else
      nmcli con add type wifi ifname "$IFACE" con-name pax-ap ssid "$AP_SSID" \
        802-11-wireless.mode ap 802-11-wireless.band bg \
        ipv4.method shared ipv6.method disabled \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$AP_PSK" \
        connection.autoconnect no >/dev/null
    fi
    echo "[install] hotspot profile 'pax-ap' ready ($AP_SSID, gateway 10.42.0.1)"
  elif [[ -n "$AP_SSID" && -n "$AP_PSK" ]]; then
    if nmcli -t -f NAME con show | grep -qx "pax-master-ap"; then
      nmcli con modify pax-master-ap 802-11-wireless.ssid "$AP_SSID" wifi-sec.psk "$AP_PSK" >/dev/null
    else
      nmcli con add type wifi ifname "$IFACE" con-name pax-master-ap ssid "$AP_SSID" \
        wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$AP_PSK" \
        connection.autoconnect yes connection.autoconnect-priority 10 \
        connection.autoconnect-retries 0 >/dev/null
    fi
    echo "[install] fallback profile 'pax-master-ap' ready (joins $AP_SSID when the router is gone)"
  else
    echo "[install] no master hotspot credentials given — slave will fetch them from $MASTER_HOST on first contact"
  fi

  # Adopt whatever Wi-Fi the imager/user already configured as `pax-router`,
  # so the fallback logic has a router to fall back FROM on the very first boot.
  if ! nmcli -t -f NAME con show | grep -qx "pax-router"; then
    CURRENT="$(nmcli -t -f NAME,TYPE,DEVICE con show --active | awk -F: -v i="$IFACE" '$2=="802-11-wireless" && $3==i {print $1; exit}')"
    if [[ -n "$CURRENT" && "$CURRENT" != "pax-ap" && "$CURRENT" != "pax-master-ap" ]]; then
      nmcli con modify "$CURRENT" connection.id pax-router connection.autoconnect yes \
        connection.autoconnect-priority 100 connection.autoconnect-retries 0 >/dev/null
      echo "[install] adopted current Wi-Fi '$CURRENT' as 'pax-router'"
    fi
  fi
else
  echo "[install] --no-net: skipping hostname, mDNS, hotspot and sudoers setup"
  EXTRA_ARGS="$EXTRA_ARGS --no-net"
fi

# --- unit file --------------------------------------------------------------
UNIT=/etc/systemd/system/paternoster-agent.service
python3 - "$DIR/paternoster-agent.service" "$UNIT" <<PY
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
for key, val in {
    "__USER__": """$RUN_USER""",
    "__DIR__": """$DIR""",
    "__NAME__": """$NAME""",
    "__SHELVES__": """$SHELVES""",
    "__PORT__": """$PORT""",
    "__EXTRA_ARGS__": """$EXTRA_ARGS""",
    "__ENVIRONMENT__": """$ENVIRONMENT""",
}.items():
    text = text.replace(key, val)
open(dst, "w").write(text)
PY

# Only directive lines matter — the header comment legitimately mentions
# "__PLACEHOLDERS__", so a blanket grep for "__" would always false-positive.
if grep -vE '^\s*#' "$UNIT" | grep -q "__"; then
  echo "error: unit still contains placeholders; refusing to enable" >&2
  grep -vE '^\s*#' "$UNIT" | grep -n "__" >&2
  exit 1
fi

systemctl daemon-reload
systemctl enable paternoster-agent >/dev/null 2>&1 || true
systemctl restart paternoster-agent

sleep 3
if systemctl is-active --quiet paternoster-agent; then
  echo "[install] service is running"
  echo "[install] verify GPIO mode with:"
  echo "           journalctl -u paternoster-agent -n 20 --no-pager | grep -i -e gpio -e simulation"
  if [[ $NEED_REBOOT -eq 1 ]]; then
    echo
    echo "================================================================"
    echo " REBOOT NEEDED: the hardware PWM overlay was removed from the"
    echo " boot config. Until the Pi reboots GPIO 12/13 stay kernel-owned"
    echo " and the agent will report 'GPIO busy'.         sudo reboot"
    echo "================================================================"
  fi
  if [[ $NET -eq 1 ]]; then
    echo
    echo "================================================================"
    echo " Networking"
    echo "   role       : $ROLE"
    echo "   hostname   : $(hostname).local"
    if [[ "$ROLE" == "master" ]]; then
      echo "   hotspot    : $AP_SSID"
      echo "   password   : $AP_PSK        <-- write this down"
      echo "   app (AP)   : http://$(hostname).local  or  http://10.42.0.1"
      echo
      echo " If the router is unreachable for 45 s after boot, the master"
      echo " starts this hotspot. Join it on a phone and open the app to pick"
      echo " a new router — slaves are re-provisioned automatically."
      echo
      echo " Install slaves with:"
      echo "   sudo ./install.sh --role slave --hostname pax-slave-1 --master $(hostname).local \\"
      echo "        --ap-ssid '$AP_SSID' --ap-psk '$AP_PSK'"
    else
      echo "   master     : $MASTER_HOST"
      echo "   fallback   : ${AP_SSID:-<fetched from master>}"
    fi
    echo "   debug      : python3 $DIR/paxnet.py status | scan"
    echo "================================================================"
  fi
else
  echo "[install] SERVICE FAILED TO START — recent log:" >&2
  journalctl -u paternoster-agent -n 20 --no-pager >&2
  exit 1
fi
