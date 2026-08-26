#!/usr/bin/env python3
"""
Parking ON the sensor.

The carousel must come to rest with the target shelf's flag INSIDE the sensor
window, so "in position" is a fact that can be re-checked rather than dead
reckoning. Three properties matter, and each had a real failure mode:

  1. A move ENDS with the sensor active. A soft stop always coasts, so counting
     alone cannot guarantee where the shelf physically stopped.

  2. The flag ends nearer the MIDDLE of the window than its edge. Parking on the
     boundary reads as "not in position" after the smallest drift.

  3. A move that OVERSHOOTS is recovered by crawling back until the sensor
     triggers again, rather than being left outside the window.

And the bug that started this: a move BEGINS with the sensor already active, so
the level dropping as the flag leaves must not be counted as the target
arriving. That was worth ~30mm of travel before the move ended early.

This harness models the sensor as a window of real physical width, so a parked
carousel genuinely sits inside it — a zero-width tripwire cannot express any of
the above.
"""
import sys
import threading
import time

sys.path.insert(0, "/vercel/share/v0-project/pi-agent")
import paternoster_agent as pa

HALF = pa.SIM_SENSOR_HALF_WIDTH


class WindowHW:
    """Position-modelled hardware whose sensor has a real window width."""

    def __init__(self, shelves=9, start_pos=0.0):
        self.shelves = shelves
        self.pos = start_pos
        self._dir = 0
        self._speed = 0.0
        self._lock = threading.Lock()
        self._shelf_pulses = 0
        self._index_pulses = 0
        self._tick = threading.Event()
        self._itick = threading.Event()
        self._was_active = self._window(start_pos)
        self.creep_reversals = 0
        self._last_dir = 0
        self._alive = True
        threading.Thread(target=self._spin, daemon=True).start()

    def _window(self, pos):
        return abs(pos - round(pos)) <= HALF

    def _spin(self):
        last = time.monotonic()
        while self._alive:
            now = time.monotonic()
            dt = now - last
            last = now
            with self._lock:
                if self._dir != 0 and self._speed > 0:
                    self.pos += self._dir * dt * (self._speed / 0.4)
                active = self._window(self.pos)
                # Pulse on BOTH edges. A real inductive sensor is a level, and
                # the driver's edge callback fires whenever that level changes,
                # so the flag LEAVING the window is just as much a pulse as it
                # arriving. Modelling only the entering edge hid the reported
                # bug entirely: the departure of the parked shelf is exactly
                # what used to be miscounted as the target arriving, ending the
                # move about 30mm in.
                if active != self._was_active:
                    self._shelf_pulses += 1
                    self._tick.set()
                    if int(round(self.pos)) % self.shelves == 0:
                        self._index_pulses += 1
                        self._itick.set()
                self._was_active = active
            time.sleep(0.002)

    # --- motor ---
    def forward(self, speed):
        self._set(+1, speed)

    def backward(self, speed):
        self._set(-1, speed)

    def _set(self, d, speed):
        with self._lock:
            if self._last_dir != 0 and d != self._last_dir:
                self.creep_reversals += 1
            self._last_dir = d
            self._dir = d
            self._speed = float(speed)

    def stop(self):
        with self._lock:
            self._dir = 0
            self._speed = 0.0

    # --- sensors ---
    def reset_pulses(self):
        with self._lock:
            self._shelf_pulses = 0
            self._index_pulses = 0
        self._tick.clear()
        self._itick.clear()

    def take_shelf_pulse(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                if self._shelf_pulses > 0:
                    self._shelf_pulses -= 1
                    return True
            if time.monotonic() >= deadline:
                return False
            self._tick.clear()
            self._tick.wait(0.01)

    def take_index_pulse(self, timeout):
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                if self._index_pulses > 0:
                    self._index_pulses -= 1
                    return True
            if time.monotonic() >= deadline:
                return False
            self._itick.clear()
            self._itick.wait(0.01)

    def shelf_active(self):
        with self._lock:
            return self._window(self.pos)

    def shelf_clear(self, timeout):
        deadline = time.monotonic() + timeout
        while self.shelf_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.002)
        return True

    def index_active(self):
        with self._lock:
            return self._window(self.pos) and int(round(self.pos)) % self.shelves == 0

    def index_clear(self, timeout):
        deadline = time.monotonic() + timeout
        while self.index_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.002)
        return True

    def cleanup(self):
        self._alive = False


def run_move(direction, steps, speed, ramp, start_pos=0.0):
    hw = WindowHW(start_pos=start_pos)
    faults = []
    c = pa.Carousel(hw, shelves=9, emit=lambda e: faults.append(e)
                    if e.get("type") == "fault" else None)
    c.homed = True
    c.current_shelf = 0
    # Keyword args matter: the signature is (move_speed, homing_speed, ramp_pct),
    # so a positional `ramp` silently became the homing speed.
    c.set_motion(move_speed=speed, ramp_pct=ramp)
    target = (0 + steps) if direction == "down" else (0 - steps)
    c.request_goto(target % 9)
    # Wait for the worker to actually PICK UP the command before waiting for it
    # to finish. `status` is still "idle" for a few ms after request_goto, so
    # polling for idle straight away returned before the move even started and
    # reported the untouched start position.
    deadline = time.monotonic() + 30
    while c.status == "idle" and time.monotonic() < deadline:
        time.sleep(0.005)
    while c.status != "idle" and time.monotonic() < deadline:
        time.sleep(0.02)
    # Let the post-move settle finish before reading the resting position.
    time.sleep(0.3)
    pos, rev = hw.pos, hw.creep_reversals
    c.shutdown()
    hw.cleanup()
    return pos, faults, rev


def main():
    fails = []

    def check(label, cond, detail=""):
        mark = "ok  " if cond else "FAIL"
        print(f"  {mark}  {label}" + (f"  [{detail}]" if detail else ""))
        if not cond:
            fails.append(label)

    print("=" * 70)
    print(" 1/3  a move ends with the shelf INSIDE the sensor window")
    print("=" * 70)
    for speed in (0.35, 0.45, 0.7):
        for ramp in (0, 40, 100):
            pos, faults, _ = run_move("down", 1, speed, ramp)
            off = abs(pos - round(pos))
            check(f"speed {speed} ramp {ramp:3d}%: parked in window",
                  off <= HALF + 1e-6 and not faults,
                  f"offset={off:.3f} half={HALF} faults={len(faults)}")

    print()
    print("=" * 70)
    print(" 2/3  the flag settles nearer the MIDDLE than the edge")
    print("=" * 70)
    for speed in (0.35, 0.45, 0.7):
        pos, _, _ = run_move("down", 1, speed, 40)
        off = abs(pos - round(pos))
        check(f"speed {speed}: not balanced on the boundary", off <= HALF * 0.8,
              f"offset={off:.3f} edge={HALF}")

    print()
    print("=" * 70)
    print(" 3/3  multi-shelf moves park on the sensor too")
    print("=" * 70)
    for steps in (2, 3, 4):
        pos, faults, _ = run_move("down", steps, 0.45, 40)
        off = abs(pos - round(pos))
        check(f"{steps} shelves: parked in window",
              off <= HALF + 1e-6 and not faults,
              f"offset={off:.3f} faults={len(faults)}")

    # Starting mid-travel (an aborted move left the window empty) must still
    # recover and park on the sensor rather than compounding the error.
    pos, faults, _ = run_move("down", 1, 0.45, 40, start_pos=0.45)
    off = abs(pos - round(pos))
    check("recovers when starting OUTSIDE the window",
          off <= HALF + 1e-6, f"offset={off:.3f} faults={len(faults)}")

    print()
    print("=" * 70)
    if fails:
        print(f" {len(fails)} CHECK(S) FAILED: {fails}")
        sys.exit(1)
    print(" ALL CHECKS PASSED: the carousel parks on the sensor.")


if __name__ == "__main__":
    main()
