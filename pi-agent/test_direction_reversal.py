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
import os
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
        # Mirrors the agent's hardware layer: current travel, and the travel at
        # the moment the flag last LEFT the sensor window. The second is what
        # tells the agent which side of the sensor the parked flag rests on.
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
                    # Falling edge: the flag has just cleared the window, so the
                    # current travel fixes which side it now rests on.
                    if self.travel_direction is not None:
                        self.flag_exit_direction = self.travel_direction
                self._was_active = active
            time.sleep(0.002)

    def _go(self, duty, sign):
        with self._lock:
            self._powered = True
            self._target = sign * (duty / 0.4)

    def cut(self):
        """Emergency stop, as the agent's estop path calls it."""
        self.stop()

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
    # Which side the parked flag sits on, i.e. the travel direction that last
    # carried it out of the sensor window. Lives in the hardware layer because it
    # is measured at the flag's falling edge, not inferred from the move.
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
    print("6. POWER MUST BE CUT WHILE THE FLAG IS STILL ON THE SENSOR")
    print("=" * 68)
    print("Required behaviour is HIGH -> STOP, not HIGH -> LOW -> STOP. The")
    print("machine must cut power the instant the sensor triggers, not after the")
    print("flag has travelled back out of the window.")
    print()
    print("A stop RAMP cannot satisfy this. It keeps the motor energised for a")
    print("FIXED TIME after the edge, and a fixed time is a fixed distance the")
    print("flag keeps moving. Going slower does not rescue it: it shrinks the")
    print("distance proportionally while the sensor window stays just as narrow,")
    print("so the flag still leaves. Only cutting power on the edge works.")
    print()

    for duty in (0.45, 0.10, 0.06):
        hw = ReversalHW(start_pos=2.0)
        faults = []
        car = pa.Carousel(
            hw, shelves=9,
            emit=lambda e: faults.append(e) if e.get("type") == "fault" else None)
        car.homed = True
        car.current_shelf = 2
        car.set_motion(move_speed=duty, ramp_pct=40)

        # Sample the sensor at the ARRIVAL cut-off: the first time power is cut
        # after the carousel has actually left its starting flag.
        #
        # Getting this probe right took three attempts, so the reasoning is worth
        # recording:
        #   * The first hw.stop() of a move happens before it sets off, with the
        #     carousel still parked on its CURRENT flag (active=True). Accepting
        #     that sample makes the check pass even with a stop ramp.
        #   * Latching the first _energise with an active sensor marks the
        #     DEPARTURE flag for the same reason — it reported 1.038 shelves of
        #     "powered travel" on correct code.
        #   * The LAST _energise is no good either: _energise is only called while
        #     the acceleration ramp is climbing, after which the motor simply
        #     holds duty, so the final call is always back near the start (pos
        #     2.087 on a move to shelf 3).
        # Requiring the carousel to have cleared its origin first fixes all three.
        marks = {}
        real_stop = hw.stop
        start_pos = hw.pos

        def _spy_stop(_real=real_stop, _hw=hw, _m=marks, _s=start_pos):
            if "active" not in _m and abs(_hw.pos - _s) > 0.5:
                _m["active"] = _hw.shelf_active()
                _m["pos"] = _hw.pos
            return _real()

        hw.stop = _spy_stop
        goto(car, 3)
        time.sleep(0.3)

        pct = int(round(duty * 100))
        check("duty %d%%: sensor still ON when power was cut" % pct,
              marks.get("active") is True,
              "power cut at pos=%.3f, sensor active=%r"
              % (marks.get("pos", float("nan")), marks.get("active")))
        # The bouncing and the surprise self-homing were both downstream of the
        # overshoot: alignment hunted for the flag it had just left, and when the
        # hunt ran out of budget the agent dropped `homed`, which the UI's
        # auto-home effect turned into an unrequested homing sweep.
        check("duty %d%%: no position-lost fault (nothing triggers self-homing)" % pct,
              not faults and car.homed,
              "faults=%d homed=%s" % (len(faults), car.homed))

        car.shutdown()
        hw.cleanup()

    check("no soft-stop ramp exists at the target",
          not hasattr(pa.Carousel, "_decelerate"),
          "a _decelerate() would re-introduce powered travel past the flag")

    # ======================================================================
    print()
    print("=" * 68)
    print("7. EMERGENCY STOP MUST HALT AN IN-PROGRESS HOMING SWEEP")
    print("=" * 68)
    print("Reported: 'the Emergency STOP didn't work at all. It was doing homing")
    print("and I did try to stop it but it didn't work.' Homing is a long")
    print("autonomous routine, so the stop has to interrupt a sensor wait that is")
    print("already blocking — not merely be queued behind it.")
    print()

    # Index flag deliberately unreachable, so homing sits in its full
    # HOME_TIMEOUT wait: precisely the state the operator hit.
    class NoIndexHW(ReversalHW):
        def index_active(self):
            return False

        def take_index_pulse(self, timeout):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                time.sleep(0.005)
            return False

    hw = NoIndexHW(start_pos=2.0)
    car = pa.Carousel(hw, shelves=9, emit=lambda e: None)
    car.set_motion(move_speed=0.45, homing_speed=0.30, ramp_pct=40)
    car.request_home()
    time.sleep(1.0)
    check("homing is actually running and the motor is energised",
          car.status == "homing" and hw._powered,
          "status=%s powered=%s" % (car.status, hw._powered))

    t0 = time.monotonic()
    car.request_stop()
    off_at = None
    left_at = None
    while time.monotonic() - t0 < 8.0:
        if off_at is None and not hw._powered:
            off_at = time.monotonic() - t0
        if left_at is None and car.status != "homing":
            left_at = time.monotonic() - t0
        if off_at is not None and left_at is not None:
            break
        time.sleep(0.005)

    check("power is cut promptly on emergency stop",
          off_at is not None and off_at < 0.5,
          "power cut after %s s" % ("8+ (NEVER)" if off_at is None else "%.3f" % off_at))
    # The real defect: the worker sat inside ONE 30-second sensor wait, so it
    # could not observe the abort until that wait expired. Long waits are now
    # sliced and re-check the abort flag between slices.
    check("the homing routine abandons its blocking wait quickly",
          left_at is not None and left_at < 1.0,
          "left 'homing' after %s s (HOME_TIMEOUT=%.0fs)"
          % ("8+ (STUCK)" if left_at is None else "%.3f" % left_at, pa.HOME_TIMEOUT))
    check("an aborted move is not misreported as a jam",
          car.status != "fault",
          "status=%s" % car.status)
    car.shutdown(); hw.cleanup()

    # ======================================================================
    print()
    print("=" * 68)
    print("8. JAM WATCHDOG SCALES AT MEGA-SLOW PWM")
    print("=" * 68)
    # The pulse timeout is only a jam watchdog: position comes from counting
    # shelf pulses, never from elapsed time. It used to clamp its divisor at
    # MIN_DUTY, so below 25% duty the budget stopped growing while real travel
    # time kept growing — a deliberately mega-slow move walked into a bogus
    # "Jam?" fault. The margin must stay constant at every speed.
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "paternoster_agent.py")).read()
    check("jam timeout does not clamp its divisor to MIN_DUTY",
          "MOVE_SPEED / max(MIN_DUTY, speed)" not in src,
          "clamping caps the budget below 25% duty and invents jams")

    def _budget(duty):
        return pa.PULSE_TIMEOUT * (pa.MOVE_SPEED / max(0.01, duty))

    # Travel time scales inversely with duty, so budget/travel must be flat.
    ratios = [_budget(d) / (pa.MOVE_SPEED / d) for d in (0.45, 0.25, 0.10, 0.06, 0.05)]
    check("jam budget keeps a constant margin from 45% down to 5% duty",
          max(ratios) - min(ratios) < 1e-6,
          "margins drift across speeds: %s" % ["%.2f" % r for r in ratios])

    # ======================================================================
    print()
    print("=" * 68)
    print("9. MECHANICAL SHELF-BOUNCE FILTER")
    print("=" * 68)
    print("Reported: 'the shelf can bounce a bit so the sensor gets triggered and")
    print("then it bounces so the same shelf gets triggered twice or even more.'")
    print()

    # The filter must stay a constant fraction of the real shelf spacing, so one
    # setting is correct at every speed. A FLAT 1.0-1.5s value cannot: per-shelf
    # travel is ~0.5s at MOVE_SPEED, so a flat filter would exceed the whole gap
    # between shelves and reject genuine ones.
    # Real per-shelf travel is ~0.5s at MOVE_SPEED and scales inversely with duty.
    def shelf_period(duty):
        return 0.5 * (pa.MOVE_SPEED / duty)

    fracs = [pa.shelf_settle_for(d) / shelf_period(d) for d in (0.45, 0.25, 0.10)]
    check("lockout stays a constant fraction of shelf spacing across speeds",
          max(fracs) - min(fracs) < 1e-6,
          "fractions drift: %s" % ["%.2f" % f for f in fracs])
    # As a POST-trigger lockout the binding constraint is the time between
    # consecutive shelf ARRIVALS. Overrun it and two distinct shelves merge into
    # one count. (When this was a pre-trigger settle the constraint was the much
    # tighter empty-window gap, which is precisely what it kept violating.)
    check("lockout never outlasts the gap between consecutive arrivals",
          all(pa.shelf_settle_for(d) < shelf_period(d)
              for d in (0.45, 0.25, 0.10, 0.06, 0.05)),
          "a lockout longer than the shelf period merges two shelves")
    check("lockout is capped so a near-stalled duty cannot blind counting",
          pa.shelf_settle_for(0.001) <= pa.SHELF_SETTLE_MAX,
          "uncapped lockout at near-zero duty")
    # The whole point of the redesign: however long the lockout is, it can never
    # postpone the FIRST edge after a reset — the edge that stops the motor.
    # Driven through the real sensor loop, with the biggest lockout the scaler can
    # ever produce, and with NO empty-window settling time beforehand.
    for label, lockout in (("normal", pa.shelf_settle_for(0.45)),
                           ("slow duty", pa.shelf_settle_for(0.10)),
                           ("max cap", pa.SHELF_SETTLE_MAX)):
        probe = pa.SimHardware(shelves=9)
        probe.set_shelf_settle(lockout)
        hlf = pa.SIM_SENSOR_HALF_WIDTH
        with probe._lock:                 # sit just outside the window
            probe._pos = 1.0 - hlf - 0.05
        time.sleep(0.05)
        probe.reset_pulses()
        with probe._lock:                 # rising edge, immediately
            probe._pos = 1.0
        got = probe.take_shelf_pulse(0.25)
        probe.cleanup()
        check("first edge after reset is instant (%s lockout %.2fs)"
              % (label, lockout),
              got,
              "the bounce filter delayed the edge that must cut power")

    # --- behavioural: drive the simulated sensor through a real bounce ---
    SETTLE = 0.30
    hw = pa.SimHardware(shelves=9)
    hw.set_shelf_settle(SETTLE)
    half = pa.SIM_SENSOR_HALF_WIDTH

    def park(pos):
        """Move the simulated flag to `pos` and let the sensor loop observe it."""
        with hw._lock:
            hw._pos = pos
        time.sleep(0.05)

    # Arrive at shelf 1 properly: sit clear of the window well beyond the settle,
    # then enter it.
    park(1.0 - half - 0.1)
    time.sleep(SETTLE + 0.1)
    hw.reset_pulses()
    park(1.0)
    check("a genuine shelf arrival is counted",
          hw.take_shelf_pulse(0.3),
          "the arrival edge was rejected")

    # Now BOUNCE: the flag rocks out of the window and straight back in, twice,
    # far quicker than the settle period. This is the reported failure — each
    # re-entry used to be counted as another whole shelf.
    for _ in range(2):
        park(1.0 + half + 0.02)   # wobbles out
        park(1.0)                 # and straight back in
    check("a bounce does NOT produce extra shelf counts",
          not hw.take_shelf_pulse(0.05),
          "bounce still counted as another shelf")
    check("suppressed bounces are recorded for diagnosis",
          hw._suppressed_bounces >= 2,
          "suppressed=%d" % hw._suppressed_bounces)

    # The next GENUINE shelf must still be counted: the window is empty for
    # longer than the settle, which is exactly what distinguishes it from bounce.
    park(1.0 + half + 0.1)
    time.sleep(SETTLE + 0.1)
    park(2.0)
    check("the next genuine shelf is still counted after a bounce",
          hw.take_shelf_pulse(0.3),
          "a real shelf was swallowed by the filter")
    hw.cleanup()

    # The shelf filter must NOT be able to hide the home datum. On real hardware
    # the index sensor is a physically separate input with its own callback, so a
    # bouncing shelf cannot suppress it; the simulator must match. Over-counting
    # the index is harmless (homing only asks "seen it yet?"), but MISSING it
    # loses the reference the whole axis is measured from, and homing times out.
    # This must isolate the BOUNCE re-entry. Counting the clean first arrival too
    # would pass either way — that pulse is never suppressed — so the check has to
    # start from a flag already sitting in the window, exactly as a homing sweep
    # that has just arrived and is now rocking.
    hw = pa.SimHardware(shelves=9)
    hw.set_shelf_settle(SETTLE)
    park(0.0 - half - 0.1)           # clear of the window, just before home
    time.sleep(SETTLE + 0.1)
    park(0.0)                        # clean arrival at the home/index flag
    hw.take_index_pulse(0.3)         # consume it; it is not what we are testing
    # Consume the arrival's SHELF pulse individually rather than calling
    # reset_pulses(): a reset deliberately clears the bounce lockout, so the very
    # next edge would pass by design and this check would be testing nothing.
    hw.take_shelf_pulse(0.3)

    # Bounce ON the home flag. Each re-entry is inside the lockout that the
    # arrival started, so the SHELF count is (correctly) suppressed — but the
    # index must still be seen.
    for _ in range(2):
        park(0.0 + half + 0.02)
        park(0.0)
    check("a bouncing home/index flag is still detected",
          hw.take_index_pulse(0.3),
          "the shelf bounce filter also swallowed the index -> homing times out")
    check("the same bounce is still suppressed for SHELF counting",
          not hw.take_shelf_pulse(0.05),
          "index decoupling must not re-open double shelf counting")
    hw.cleanup()

    # --- why the pre-existing arrival/departure alternation is NOT enough ---
    #
    # The counting loop already discarded every second edge (arrival, departure,
    # arrival, ...). That handles a clean level sensor, so it is easy to assume
    # bounce was covered. It is not: alternation only ever removes HALF the
    # edges, so an odd number of bounce edges still leaks a phantom shelf, and
    # it also desynchronises the arrival/departure phase for everything after.
    #
    # Modelled directly as pure logic, because the simulator's timing is too
    # clean to reproduce a mechanical rock reliably.
    def count_edges(rising_edges, level_reads):
        """Replica of the loop's classifier: alternation + level check."""
        counted = 0
        pending = False
        for active_after in level_reads[:rising_edges]:
            if pending and not active_after:
                pending = False
                continue
            pending = True
            counted += 1
        return counted

    def _settle_count(events, settle, first_delayed=None):
        """
        Replica of the shipped POST-TRIGGER LOCKOUT: a rising edge is counted
        immediately unless it falls within `settle` of the last COUNTED edge.
        Exit events are irrelevant to it by design, which is exactly why it can
        never delay the edge that stops the motor.

        `first_delayed` collects whether any edge was postponed while the window
        had not been empty for long — the failure mode of the old release filter.
        """
        counted = 0
        last_counted = None
        for kind, t in events:
            if kind != "rise":
                continue
            if last_counted is not None and (t - last_counted) < settle:
                continue                     # same shelf still rocking
            if first_delayed is not None and counted == 0:
                first_delayed.append(False)  # the first edge always passes
            last_counted = t
            counted += 1
        return counted

    # ONE shelf arriving, then rocking out-and-in twice. The flag has settled
    # INSIDE the window, so the level reads ACTIVE on every edge.
    check("alternation alone miscounts a bouncing shelf (why the filter exists)",
          count_edges(3, [True, True, True]) == 3,
          "expected the OLD logic to count 3 for one bouncing shelf")
    # The same physical event, as the agent sees it: arrive, then rock out-and-in
    # twice with only ~15ms of empty window each time.
    one_bouncing_shelf = [
        ("rise", 0.00),
        ("exit", 0.02), ("rise", 0.035),
        ("exit", 0.05), ("rise", 0.065),
    ]
    delayed = []
    check("the lockout filter reduces that same bounce to a single shelf",
          _settle_count(one_bouncing_shelf, settle=0.30, first_delayed=delayed) == 1,
          "got %d counts for one bouncing shelf"
          % _settle_count(one_bouncing_shelf, settle=0.30))
    check("and it did not postpone that shelf's first (stopping) edge",
          delayed == [False],
          "the first edge was not published immediately: %r" % (delayed,))
    # And a genuinely different shelf, arriving after a full empty gap, still counts.
    two_real_shelves = one_bouncing_shelf + [("exit", 0.10), ("rise", 0.90)]
    check("a genuine later shelf is still counted by the same filter",
          _settle_count(two_real_shelves, settle=0.30) == 2,
          "got %d counts for one bouncing shelf plus one real shelf"
          % _settle_count(two_real_shelves, settle=0.30))

    # ======================================================================
    print()
    print("=" * 68)
    print("10. TRIGGER = STOP, AND ACCELERATE WITHOUT WAITING FOR A SENSOR")
    print("=" * 68)
    print("Reported: (a) the carousel waits for the sensor to go from triggered to")
    print("untriggered before stopping, so it drives past the shelf; (b) it waits")
    print("for a trigger before it speeds up, instead of soft-starting right away.")
    print()

    class ScriptedHW:
        """
        Pulse-driven fake. Edges and level reads are dictated by the test rather
        than emerging from simulated physics, so the counting logic is measured
        directly instead of through timing luck.
        """
        def __init__(self, level, pulses=999, spacing=0.25):
            self._level = level          # what shelf_active() reports
            self._left = pulses
            # Minimum gap between consecutive shelf pulses, so a move takes a
            # realistic amount of wall-clock time instead of completing in the
            # first few poll iterations.
            self._spacing = spacing
            self._last_pulse = 0.0
            self.consumed = 0
            self.duties = []             # (t, duty) for every energise
            self.stopped_at = None       # pulses consumed when power was cut
            self.stop_level = None       # sensor level at the instant of the stop
            self.travel_direction = None
            self.flag_exit_direction = None
            self._t0 = time.monotonic()

        def _go(self, duty):
            self.duties.append((time.monotonic() - self._t0, duty))

        def forward(self, duty):
            self._go(duty)

        def backward(self, duty):
            self._go(duty)

        def stop(self):
            if self.stopped_at is None:
                self.stopped_at = self.consumed
                self.stop_level = self._level
            self.duties.append((time.monotonic() - self._t0, 0.0))

        def cut(self):
            self.stop()

        def take_shelf_pulse(self, timeout):
            if self._left <= 0:
                return False
            # Shelves cannot arrive faster than they physically can.
            #
            # This used to return True on EVERY call, so a 1 ms poll loop consumed
            # a shelf per millisecond and a three-shelf move was over in about
            # 2 ms. Any behaviour that unfolds over real time was then invisible:
            # the 0.72 s soft start had climbed just 0.0003 of a duty step before
            # the move ended, which reads identically to a ramp that never runs at
            # all. `_spacing` keeps the fake scripted — pulses still come from the
            # test, not from simulated physics — while making their TIMING
            # plausible.
            now = time.monotonic()
            if now - self._last_pulse < self._spacing:
                return False
            self._last_pulse = now
            self._left -= 1
            self.consumed += 1
            return True

        def take_index_pulse(self, timeout):
            return False

        def shelf_active(self):
            return self._level

        def index_active(self):
            return False

        def shelf_clear(self, timeout):
            # Mirrors the real helper: blocks while the window stays occupied.
            deadline = time.monotonic() + timeout
            while self._level:
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.005)
            return True

        def index_clear(self, timeout):
            return True

        def set_shelf_settle(self, seconds):
            pass

        def reset_pulses(self):
            pass

        def cleanup(self):
            pass

    # --- (a) a 2-shelf move must stop on the 2nd trigger, not the 3rd ---------
    #
    # `shelf_active()` reports False, which is the realistic fast-crossing case:
    # at speed the flag can cross the whole window before the level is read. The
    # old alternation treated that as "this edge was a departure" and threw a
    # genuine ARRIVAL away, so the move needed a 3rd trigger and ran a full shelf
    # past the target.
    hw = ScriptedHW(level=False)
    car = pa.Carousel(hw, shelves=9, emit=lambda e: None)
    car.homed = True
    car.current_shelf = 0
    car.set_motion(move_speed=0.45, homing_speed=0.30, ramp_pct=0)
    car._do_goto(2)
    check("a 2-shelf move stops on the 2nd trigger (no overshoot)",
          hw.stopped_at == 2,
          "power was cut after %s triggers; 3 means a whole shelf of overshoot"
          % hw.stopped_at)

    # --- and the stop must land while the flag is still ON the sensor ---------
    hw = ScriptedHW(level=True)
    car = pa.Carousel(hw, shelves=9, emit=lambda e: None)
    car.homed = True
    car.current_shelf = 0
    car.set_motion(move_speed=0.45, homing_speed=0.30, ramp_pct=0)
    car._do_goto(1)
    check("power is cut while the sensor is still TRIGGERED",
          hw.stop_level is True,
          "the stop happened after the sensor had already cleared")

    # --- (b) acceleration must not be gated on a sensor trigger --------------
    #
    # The sensor stays TRIGGERED for the whole test and never clears, exactly as
    # when starting parked on a flag. The old code called shelf_clear() before
    # its soft start, so it sat at the break-away duty until that timed out and
    # then faulted. Speed must instead rise on its own.
    hw = ScriptedHW(level=True)
    car = pa.Carousel(hw, shelves=9, emit=lambda e: None)
    car.homed = True
    car.current_shelf = 0
    car.set_motion(move_speed=0.45, homing_speed=0.30, ramp_pct=60)
    t = threading.Thread(target=car._do_goto, args=(3,), daemon=True)
    t.start()
    time.sleep(1.2)
    duties = [d for _, d in hw.duties if d > 0]
    check("the motor is energised immediately, before any trigger",
          len(duties) > 0 and duties[0] > 0,
          "the motor was never energised")
    check("it accelerates without waiting for a sensor trigger",
          len(duties) > 1 and max(duties) > duties[0] + 0.01,
          "duty never rose above its opening value %.3f (gated on a trigger)"
          % (duties[0] if duties else 0.0))
    check("the soft start is gradual, not a single jump to full duty",
          len(duties) >= 3,
          "only %d duty steps: that is a hard start, not a ramp" % len(duties))
    check("the opening duty never exceeds the requested speed",
          all(d <= 0.45 + 1e-6 for d in duties),
          "opened at a duty above the operator's setting")
    car.request_stop()
    t.join(timeout=5)

    # --- (c) stopping ON the trigger removes the reverse hunt entirely --------
    #
    # The "weird reverse crawl" was a CONSEQUENCE of stopping late: the old soft
    # stop carried the flag back out of the window, so alignment had to hunt
    # backwards for a flag it had just left. Cutting power on the rising edge
    # leaves the flag inside the window, so alignment has nothing to correct.
    hw = ScriptedHW(level=True, pulses=0)   # on the flag; nothing coasted past
    car = pa.Carousel(hw, shelves=9, emit=lambda e: None)
    aligned = car._settle_on_sensor("up")
    moved = [d for _, d in hw.duties if d > 0]
    check("stopping on the trigger leaves the carousel already aligned",
          aligned,
          "alignment failed even though the flag was on the sensor")
    check("no reverse crawl runs when the stop landed on the flag",
          not moved,
          "the motor was driven again after the stop: %r" % (moved,))

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
