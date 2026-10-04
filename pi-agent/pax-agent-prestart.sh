#!/usr/bin/env bash
# Runs as ROOT from paternoster-agent.service (ExecStartPre=+...) right before
# the agent starts. Its job is to make sure nothing from a previous life of the
# agent can make this start fail with "address in use" or "GPIO busy":
#
#   1. Stop a stray agent on this port: one started by hand for testing, or
#      one left behind by a crashed update. Matched by PORT, not by process
#      name, so a second agent on another port (two units, one Pi) survives.
#   2. Reset the hardware-PWM channels for the servo PUL pins. A channel left
#      exported and enabled by a previous run (or by a `sudo` test) keeps its
#      old period/duty and, worse, is owned by root with mode 644, so the
#      agent running as a normal user gets EACCES, falls back to software
#      PWM on pins the overlay owns, and lgpio answers "GPIO busy".
#   3. Hand /sys/class/pwm to the gpio group so the agent may use it.
#
# Everything here is best-effort: a Pi without the pwm overlay (DC build) or
# without a stray process must not fail the start. Never `exit 1`.
#
# Usage: pax-agent-prestart <port>

PORT="${1:-8765}"
log() { echo "[prestart] $*"; }

# --- 1. stray agent ----------------------------------------------------------
if command -v fuser >/dev/null 2>&1; then
  PIDS="$(fuser "$PORT"/tcp 2>/dev/null | tr -s ' ' || true)"
  if [[ -n "${PIDS// /}" ]]; then
    log "stopping stray process on port $PORT (pid$PIDS)"
    fuser -k -TERM "$PORT"/tcp >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      fuser "$PORT"/tcp >/dev/null 2>&1 || break
      sleep 0.3
    done
    if fuser "$PORT"/tcp >/dev/null 2>&1; then
      log "stray process ignored SIGTERM, killing"
      fuser -k -KILL "$PORT"/tcp >/dev/null 2>&1 || true
      sleep 0.5
    fi
  fi
fi
# An agent that crashed between claiming GPIO and binding the port holds the
# gpiochip but not the port. Only our own agent on this port is fair game.
pkill -TERM -f "paternoster_agent\.py.*--port ${PORT}( |$)" 2>/dev/null && sleep 1 || true

# --- 2 + 3. hardware PWM channels ------------------------------------------------
PWM_ROOT=/sys/class/pwm
if [[ -d "$PWM_ROOT" ]]; then
  for chip in "$PWM_ROOT"/pwmchip*; do
    [[ -d "$chip" ]] || continue
    npwm="$(cat "$chip/npwm" 2>/dev/null || echo 0)"
    [[ "$npwm" -ge 2 ]] || continue
    for ch in 0 1; do
      if [[ -d "$chip/pwm$ch" ]]; then
        # Disable before unexport so the pin is left low, not mid-pulse.
        echo 0 > "$chip/pwm$ch/duty_cycle" 2>/dev/null || true
        echo 0 > "$chip/pwm$ch/enable" 2>/dev/null || true
        if echo "$ch" > "$chip/unexport" 2>/dev/null; then
          log "reset $(basename "$chip") channel $ch"
        fi
      fi
    done
  done
  # Group ownership for the chips themselves (export/unexport/npwm). The
  # channel directories are created on export and chowned by udev; the rule
  # from install.sh (or Raspberry Pi OS's own 99-com.rules) handles those.
  # Follow the symlinks: /sys/class/pwm/* point into /sys/devices/....
  for chip in "$PWM_ROOT"/pwmchip*; do
    real="$(readlink -f "$chip" 2>/dev/null)" || continue
    chown -R root:gpio "$real" 2>/dev/null || true
    chmod -R g+rwX "$real" 2>/dev/null || true
  done
fi

exit 0
