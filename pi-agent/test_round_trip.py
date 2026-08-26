#!/usr/bin/env python3
"""
The user's exact complaint, end to end, with nothing spoofed.

    "IF I am on shelf 1, and go to shelf 2 okey. then it will pass the shelf 2
     with a few cm, okey. then IF I go back to shelf 1 it will reverse the motor
     BUT as soon as shelf 2 passing the sensor again it think it did sens
     shelf 1 and will stop."

Every earlier test either set the starting direction by hand or asserted on a
single move. Neither can catch this, because the bug only appears once a REAL
move has left its own footprint on the machine: the outbound move brakes after
seeing the flag, coasts a few cm past it, and the alignment crawl that follows
runs the OPPOSITE way. What the return move sees therefore depends on the true
sequence of motions, so the only honest test is to drive the real sequence and
then compare what the agent believes against where the shelf physically is.

The simulated machine models the two properties that create the bug:

  * the flag is a WINDOW of real width, not a point, and
  * braking begins only after the flag has been detected, so the carousel
    reliably comes to rest a short distance past it.

Positions are in shelves; 1.0 means "shelf 1's flag is exactly at the sensor".
"""

import sys
import threading
import time

sys.path.insert(0, ".")
import paternoster_agent as pa                      # noqa: E402

SHELVES = 6

# Half the flag width, in shelves. This number decides whether the bug can even
# happen, so it must reflect the real machine rather than the built-in
# simulator's default.
#
# On a real paternoster the shelf pitch is of the order of half a metre and the
# sensor flag is a few centimetres, so the window is a SMALL fraction of a pitch:
# 0.03 shelves models roughly a 30mm flag on a 500mm pitch. The agent's own
# SIM_SENSOR_HALF_WIDTH is 0.18 — a 180mm flag — which is so wide that a stop
# overshooting by "a few cm" still comes to rest INSIDE the window. That single
# unrealistic constant is why the existing simulations never reproduced this
# fault: they always parked on the flag, which is the easy case that already
# worked. The fault needs the carousel to come to rest CLEAR of the window.
HALF = 0.03

# How far past the flag the machine coasts once it starts braking. Larger than
# HALF, so the carousel reliably ends up outside the window: exactly the
# "it will pass the shelf with a few cm" condition being reported.
_results = []


def check(name, ok, detail=""):
    _results.append((name, ok))
    print("   [%s] %s%s" % ("PASS" if ok else "FAIL", name,
                            ("  (%s)" % detail) if detail and not ok else ""))


class RoundTripHW:
    """
    Coasting carousel with a finite-width flag at every integer position.

    Deliberately given real inertia: cutting power does not stop it, so a move
    that brakes on detecting a flag ends up parked just past that flag. That
    overshoot is the entire reason a reversal is ambiguous.
    """

    def __init__(self, start_pos=0.0, decel=1.4, gain=2.2):
        self.pos = float(start_pos)
        self.vel = 0.0
        self._duty = 0.0
        self._dir = 0            # -1 = "up" (index down), +1 = "down"
        self._decel = decel
        self._gain = gain
        self._lock = threading.RLock()
        self._shelf_edges = 0
        self._index_edges = 0
        self._prev_shelf = self._shelf_win()
        self._prev_index = self._index_win()
        self._running = True
        threading.Thread(target=self._tick, daemon=True).start()

    # ---- physics ---------------------------------------------------------
    def _shelf_win(self):
        return abs(self.pos - round(self.pos)) <= HALF

    def _index_win(self):
        return abs(self.pos - round(self.pos)) <= HALF and round(self.pos) % SHELVES == 0

    def _tick(self):
        last = time.monotonic()
        while self._running:
            time.sleep(0.004)
            now = time.monotonic()
            dt = now - last
            last = now
            with self._lock:
                target = self._duty * self._gain * self._dir
                if self._duty > 0:
                    self.vel = target
                else:
                    # Coasting: bleed speed off gradually, never instantly.
                    if self.vel > 0:
                        self.vel = max(0.0, self.vel - self._decel * dt)
                    elif self.vel < 0:
                        self.vel = min(0.0, self.vel + self._decel * dt)
                self.pos += self.vel * dt
                s, i = self._shelf_win(), self._index_win()
                if s != self._prev_shelf:
                    self._shelf_edges += 1
                    self._prev_shelf = s
                if i != self._prev_index:
                    self._index_edges += 1
                    self._prev_index = i

    # ---- motor -----------------------------------------------------------
    def forward(self, duty):
        with self._lock:
            self._duty, self._dir = float(duty), +1

    def backward(self, duty):
        with self._lock:
            self._duty, self._dir = float(duty), -1

    def stop(self):
        with self._lock:
            self._duty = 0.0          # power off; inertia carries on

    # ---- sensors ---------------------------------------------------------
    def shelf_active(self):
        with self._lock:
            return self._shelf_win()

    def index_active(self):
        with self._lock:
            return self._index_win()

    def _wait_edge(self, which, timeout):
        end = time.monotonic() + timeout
        with self._lock:
            start = self._shelf_edges if which == "shelf" else self._index_edges
        while time.monotonic() < end:
            with self._lock:
                now = self._shelf_edges if which == "shelf" else self._index_edges
            if now > start:
                return True
            time.sleep(0.004)
        return False

    def take_shelf_pulse(self, timeout):
        return self._wait_edge("shelf", timeout)

    def take_index_pulse(self, timeout):
        return self._wait_edge("index", timeout)

    def shelf_clear(self, timeout):
        end = time.monotonic() + timeout
        while self.shelf_active():
            if time.monotonic() >= end:
                return False
            time.sleep(0.004)
        return True

    def index_clear(self, timeout):
        end = time.monotonic() + timeout
        while self.index_active():
            if time.monotonic() >= end:
                return False
            time.sleep(0.004)
        return True

    def reset_pulses(self):
        pass          # edge counters are monotonic; waits snapshot them

    def cleanup(self):
        self._running = False


def build(hw, at_shelf):
    """A homed carousel that believes it is standing at `at_shelf`."""
    events = []
    car = pa.Carousel(hw, SHELVES, events.append)
    car.current_shelf = at_shelf
    car.homed = True
    car.ramp_pct = 0            # keep the runs quick and deterministic
    return car, events


def goto(car, target, timeout=45):
    done = threading.Event()
    car.request_goto(target)
    # request_goto runs on the worker thread; poll until it goes idle again.
    end = time.monotonic() + timeout
    time.sleep(0.25)
    while time.monotonic() < end:
        if car.status == "idle":
            done.set()
            break
        time.sleep(0.05)
    time.sleep(0.35)            # let any final coast finish
    return done.is_set()


def physical(hw):
    """Which shelf is actually at the sensor."""
    return int(round(hw.pos)) % SHELVES


def main():
    print("=" * 70)
    print("THE REPORTED FAULT: shelf 1 -> 2, then straight back 2 -> 1")
    print("=" * 70)
    print("Nothing is spoofed. The outbound move creates its own overshoot and")
    print("its own alignment crawl, and the return move has to cope with both.")
    print()

    hw = RoundTripHW(start_pos=1.0)
    car, ev = build(hw, 1)

    goto(car, 2)
    out_phys, out_rep = physical(hw), car.current_shelf
    print("   outbound: physical shelf %d (pos %+.3f), agent says %d"
          % (out_phys, hw.pos, out_rep))
    check("outbound 1->2 lands on shelf 2", out_phys == 2 and out_rep == 2,
          "physical=%d reported=%d" % (out_phys, out_rep))

    # This is the move that used to stop dead on shelf 2's own flag.
    goto(car, 1)
    back_phys, back_rep = physical(hw), car.current_shelf
    print("   return:   physical shelf %d (pos %+.3f), agent says %d"
          % (back_phys, hw.pos, back_rep))
    check("return 2->1 actually reaches shelf 1", back_phys == 1,
          "physically on shelf %d" % back_phys)
    check("return 2->1 reports what it did", back_rep == back_phys,
          "physical=%d reported=%d" % (back_phys, back_rep))
    check("did not stop on shelf 2's flag", back_phys != 2,
          "still on shelf 2 (pos %+.3f)" % hw.pos)
    car.shutdown(); hw.cleanup()

    # ------------------------------------------------------------------
    print()
    print("=" * 70)
    print("SAME DIRECTION TWICE MUST STILL COUNT NORMALLY")
    print("=" * 70)
    print("The re-entry skip must fire ONLY on a genuine reversal, or a move")
    print("carrying on the same way would swallow a real shelf and overshoot.")
    print()

    hw = RoundTripHW(start_pos=1.0)
    car, ev = build(hw, 1)
    goto(car, 2)
    goto(car, 3)                      # same direction again
    p, r = physical(hw), car.current_shelf
    print("   after 1->2->3: physical shelf %d (pos %+.3f), agent says %d"
          % (p, hw.pos, r))
    check("consecutive same-direction moves land correctly",
          p == 3 and r == 3, "physical=%d reported=%d" % (p, r))
    car.shutdown(); hw.cleanup()

    # ------------------------------------------------------------------
    print()
    print("=" * 70)
    print("REPEATED BACK-AND-FORTH MUST NOT ACCUMULATE ERROR")
    print("=" * 70)
    print("A one-shelf miscount per reversal compounds, so flipping direction")
    print("many times is where any residual drift becomes obvious.")
    print()

    hw = RoundTripHW(start_pos=1.0)
    car, ev = build(hw, 1)
    ok_all = True
    for tgt in [2, 1, 2, 1, 3, 1]:
        goto(car, tgt)
        p, r = physical(hw), car.current_shelf
        ok = (p == tgt and r == tgt)
        print("   asked %d -> physical %d (pos %+.3f), says %d  %s"
              % (tgt, p, hw.pos, r, "ok" if ok else "WRONG"))
        if not ok:
            ok_all = False
    check("no drift across six direction changes", ok_all)
    car.shutdown(); hw.cleanup()

    # ------------------------------------------------------------------
    print()
    print("=" * 70)
    failed = [n for n, ok in _results if not ok]
    if failed:
        print("%d CHECK(S) FAILED:" % len(failed))
        for n in failed:
            print("   - " + n)
    else:
        print("ALL CHECKS PASSED (%d)" % len(_results))
    print("=" * 70)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
