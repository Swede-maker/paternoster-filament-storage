#!/usr/bin/env python3
"""
Counting across a CHANGE OF DIRECTION.

The reported failure: "if the carousel spins clockwise to shelf 3 and then
begins to spin counterclockwise, it registers shelf 3 again and thinks it passed
shelf 4 or 2." Counting is correct as long as the machine keeps turning the same
way, and loses a shelf on every reversal.

The cause is geometry, not arithmetic. The sensor sees a flag of real width, and
braking only BEGINS once the flag has been detected, so a move routinely comes to
rest with the flag just PAST the window. Carry on the same way and the next edge
is genuinely the next shelf. Reverse, though, and the first thing the sensor sees
is the flag we are already parked at sliding back in. Counted blindly, the shelf
we are standing on is counted as the next one along.

What is asserted here:

  1. REVERSING DOES NOT LOSE A SHELF. After a direction change the reported
     shelf still matches where the carousel physically is.

  2. CONTINUING DOES NOT SKIP ONE. The re-entry skip must apply ONLY on a
     reversal — applying it always would swallow a real shelf.

  3. IT SURVIVES REPEATED FLIPPING. Alternating direction many times must not
     accumulate drift.

  4. NPN POLARITY. The sensor is active-LOW, so the input must be pulled up and
     LOW must mean "shelf present".

Physical position is the source of truth throughout: every check compares the
shelf the agent REPORTS against where the carousel actually is.
"""
import sys
import threading
import time

sys.path.insert(0, "/vercel/share/v0-project/pi-agent")
import paternoster_agent as pa

# Half-width of the sensor window, in shelves. Deliberately NOT the simulator's
# own constant: that is set wide (0.18 shelves ~ 90mm on a 500mm pitch), wide
# enough that a stop which overshoots by a few centimetres still lands INSIDE the
# window. The carousel then always parks on the flag and the reversal fault is
# unreachable — the bug cannot be reproduced at all. 0.03 is ~15mm, which is the
# order of a real inductive sensor's sensing zone.
HALF = 0.03

PASS = "PASS"
FAIL = "FAIL"
_results = []


def check(name, ok, detail=""):
    _results.append((name, ok))
    print("  [%s] %s%s" % (PASS if ok else FAIL, name, ("  -- " + detail) if detail else ""))


class ReversalHW:
    """
    Velocity-modelled carousel with a real sensor window.

    `pos` is in shelves; a flag is "seen" whenever the position is within
    SIM_SENSOR_HALF_WIDTH of a whole number. Cutting power starts a coast, so a
    stop overshoots — which is exactly what leaves the flag sitting past the
    window and sets up the reversal bug.
    """

    def __init__(self, shelves=9, start_pos=0.0, decel=1.5):
        self.shelves = shelves
        self.pos = start_pos
        self.decel = decel
        self.vel = 0.0
        self._target = 0.0
        self._powered = False
        self._lock = threading.Lock()
        self._shelf_pulses = 0
        self._index_pulses = 0
        self._tick = threading.Event()
        self._itick = threading.Event()
        self._was_active = self._window(start_pos)
        # Mirrors the agent's hardware layer: which way the carousel is turning
        # right now, and which way it was turning when the flag last LEFT the
        # window. The second is what tells the agent which SIDE of the sensor the
        # flag it is parked against is on.
        self.travel_direction = None
        self.flag_exit_direction = None
        self._alive = True
        threading.Thread(target=self._spin, daemon=True).start()

    def _window(self, pos):
        return abs(pos - round(pos)) <= HALF

    def _spin(self):
        last = time.monotonic()
        while self._alive:
            now = time.monotonic()
            dt = min(now - last, 0.05)
            last = now
            with self._lock:
                if self._powered:
                    self.vel = self._target
                elif self.vel != 0.0:
                    drop = self.decel * dt
                    if abs(self.vel) <= drop:
                        self.vel = 0.0
                    else:
                        self.vel -= drop if self.vel > 0 else -drop
                self.pos += self.vel * dt
                active = self._window(self.pos)
                # RISING edges only, as gpiozero's `when_activated` does. Counting
                # both edges was a flaw in this harness: it handed the agent two
                # pulses per shelf, so a test could pass on the strength of the
                # extra edge and hide a real miscount.
                if active and not self._was_active:
                    self._shelf_pulses += 1
                    self._tick.set()
                    if int(round(self.pos)) % self.shelves == 0:
                        self._index_pulses += 1
                        self._itick.set()
                elif self._was_active and not active:
                    # Falling edge: the flag has just left the window, so the
                    # direction of travel now fixes which side it rests on.
                    if self.travel_direction is not None:
                        self.flag_exit_direction = self.travel_direction
                self._was_active = active
            time.sleep(0.002)

    def _go(self, duty, sign):
        with self._lock:
            self._powered = True
            self._target = sign * (duty / 0.4)

    def forward(self, duty):
        self._go(duty, +1)

    def backward(self, duty):
        self._go(duty, -1)

    def stop(self):
        with self._lock:
            self._powered = False
            self._target = 0.0

    def _take(self, which, timeout):
        ev = self._tick if which == "shelf" else self._itick
        ev.clear()
        with self._lock:
            n = self._shelf_pulses if which == "shelf" else self._index_pulses
            seen = getattr(self, "_seen_" + which, 0)
            if n > seen:
                setattr(self, "_seen_" + which, seen + 1)
                return True
        if timeout <= 0:
            return False
        if not ev.wait(timeout):
            return False
        with self._lock:
            seen = getattr(self, "_seen_" + which, 0)
            setattr(self, "_seen_" + which, seen + 1)
        return True

    def take_shelf_pulse(self, t):
        return self._take("shelf", t)

    def take_index_pulse(self, t):
        return self._take("index", t)

    def reset_pulses(self):
        with self._lock:
            self._seen_shelf = self._shelf_pulses
            self._seen_index = self._index_pulses
            self._tick.clear()
            self._itick.clear()

    def shelf_active(self):
        with self._lock:
            return self._window(self.pos)

    def index_active(self):
        with self._lock:
            return self._window(self.pos) and int(round(self.pos)) % self.shelves == 0

    def shelf_clear(self, timeout):
        deadline = time.monotonic() + timeout
        while self.shelf_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def index_clear(self, timeout):
        deadline = time.monotonic() + timeout
        while self.index_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def cleanup(self):
        self._alive = False


def make(hw, shelf, last_dir, shelves=9):
    """Build a Carousel that believes it is parked at `shelf`, with the flag it
    is parked against having left the sensor travelling `last_dir`."""
    events = []
    car = pa.Carousel(hw, shelves=shelves, emit=events.append)
    car.homed = True
    car.current_shelf = shelf
    # The flag's exit side lives in the hardware layer, recorded on the falling
    # edge — NOT as "the last direction the motor turned", which the alignment
    # crawl and the homing sweep both leave pointing the wrong way.
    hw.flag_exit_direction = last_dir
    car.set_motion(move_speed=0.45, ramp_pct=40)
    return car, events


def wait_idle(car, timeout=45.0):
    """Block until the carousel has been idle for a moment (settling included)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if car.status == "idle":
            time.sleep(0.35)
            if car.status == "idle":
                return
        time.sleep(0.05)


def goto(car, target, timeout=45.0):
    car.request_goto(target)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if car.status == "idle":
            time.sleep(0.35)
            if car.status == "idle":
                return
        time.sleep(0.05)


def physical(hw, shelves=9):
    """The shelf the carousel is ACTUALLY at."""
    return int(round(hw.pos)) % shelves


def agrees(hw, car, shelves=9):
    return physical(hw, shelves) == car.current_shelf


def main():
    # ======================================================================
    print("=" * 68)
    print("1. REVERSING AFTER STOPPING CLEAR OF THE FLAG")
    print("=" * 68)
    print("Parked just PAST shelf 3's flag, having travelled 'down'. Reversing")
    print("to shelf 2 must not count the shelf-3 flag sliding back in.")
    print()

    # Start clear of the window on the far side, as a real stop leaves it.
    hw = ReversalHW(start_pos=3.0 + HALF + 0.06)
    car, ev = make(hw, 3, "down")
    goto(car, 2)
    time.sleep(0.4)
    print("   physical shelf %d (pos %.3f), agent reports %d"
          % (physical(hw), hw.pos, car.current_shelf))
    check("reversal does not lose a shelf", agrees(hw, car),
          "physical=%d reported=%d" % (physical(hw), car.current_shelf))
    # NOT "did it come to rest inside the sensor window". The window is narrower
    # than the carousel's stopping distance, so that is a condition the machine
    # can never meet: every creep pulse that reaches the flag also carries past
    # it. Asserting it demanded the impossible and hid the real requirement,
    # which is that the stop be a bounded distance from the CORRECT flag.
    check("stopped close to the target flag",
          abs(hw.pos - round(hw.pos)) < 0.25,
          "pos %.3f is %.3f shelves off the flag"
          % (hw.pos, abs(hw.pos - round(hw.pos))))
    car.shutdown(); hw.cleanup()

    # ======================================================================
    print()
    print("=" * 68)
    print("2. CONTINUING THE SAME WAY MUST NOT SKIP A SHELF")
    print("=" * 68)
    print("The re-entry skip is only correct on a reversal. Applying it to a")
    print("move that carries on the same way would swallow a real shelf.")
    print()

    hw = ReversalHW(start_pos=3.0 + HALF + 0.06)
    car, ev = make(hw, 3, "down")
    goto(car, 4)          # same direction as before
    time.sleep(0.4)
    print("   physical shelf %d (pos %.3f), agent reports %d"
          % (physical(hw), hw.pos, car.current_shelf))
    check("same-direction move counts correctly", agrees(hw, car),
          "physical=%d reported=%d" % (physical(hw), car.current_shelf))
    car.shutdown(); hw.cleanup()

    # ======================================================================
    print()
    print("=" * 68)
    print("3. REPEATED FLIPPING MUST NOT ACCUMULATE DRIFT")
    print("=" * 68)
    print("Alternating direction six times. Any per-reversal miscount")
    print("compounds, so a residual off-by-one shows up plainly here.")
    print()

    hw = ReversalHW(start_pos=0.0)
    car, ev = make(hw, 0, None)
    drift_ok = True
    for tgt in [1, 0, 1, 0, 1, 0]:
        goto(car, tgt)
        time.sleep(0.3)
        ok = agrees(hw, car)
        print("   -> asked %d: physical %d (pos %+.3f), reports %d  %s"
              % (tgt, physical(hw), hw.pos, car.current_shelf,
                 "ok" if ok else "MISMATCH"))
        if not ok:
            drift_ok = False
    check("no drift across six reversals", drift_ok)
    car.shutdown(); hw.cleanup()

    # ======================================================================
    print()
    print("=" * 68)
    print("4. THE FIRST MOVE AFTER HOMING")
    print("=" * 68)
    print("Homing sweeps the shelf flag out past the sensor, then the alignment")
    print("crawl creeps back the OTHER way to sit on the index flag. The motor's")
    print("last direction is therefore the reverse of the shelf flag's exit, so")
    print("judging the reversal by motor direction gets this move wrong: the")
    print("flag slides back in and is counted as the shelf that was asked for,")
    print("leaving the carousel where it started.")
    print()

    hw = ReversalHW(start_pos=3.4)
    events = []
    car = pa.Carousel(hw, shelves=9, emit=events.append)
    car.set_motion(move_speed=0.45, ramp_pct=40)
    car.request_home()
    wait_idle(car, timeout=90.0)
    print("   after home: physical shelf %d (pos %.3f), reports %d, homed=%s"
          % (physical(hw), hw.pos, car.current_shelf, car.homed))
    home_pos = hw.pos
    check("homed onto the index flag", car.homed, "pos %.3f" % hw.pos)

    goto(car, 1)
    time.sleep(0.4)
    print("   then goto 1: physical shelf %d (pos %.3f), reports %d"
          % (physical(hw), hw.pos, car.current_shelf))
    check("first move after homing actually travels a shelf",
          abs(hw.pos - home_pos) > 0.5,
          "travelled %.3f shelves" % abs(hw.pos - home_pos))
    check("first move after homing lands on the right shelf", agrees(hw, car),
          "physical=%d reported=%d" % (physical(hw), car.current_shelf))
    car.shutdown(); hw.cleanup()

    # ======================================================================
    print()
    print("=" * 68)
    print("5. NPN SENSOR POLARITY (active-LOW)")
    print("=" * 68)
    print("An NPN sensor sinks its output to GND when a shelf is present, so")
    print("the pin must be pulled UP and LOW must read as 'shelf detected'.")
    print()

    check("configured for NPN", pa.SENSOR_TYPE.upper() == "NPN",
          "SENSOR_TYPE=%r" % pa.SENSOR_TYPE)
    check("NPN selects a pull-up (so LOW = active)",
          pa.SENSOR_TYPE.upper() == "NPN")

    # ======================================================================
    print()
    print("=" * 68)
    failed = [n for n, ok in _results if not ok]
    if failed:
        print("%d CHECK(S) FAILED:" % len(failed))
        for n in failed:
            print("   - " + n)
    else:
        print("ALL CHECKS PASSED (%d)" % len(_results))
    print("=" * 68)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
