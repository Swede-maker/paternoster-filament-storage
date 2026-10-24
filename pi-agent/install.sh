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
#                       /var/lib/pax-agent/motor.json (other tuning kept).
#                       "servo" = any pulse + direction drive (see --pulse-drive)
#   --pulse-drive integrated-servo|ac-servo|closed-loop-stepper
#                       what is on the PUL/DIR lines: iSV57T-class integrated
#                       servo (default on gpio), A6-RS-class AC servo (default on
#                       esp32) or a CL86Y-class closed-loop stepper. Implies
#                       --motor servo; ac-servo / closed-loop-stepper imply
#                       --servo-driver esp32 unless you say otherwise
#   --servo-driver gpio|esp32
#                       pulses from the Pi header (gpio) or from an ESP32
#                       running esp32-servo/ (one firmware for every drive;
#                       the agent sends it the profile at runtime)
#   --esp32-link usb|uart|wifi
#                       usb  = ESP32 on a USB cable (/dev/ttyUSB0, default)
#                       uart = ESP32 on GPIO14/15 (/dev/serial0); frees the
#                       UART from the login console and enables it (reboot)
#                       wifi = a STANDALONE ESP32 carousel with no Pi of its
#                       own; needs --esp32-host
#   --esp32-host <host[:port]>
#                       the Wi-Fi board, e.g. pax-esp32-1a2b.local (port 8766)
#   --instance <name>   install this as an ADDITIONAL agent service on a Pi
#                       that already runs one (the master): service
#                       paternoster-agent-<name>, own motor.json, own --port
#                       (8767 unless given), role "esp32" (registers with the
#                       local master so new Wi-Fi credentials reach the board).
#                       Typical standalone-ESP32 install, run ON THE MASTER:
#   sudo ./install.sh --instance hall-2 --name "Hall 2" --shelves 12 \
#                     --pulse-drive ac-servo --esp32-link wifi \
#                     --esp32-host pax-esp32-1a2b.local
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
PULSE_DRIVE=""
SERVO_DRIVER=""
ESP32_LINK=""
ESP32_HOST=""
INSTANCE=""
PORT_SET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --motor) MOTOR="$2"; shift 2 ;;
    --pulse-drive) PULSE_DRIVE="$2"; shift 2 ;;
    --servo-driver) SERVO_DRIVER="$2"; shift 2 ;;
    --esp32-link) ESP32_LINK="$2"; shift 2 ;;
    --esp32-host) ESP32_HOST="$2"; shift 2 ;;
    --instance) INSTANCE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --shelves) SHELVES="$2"; shift 2 ;;
    --port) PORT="$2"; PORT_SET=1; shift 2 ;;
    --allow-simulation) STRICT=0; shift ;;
    --role) ROLE="$2"; shift 2 ;;
    --hostname) HOSTNAME_NEW="$2"; shift 2 ;;
    --master) MASTER_HOST="$2"; shift 2 ;;
    --ap-ssid) AP_SSID="$2"; shift 2 ;;
    --ap-psk) AP_PSK="$2"; shift 2 ;;
    --no-net) NET=0; shift ;;
    -h|--help) sed -n '2,49p' "$0"; exit 0 ;;
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
if [[ -n "$SERVO_DRIVER" && "$SERVO_DRIVER" != "gpio" && "$SERVO_DRIVER" != "esp32" ]]; then
  echo "error: --servo-driver must be gpio or esp32" >&2
  exit 2
fi
if [[ -n "$ESP32_LINK" && "$ESP32_LINK" != "usb" && "$ESP32_LINK" != "uart" && "$ESP32_LINK" != "wifi" ]]; then
  echo "error: --esp32-link must be usb, uart or wifi" >&2
  exit 2
fi
if [[ -n "$ESP32_HOST" && -z "$ESP32_LINK" ]]; then
  ESP32_LINK="wifi"
fi
if [[ "$ESP32_LINK" == "wifi" && -z "$ESP32_HOST" ]]; then
  echo "error: --esp32-link wifi needs --esp32-host <pax-esp32-xxxx.local[:8766]>" >&2
  exit 2
fi
if [[ -n "$ESP32_HOST" && ! "$ESP32_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,120}(:[0-9]{1,5})?$ ]]; then
  echo "error: --esp32-host must be a hostname or IP, optionally :port" >&2
  exit 2
fi
if [[ -n "$INSTANCE" ]]; then
  if [[ ! "$INSTANCE" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; then
    echo "error: --instance must be 1-32 chars of a-z 0-9 -" >&2
    exit 2
  fi
  if [[ "$ESP32_LINK" != "wifi" ]]; then
    echo "error: --instance is for an additional Wi-Fi ESP32 carousel (--esp32-link wifi --esp32-host ...)" >&2
    exit 2
  fi
  # The primary agent owns 8765; a second one needs its own WebSocket port.
  if [[ $PORT_SET -eq 0 ]]; then
    PORT=8767
  elif [[ "$PORT" == "8765" ]]; then
    echo "error: --instance cannot use port 8765 (the primary agent's); pick another --port" >&2
    exit 2
  fi
fi
if [[ -n "$PULSE_DRIVE" && "$PULSE_DRIVE" != "integrated-servo" && "$PULSE_DRIVE" != "ac-servo" && "$PULSE_DRIVE" != "closed-loop-stepper" ]]; then
  echo "error: --pulse-drive must be integrated-servo, ac-servo or closed-loop-stepper" >&2
  exit 2
fi
if [[ -n "$PULSE_DRIVE" ]]; then
  if [[ "$MOTOR" == "dc" ]]; then
    echo "error: --pulse-drive needs --motor servo (a PUL/DIR drive)" >&2
    exit 2
  fi
  MOTOR="servo"
  # A separate drive (AC servo / closed-loop stepper) is normally pulsed by
  # the ESP32 controller; the integrated servo by the Pi header.
  if [[ -z "$SERVO_DRIVER" && "$PULSE_DRIVE" != "integrated-servo" ]]; then
    SERVO_DRIVER="esp32"
  fi
fi
if [[ -n "$ESP32_LINK" && -z "$SERVO_DRIVER" ]]; then
  SERVO_DRIVER="esp32"
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
apt-get install -y -qq python3-websockets python3-gpiozero python3-serial >/dev/null

# --- ESP32 servo controller link ---------------------------------------------
# The agent opens /dev/ttyUSB0 (USB) or /dev/serial0 (header UART) itself, so
# the service user needs the dialout group either way. The UART additionally
# has to be taken away from the login console and switched on; on the Pi 3/4/
# Zero W the full UART is also moved back to GPIO14/15 (Bluetooth gets the
# mini-UART). All of that is config.txt/cmdline.txt work and needs a reboot.
if getent group dialout >/dev/null 2>&1; then
  usermod -aG dialout "$RUN_USER"
  echo "[install] added $RUN_USER to the dialout group (serial ports)"
fi
NEED_REBOOT_UART=0
if [[ "$ESP32_LINK" == "uart" ]]; then
  if command -v raspi-config >/dev/null 2>&1; then
    # do_serial_cons 1 = console OFF, do_serial_hw 0 = UART ON (nonint numbering)
    raspi-config nonint do_serial_cons 1 || true
    raspi-config nonint do_serial_hw 0 || true
  fi
  for conf in /boot/firmware/config.txt /boot/config.txt; do
    [[ -f "$conf" ]] || continue
    grep -q '^enable_uart=1' "$conf" || echo 'enable_uart=1' >> "$conf"
    MODEL_UART="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)"
    if [[ "$MODEL_UART" != *"Raspberry Pi 5"* ]]; then
      grep -q '^dtoverlay=disable-bt' "$conf" || echo 'dtoverlay=disable-bt' >> "$conf"
      systemctl disable hciuart >/dev/null 2>&1 || true
    fi
    break
  done
  for cmd in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
    [[ -f "$cmd" ]] || continue
    sed -i -E 's/console=serial0,[0-9]+ ?//; s/console=ttyAMA0,[0-9]+ ?//; s/console=ttyS0,[0-9]+ ?//' "$cmd"
    break
  done
  NEED_REBOOT_UART=1
  echo "[install] UART on GPIO14/15 enabled for the ESP32 link (serial console removed) — reboot required"
fi

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
if [[ -n "$INSTANCE" ]]; then
  # A second agent on this Pi must never share the first one's drive settings.
  MOTOR_CONF=/var/lib/pax-agent/$INSTANCE/motor.json
fi
if [[ -n "$MOTOR" || -n "$PULSE_DRIVE" || -n "$SERVO_DRIVER" || -n "$ESP32_LINK" || -n "$ESP32_HOST" ]]; then
  mkdir -p "$(dirname "$MOTOR_CONF")"
  python3 - "$MOTOR_CONF" "$MOTOR" "$SERVO_DRIVER" "$ESP32_LINK" "$PULSE_DRIVE" "$ESP32_HOST" <<'PY'
import json, os, sys
path, mode, driver, link, pulse_drive, esp32_host = sys.argv[1:7]
conf = {}
try:
    with open(path, encoding="utf-8") as fh:
        conf = json.load(fh) or {}
except (OSError, ValueError):
    pass
if mode:
    conf["mode"] = mode
if driver:
    conf["servoDriver"] = driver
    if driver == "esp32" and not mode:
        conf["mode"] = "servo"  # an ESP32 controller is only ever a PUL/DIR drive
if link:
    conf["esp32Link"] = link
if esp32_host:
    conf["esp32Port"] = esp32_host  # host[:port] rides in the "port" slot for the wifi link
if pulse_drive:
    conf["pulseDrive"] = pulse_drive
    # The profile's own polarities apply until the app overrides them.
    conf.pop("enableActiveLow", None)
    conf.pop("alarmActiveLow", None)
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    json.dump(conf, fh)
os.replace(tmp, path)
PY
  chown -R "$RUN_USER:$RUN_USER" "$(dirname "$MOTOR_CONF")"
  echo "[install] motor drive → ${MOTOR:-unchanged}, PUL/DIR drive → ${PULSE_DRIVE:-unchanged}, controller → ${SERVO_DRIVER:-unchanged}, ESP32 link → ${ESP32_LINK:-unchanged}${ESP32_HOST:+ @ $ESP32_HOST} ($MOTOR_CONF)"
fi

EXTRA_ARGS=""
if [[ $STRICT -eq 1 ]]; then
  # Fail loudly rather than pretending the motor moved.
  EXTRA_ARGS="--strict-gpio"
fi
if [[ -n "$INSTANCE" ]]; then
  # Role "esp32": no nmcli work of its own (the primary agent owns this Pi's
  # Wi-Fi); registers with the local master so credential pushes reach the board.
  ROLE="esp32"
  NET=0
  EXTRA_ARGS="$EXTRA_ARGS --role esp32 --master 127.0.0.1:8765 --motor-conf $MOTOR_CONF"
else
  EXTRA_ARGS="$EXTRA_ARGS --role $ROLE"
fi

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
elif [[ -n "$INSTANCE" ]]; then
  echo "[install] --instance: Wi-Fi/hostname setup belongs to the primary agent on this Pi — skipped"
else
  echo "[install] --no-net: skipping hostname, mDNS, hotspot and sudoers setup"
  EXTRA_ARGS="$EXTRA_ARGS --no-net"
fi

# --- unit file --------------------------------------------------------------
SERVICE=paternoster-agent${INSTANCE:+-$INSTANCE}
UNIT=/etc/systemd/system/$SERVICE.service
python3 - "$DIR/paternoster-agent.service" "$UNIT" "$INSTANCE" <<PY
import sys
src, dst, instance = sys.argv[1], sys.argv[2], sys.argv[3]
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
if instance:
    text = text.replace("Description=PAX paternoster GPIO agent",
                        f"Description=PAX paternoster agent ({instance}, Wi-Fi ESP32 carousel)")
    # Come up after the primary agent so registration succeeds first try.
    text = text.replace("After=NetworkManager.service network.target",
                        "After=NetworkManager.service network.target paternoster-agent.service")
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
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

sleep 3
if systemctl is-active --quiet "$SERVICE"; then
  echo "[install] service $SERVICE is running"
  echo "[install] verify GPIO mode with:"
  echo "           journalctl -u $SERVICE -n 20 --no-pager | grep -i -e gpio -e simulation"
  if [[ $NEED_REBOOT -eq 1 ]]; then
    echo
    echo "================================================================"
    echo " REBOOT NEEDED: the hardware PWM overlay was removed from the"
    echo " boot config. Until the Pi reboots GPIO 12/13 stay kernel-owned"
    echo " and the agent will report 'GPIO busy'.         sudo reboot"
    echo "================================================================"
  fi
  if [[ $NEED_REBOOT_UART -eq 1 ]]; then
    echo
    echo "================================================================"
    echo " REBOOT NEEDED: the header UART (GPIO14 TXD / GPIO15 RXD) was"
    echo " freed from the login console for the ESP32 link. Wire"
    echo "   Pi GPIO14 (pin 8)  -> ESP32 GPIO21 (RX)"
    echo "   Pi GPIO15 (pin 10) <- ESP32 GPIO22 (TX)"
    echo "   Pi GND (pin 6)     -- ESP32 GND"
    echo " then:                                           sudo reboot"
    echo "================================================================"
  fi
  if [[ "$ESP32_LINK" == "wifi" ]]; then
    echo
    echo "================================================================"
    echo " Standalone Wi-Fi ESP32 carousel"
    echo "   board      : $ESP32_HOST"
    echo "   agent      : $SERVICE on ws://$(hostname).local:$PORT  <-- add this as the"
    echo "                carousel's address in the app (Settings → Carousels)"
    echo
    echo " First time only, on the board's USB console (pio device monitor):"
    echo "   WIFI <router ssid> <password>"
    echo "   WIFIAP <master hotspot ssid> <hotspot password>   (fallback)"
    echo "   NET                                              (check)"
    echo " After that the master pushes new credentials itself, and firmware"
    echo " updates go over the air: http://$ESP32_HOST/  (user admin)."
    echo "   link log   : journalctl -u $SERVICE -f | grep -i esp32"
    echo "================================================================"
  elif [[ "$SERVO_DRIVER" == "esp32" ]]; then
    echo
    echo "[install] motor controller = ESP32 (${PULSE_DRIVE:-profile set from the app}). Flash esp32-servo/ once"
    echo "          (one firmware for AC servo / integrated servo / closed-loop stepper; the agent"
    echo "          sends the profile), see esp32-servo/README.md, then check the link:"
    echo "          journalctl -u $SERVICE -f | grep -i esp32"
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
  echo "[install] SERVICE $SERVICE FAILED TO START — recent log:" >&2
  journalctl -u "$SERVICE" -n 20 --no-pager >&2
  exit 1
fi
