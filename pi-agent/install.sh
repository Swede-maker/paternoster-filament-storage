#!/usr/bin/env bash
#
# Installs the paternoster agent as a systemd service.
#
#   sudo ./install.sh                      # defaults: "Paternoster 1", 9 shelves, port 8765
#   sudo ./install.sh --name "Unit 2" --shelves 12 --port 8766
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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --shelves) SHELVES="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --allow-simulation) STRICT=0; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

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
# Pi 5 uses a different GPIO chip; gpiozero needs lgpio to drive it. Without
# this the agent cannot init GPIO and silently simulates motion instead.
ENVIRONMENT=""
MODEL="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo unknown)"
echo "[install] detected board: $MODEL"
if [[ "$MODEL" == *"Raspberry Pi 5"* ]]; then
  echo "[install] Pi 5 detected — installing lgpio pin factory"
  apt-get install -y -qq python3-lgpio >/dev/null
  ENVIRONMENT='Environment=GPIOZERO_PIN_FACTORY=lgpio'
fi

# --- gpio access ------------------------------------------------------------
if getent group gpio >/dev/null 2>&1; then
  usermod -aG gpio "$RUN_USER"
  echo "[install] added $RUN_USER to the gpio group"
fi

EXTRA_ARGS=""
if [[ $STRICT -eq 1 ]]; then
  # Fail loudly rather than pretending the motor moved.
  EXTRA_ARGS="--strict-gpio"
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
else
  echo "[install] SERVICE FAILED TO START — recent log:" >&2
  journalctl -u paternoster-agent -n 20 --no-pager >&2
  exit 1
fi
