#!/usr/bin/env python3
"""
MULTI-SHELF MOVES LAND ONE SHELF SHORT WHILE REPORTING THE TARGET.

Observed on the machine: homed, then "go to shelf 2" worked (flag 2 ended up at
the sensor). From shelf 2, "go to shelf 5" stopped with flag *4* at the sensor
while the app said shelf 5. Single-shelf steps were always right; only moves of
more than one shelf lost one.

Losing a shelf while the count says otherwise means exactly one thing: the agent
counted a trigger that was not a shelf arrival. Every subsequent position is then
wrong by one, and nothing on the machine can notice, because the count is the
only position there is.

WHERE THE EXTRA TRIGGER COMES FROM
----------------------------------
A move now ENDS with the target flag parked inside the sensor window, so every
move BEGINS with the sensor already triggered, sitting on the flag it is about to
leave. The chain has slack. When the motor is energised with a real torque step,
the sprocket takes up that slack before the carousel moves: the flag drops
backwards out of the window and is then driven forwards back into it. The sensor
sees inactive -> ACTIVE, a genuine rising edge, and the agent counts it as a
shelf. One free shelf, at the start of every move.

Why single-shelf moves escaped it: a one-shelf hop runs entirely at the arrival
duty (MIN_DUTY), so the torque step at start is small and the flag never leaves
the window. Multi-shelf moves open at the operator's much higher cruise duty, so
they rock the chain and pick up the phantom count. That is precisely the split
the operator reported.

This harness models the slack rock with amplitude proportional to the OPENING
duty, and asserts on PHYSICAL travel (flags actually passed), not on the agent's
own count -- the count is the thing under test and cannot be its own witness.
"""
import sys
import threading
import time

sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import paternoster_agent as pa  # noqa: E402

_results = []


def check(name, ok, detail=""):
    _results.append((name, bool(ok)))
    print("  [%s] %s%s" % ("PASS" if ok else "FAIL", name,
                           "" if ok or not detail else "\n         -> " + detail))


HALF = 0.18          # sensor window half-width, in shelf pitches
SEC_PER_PITCH = 0.225  # travel time for one shelf pitch at duty 1.0 (= 0.5s at MOVE_SPEED, matching the agent constant)


class SlackHW:
    """
    Carousel with a sensor window, a bounce lockout, and CHAIN SLACK.

    Position is continuous, in shelf pitches. Rising edges are derived from the
    level exactly as gpiozero's `when_activated` would, so a rock in and out of
    the window produces real edges rather than scripted ones.

    `slack` is the take-up travel when the motor is energised from rest, scaled
    by the duty applied: a hard start rocks the chain, a gentle one barely does.
    """

    def __init__(self, start_pos=0.0, slack_at_full=0.60):
        self._pos = float(start_pos)
        self._dir = 0
        self._speed = 0.0
        self._slack_at_full = slack_at_full
        self._lock = threading.Lock()

        self._shelf_pulses = 0
        self._shelf_tick = threading.Event()
        self._index_pulses = 0
        self._index_tick = threading.Event()
        self._was_active = self._window_active()
        self._last_counted = None
        self._shelf_settle = 0.0

        self.travel_direction = None
        self.flag_exit_direction = None

        # Every rising edge the sensor physically produced, counted vs suppressed.
        self.edges = 0
        self.suppressed = 0

        self._running = True
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()

    # ---- geometry -------------------------------------------------------
    def _window_active(self):
        return abs(self._pos - round(self._pos)) <= HALF

    def flags_passed(self, origin):
        """Whole flags physically travelled from `origin`, by position alone."""
        return abs(round(self._pos) - round(origin))

    # ---- physics --------------------------------------------------------
    def _loop(self):
        last = time.monotonic()
        while self._running:
            now = time.monotonic()
            dt = now - last
            last = now
            with self._lock:
                if self._dir != 0 and self._speed > 0:
                    self._pos += self._dir * dt * (self._speed / SEC_PER_PITCH)
                active = self._window_active()
                if active and not self._was_active:
                    self.edges += 1
                    if (self._last_counted is not None
                            and self._shelf_settle > 0
                            and (now - self._last_counted) < self._shelf_settle):
                        self.suppressed += 1
                    else:
                        self._last_counted = now
                        self._shelf_pulses += 1
                        self._shelf_tick.set()
                elif self._was_active and not active:
                    if self.travel_direction is not None:
                        self.flag_exit_direction = self.travel_direction
                self._was_active = active
            time.sleep(0.002)

    def _go(self, direction, duty):
        with self._lock:
            starting = (self._dir == 0 or self._speed == 0.0)
            if starting:
                # Slack take-up: the flag falls BACKWARDS before the chain pulls.
                self._pos -= direction * self._slack_at_full * duty
            self._dir = direction
            self._speed = duty

    # ---- hardware interface --------------------------------------------
    def forward(self, duty):
        self._go(+1, duty)

    def backward(self, duty):
        self._go(-1, duty)

    def stop(self):
        with self._lock:
            self._dir = 0
            self._speed = 0.0

    def set_shelf_settle(self, seconds):
        with self._lock:
            self._shelf_settle = max(0.0, seconds)

    def arm_shelf_lockout(self):
        with self._lock:
            self._last_counted = time.monotonic()

    def reset_pulses(self):
        with self._lock:
            self._shelf_pulses = 0
            self._index_pulses = 0
            self._last_counted = None
        self._shelf_tick.clear()
        self._index_tick.clear()

    def _take(self, kind, timeout):
        deadline = time.monotonic() + timeout
        while True:
            with self._lock:
                if kind == "shelf" and self._shelf_pulses > 0:
                    self._shelf_pulses -= 1
                    return True
                if kind == "index" and self._index_pulses > 0:
                    self._index_pulses -= 1
                    return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(remaining, 0.002))

    def take_shelf_pulse(self, timeout):
        return self._take("shelf", timeout)

    def take_index_pulse(self, timeout):
        return self._take("index", timeout)

    def shelf_active(self):
        with self._lock:
            return self._window_active()

    def index_active(self):
        return False

    def shelf_clear(self, timeout):
        deadline = time.monotonic() + timeout
        while self.shelf_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def index_clear(self, timeout):
        return True

    def cleanup(self):
        self._running = False


def run_move(start_shelf, target, shelves=9, speed=0.45, ramp_pct=0,
             slack=0.60, timeout=30.0):
    """
    One move, from a carousel PARKED ON the flag of `start_shelf`.

    Returns (flags physically passed, shelf the agent reports, hw).
    """
    hw = SlackHW(start_pos=float(start_shelf), slack_at_full=slack)
    car = pa.Carousel(hw, shelves=shelves, emit=lambda e: None)
    car.homed = True
    car.current_shelf = start_shelf
    car.set_motion(move_speed=speed, homing_speed=0.30, ramp_pct=ramp_pct)

    t = threading.Thread(target=car._do_goto, args=(target,), daemon=True)
    t.start()
    t.join(timeout=timeout)
    if t.is_alive():
        car.request_stop()
        t.join(timeout=5)
    hw.stop()
    time.sleep(0.05)

    passed = hw.flags_passed(start_shelf)
    hw.cleanup()
    return passed, car.current_shelf, hw


def main():
    print()
    print("=" * 68)
    print("MULTI-SHELF START-OF-MOVE PHANTOM COUNT")
    print("=" * 68)

    # ------------------------------------------------------------------
    # 1. THE OPERATOR'S EXACT SEQUENCE.
    # ------------------------------------------------------------------
    print()
    print("-- the reported sequence: 1 -> 2 (fine), then 2 -> 5 (lost a shelf) --")

    passed, reported, _ = run_move(1, 2)
    check("single-shelf move 1->2 travels exactly one flag",
          passed == 1,
          "travelled %d flags" % passed)
    check("single-shelf move 1->2 reports shelf 2",
          reported == 2,
          "reported %r" % reported)

    passed, reported, hw = run_move(2, 5)
    check("three-shelf move 2->5 travels exactly THREE flags",
          passed == 3,
          "travelled %d flags but reported shelf %r -- the machine is at shelf "
          "%d while the app says %r (%d sensor edges, %d suppressed as bounce)"
          % (passed, reported, 2 + passed, reported, hw.edges, hw.suppressed))
    check("three-shelf move 2->5 reports shelf 5",
          reported == 5,
          "reported %r" % reported)

    # ------------------------------------------------------------------
    # 2. EVERY DISTANCE, NOT JUST THREE.
    # ------------------------------------------------------------------
    print()
    print("-- travel must equal the requested distance at every distance --")
    for dist in (1, 2, 3, 4):
        target = (1 + dist) % 9
        passed, reported, hw = run_move(1, target)
        check("a %d-shelf move travels %d flags" % (dist, dist),
              passed == dist,
              "travelled %d (short by %d); %d edges, %d suppressed"
              % (passed, dist - passed, hw.edges, hw.suppressed))
        check("a %d-shelf move reports the shelf it is on" % dist,
              reported == target and passed == dist,
              "reports %r, physically at %d" % (reported, (1 + passed) % 9))

    # ------------------------------------------------------------------
    # 3. THE SAME MUST HOLD ACROSS SPEED AND RAMP SETTINGS.
    #
    # The phantom edge is a start-of-move artefact, so it has to be rejected
    # however the move opens: hard start at full duty (ramp 0) and soft start
    # alike, fast and slow.
    # ------------------------------------------------------------------
    print()
    print("-- across speed and ramp settings --")
    for speed, ramp in ((0.45, 0), (0.45, 60), (0.90, 0), (0.30, 40), (1.00, 0)):
        passed, reported, hw = run_move(2, 5, speed=speed, ramp_pct=ramp)
        check("speed %.2f / ramp %d%%: a 3-shelf move travels 3 flags"
              % (speed, ramp),
              passed == 3 and reported == 5,
              "travelled %d, reported %r (%d edges, %d suppressed)"
              % (passed, reported, hw.edges, hw.suppressed))

    # ------------------------------------------------------------------
    # 4. A SLACKLESS MACHINE MUST NOT BE MADE WORSE.
    #
    # The fix must not work by blanking a fixed window that a tight machine's
    # genuine first shelf could fall inside.
    # ------------------------------------------------------------------
    print()
    print("-- no slack at all: the guard must not swallow a real shelf --")
    for dist in (1, 3):
        target = (1 + dist) % 9
        passed, reported, hw = run_move(1, target, slack=0.0)
        check("tight chain: a %d-shelf move still travels %d flags"
              % (dist, dist),
              passed == dist and reported == target,
              "travelled %d, reported %r" % (passed, reported))

    # ------------------------------------------------------------------
    # 5. AND THE MOVE MUST STILL END ON THE FLAG.
    #
    # Rejecting the phantom edge is worthless if it also stops the carousel
    # somewhere the sensor cannot confirm.
    # ------------------------------------------------------------------
    print()
    print("-- the move still parks with the flag in the window --")
    hw = SlackHW(start_pos=2.0, slack_at_full=0.60)
    car = pa.Carousel(hw, shelves=9, emit=lambda e: None)
    car.homed = True
    car.current_shelf = 2
    car.set_motion(move_speed=0.45, homing_speed=0.30, ramp_pct=0)
    car._do_goto(5)
    on_sensor = hw.shelf_active()
    passed = hw.flags_passed(2)
    hw.cleanup()
    check("power is cut with the target flag inside the sensor window",
          on_sensor,
          "the carousel stopped with an empty window")
    check("and it is the RIGHT flag (three passed)",
          passed == 3,
          "travelled %d flags" % passed)

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
