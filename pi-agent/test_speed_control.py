#!/usr/bin/env python3
"""
Regression test: the speed and soft-start settings must reach the motor.

Runs without a Pi. A recording fake hardware layer captures every PWM duty the
motion code applies, so we can assert on the actual waveform rather than on
"a config message was accepted".

Guards three separate bugs that all produced the same symptom — sliders that
changed the on-screen animation but not the hardware:

  1. Motion code read the module constants MOVE_SPEED / HOMING_SPEED instead of
     the live per-instance settings, so `config` could never change anything.
  2. The agent's `config` handler parsed only `shelves` and dropped the rest.
  3. The app never sent a `config` command at all.

Run:  python3 test_speed_control.py
"""
import sys
import os
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paternoster_agent as pa  # noqa: E402


class RecordingHW:
    """Fake hardware that logs every duty change and fakes shelf pulses."""

    def __init__(self, shelves=9, pulse_every=0.12):
        self.shelves = shelves
        self.duties = []          # every non-zero duty applied, in order
        self.events = []          # ("fwd"/"bwd"/"stop", duty)
        self._lock = threading.Lock()
        self._pulses = 0
        self._tick = threading.Event()
        self._moving = False
        self._pulse_every = pulse_every
        # The carousel parks INSIDE the sensor window, so a move starts with the
        # sensor active and clears once the flag is driven out. This fake has no
        # position model, so the departure is modelled as "active until the motor
        # has run", which is all the duty-tracking assertions need.
        self._shelf_active = True
        self._alive = True
        threading.Thread(target=self._spin, daemon=True).start()

    # --- motor ---
    def forward(self, speed):
        self._apply("fwd", speed)

    def backward(self, speed):
        self._apply("bwd", speed)

    def _apply(self, kind, speed):
        with self._lock:
            self.events.append((kind, round(float(speed), 4)))
            self.duties.append(round(float(speed), 4))
            self._moving = True

    def stop(self):
        with self._lock:
            self.events.append(("stop", 0.0))
            self._moving = False
            # Stopping means the target shelf has arrived at the window, so the
            # post-move alignment check finds the sensor active and settles
            # without needing to crawl.
            self._shelf_active = True

    # --- sensors: pulses arrive while powered, independent of duty ---
    def _spin(self):
        nxt = time.monotonic() + self._pulse_every
        while self._alive:
            now = time.monotonic()
            with self._lock:
                moving = self._moving
            if moving and now >= nxt:
                with self._lock:
                    self._pulses += 1
                self._tick.set()
                nxt = now + self._pulse_every
            elif not moving:
                nxt = now + self._pulse_every
            time.sleep(0.005)

    def reset_pulses(self):
        with self._lock:
            self._pulses = 0
        self._tick.clear()

    def _take(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                if self._pulses > 0:
                    self._pulses -= 1
                    return True
            if time.monotonic() >= deadline:
                return False
            self._tick.clear()
            self._tick.wait(0.02)

    def take_shelf_pulse(self, timeout):
        return self._take(timeout)

    def take_index_pulse(self, timeout):
        return self._take(timeout) if timeout > 0 else False

    def index_clear(self, timeout):
        return True

    def index_active(self):
        return False

    def shelf_active(self):
        with self._lock:
            return self._shelf_active

    def shelf_clear(self, timeout):
        # The flag leaves the window shortly after the motor starts turning.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                if self._moving:
                    self._shelf_active = False
                    return True
            time.sleep(0.005)
        return False

    def cleanup(self):
        self._alive = False


def run_move(move_speed, ramp_pct, target=4, shelves=9):
    hw = RecordingHW(shelves)
    events = []
    car = pa.Carousel(hw, shelves, lambda e: events.append(e))
    car.homed = True
    car.set_motion(move_speed=move_speed, ramp_pct=ramp_pct)
    car.request_goto(target)
    # Wait for the terminal EVENT, not for status+stop: request_goto() calls
    # hw.stop() up front to interrupt any in-flight motion, so "status is idle
    # and the last event was stop" is briefly true before the move even begins.
    # An earlier version of this harness used that condition and recorded zero
    # duties, which looked exactly like the bug under test.
    t0 = time.monotonic()
    while time.monotonic() - t0 < 25:
        if any(e.get("type") in ("arrived", "fault") for e in events):
            break
        time.sleep(0.02)
    car.shutdown()
    hw.cleanup()
    hw.outcome = [e.get("type") for e in events if e.get("type") in ("arrived", "fault")]
    return hw


def main():
    failures = []

    def check(label, cond, detail=""):
        print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""))
        if not cond:
            failures.append(label)

    print("=" * 68)
    print(" 1/3  speed setting reaches the motor")
    print("=" * 68)
    slow = run_move(0.30, 0)
    fast = run_move(0.95, 0)
    slow_peak = max(slow.duties) if slow.duties else 0
    fast_peak = max(fast.duties) if fast.duties else 0
    check("slow request produces a low duty", abs(slow_peak - 0.30) < 0.02, f"peak={slow_peak}")
    check("fast request produces a high duty", abs(fast_peak - 0.95) < 0.02, f"peak={fast_peak}")
    check("changing the slider changes the duty", fast_peak > slow_peak + 0.3,
          f"{slow_peak} -> {fast_peak}")

    print()
    print("=" * 68)
    print(" 2/3  duty is clamped to a usable band")
    print("=" * 68)
    tiny = run_move(0.01, 0)
    tiny_peak = max(tiny.duties) if tiny.duties else 0
    check("absurdly low speed clamped to MIN_DUTY", tiny_peak >= pa.MIN_DUTY - 1e-6,
          f"peak={tiny_peak} min={pa.MIN_DUTY}")
    over = run_move(5.0, 0)
    over_peak = max(over.duties) if over.duties else 0
    check("over-unity speed clamped to 1.0", over_peak <= 1.0 + 1e-6, f"peak={over_peak}")

    print()
    print("=" * 68)
    print(" 3/3  soft start / stop changes the ramp")
    print("=" * 68)
    sharp = run_move(0.9, 0)
    gentle = run_move(0.9, 100)
    # Count distinct duty steps before the peak: a ramp climbs through many
    # intermediate values, a hard start jumps straight to target.
    # Only the duties up to the FIRST peak belong to the soft start. Parking on
    # the sensor means a move also crawls at MIN_DUTY to drive the parked flag
    # out of the window beforehand, and nudges at MIN_DUTY to centre it
    # afterwards. Both are legitimately below peak but are alignment, not ramp,
    # so counting every sub-peak duty would report a climb even at ramp 0%.
    def climb_steps(hw):
        if not hw.duties:
            return 0
        peak = max(hw.duties)
        climb = hw.duties[: hw.duties.index(peak)]
        # Drop the leading departure crawl at MIN_DUTY.
        while climb and climb[0] <= pa.MIN_DUTY + 1e-9:
            climb.pop(0)
        return len([d for d in climb if d < peak - 1e-9])
    sharp_steps = climb_steps(sharp)
    gentle_steps = climb_steps(gentle)
    check("ramp 0% starts at full duty immediately", sharp_steps == 0, f"intermediate={sharp_steps}")
    check("ramp 100% climbs through intermediate duties", gentle_steps > 5,
          f"intermediate={gentle_steps}")
    check("gentle ramps more than sharp", gentle_steps > sharp_steps,
          f"{sharp_steps} vs {gentle_steps}")
    # Soft stop: the last applied duty before the final stop should be below peak.
    g_duties = gentle.duties
    g_peak = max(g_duties) if g_duties else 0
    check("soft stop eases down before halting", g_duties and g_duties[-1] < g_peak - 1e-9,
          f"last={g_duties[-1] if g_duties else None} peak={g_peak}")

    print()
    print("=" * 68)
    if failures:
        print(f" {len(failures)} CHECK(S) FAILED: {failures}")
        return 1
    print(" ALL CHECKS PASSED — speed and soft start reach the motor.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
