#!/usr/bin/env bash
# Runs as ROOT from paternoster-agent.service (ExecStartPre=+...) right before
# the agent starts. Its job is to make sure nothing from a previous life of the
# agent can make this start fail with "address in use" or "GPIO busy":
#
#   1. Stop any stray agent: one started by hand for testing, one left behind
#      by a crashed update, or one that lost the port but still holds its GPIO
#      lines. The pin numbers are compile-time constants, so two agents on one
#      Pi can never both drive hardware — every other paternoster_agent.py is
#      fair game, as is any other process holding /dev/gpiochip*.
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
# Every other copy of the agent, whatever port it uses (or none, if it never
# got as far as binding). Exclude ourselves and systemd's about-to-start unit.
OTHER="$(pgrep -f 'paternoster_agent\.py' 2>/dev/null | grep -vx "$$" || true)"
if [[ -n "$OTHER" ]]; then
  log "stopping other agent process(es): $(echo "$OTHER" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -TERM $OTHER 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f 'paternoster_agent\.py' >/dev/null 2>&1 || break
    sleep 0.3
  done
  # shellcheck disable=SC2086
  pkill -KILL -f 'paternoster_agent\.py' 2>/dev/null || true
fi

# Anything else still holding a GPIO chip is a leftover lgpio user (a python
# REPL, a test script, `pinctrl` left running). Name it, then stop it, so the
# agent does not open to "GPIO busy — held by 'lg'".
if command -v fuser >/dev/null 2>&1 && ls /dev/gpiochip* >/dev/null 2>&1; then
  HOLDERS="$(fuser /dev/gpiochip* 2>/dev/null | tr -s ' \n' ' ' || true)"
  for pid in $HOLDERS; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$pid" == "$$" ]] && continue
    cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"
    log "stopping pid $pid holding /dev/gpiochip*: ${cmd:-?}"
    kill -TERM "$pid" 2>/dev/null || true
  done
  if [[ -n "${HOLDERS// /}" ]]; then
    sleep 1
    fuser -k -KILL /dev/gpiochip* >/dev/null 2>&1 || true
  fi
fi

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
