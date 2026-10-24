#!/usr/bin/env bash
#
# Installs the PAX webcam streamer as a systemd service.
#
#   sudo ./install-camera.sh                                  # /dev/video0, port 8780, 640x480 @ 15 fps
#   sudo ./install-camera.sh --device /dev/video2 --size 1280x720 --fps 10
#   sudo ./install-camera.sh --uninstall
#
# Plug the USB webcam into the Pi first (any UVC webcam works). List cameras with:
#   v4l2-ctl --list-devices
#
set -euo pipefail

DEVICE=/dev/video0
PORT=8780
SIZE=640x480
FPS=15
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) DEVICE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --size) SIZE="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "error: run with sudo" >&2
  exit 1
fi

UNIT=/etc/systemd/system/pax-camera.service

if [[ $UNINSTALL -eq 1 ]]; then
  systemctl disable --now pax-camera >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl daemon-reload
  echo "[camera] removed"
  exit 0
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="${SUDO_USER:-$(logname 2>/dev/null || echo root)}"

echo "[camera] installing ffmpeg + v4l-utils"
apt-get install -y -qq ffmpeg v4l-utils >/dev/null
usermod -aG video "$RUN_USER"

sed -e "s|__USER__|$RUN_USER|" -e "s|__DIR__|$DIR|" -e "s|__DEVICE__|$DEVICE|" \
    -e "s|__PORT__|$PORT|" -e "s|__SIZE__|$SIZE|" -e "s|__FPS__|$FPS|" \
    "$DIR/pax-camera.service" > "$UNIT"

systemctl daemon-reload
systemctl enable pax-camera >/dev/null 2>&1 || true
systemctl restart pax-camera
sleep 2

if systemctl is-active --quiet pax-camera; then
  echo "[camera] running on http://$(hostname).local:$PORT/stream"
  if [[ ! -e "$DEVICE" ]]; then
    echo "[camera] note: no webcam at $DEVICE yet — plug it in; the stream starts when the app opens it."
  fi
  echo "[camera] in the app: Settings -> Webcam -> turn on (port $PORT)"
else
  echo "[camera] FAILED TO START — recent log:" >&2
  journalctl -u pax-camera -n 20 --no-pager >&2
  exit 1
fi
