#!/usr/bin/env python3
"""
Alignment under MOMENTUM.

Every other harness stops the carousel dead the instant power is cut, which is
physically false and hid the reported failure: "it passes the sensor and goes
backward, but passes it again going backward, so it loops on the same shelf
forever while the browser counts up through shelves".

That loop needs coasting to reproduce. Here `stop()` only removes power; the
carousel keeps travelling until friction absorbs its momentum. Three properties
are asserted:

  1. CONVERGENCE. A move that overshoots is corrected and comes to rest with the
     sensor triggered, without oscillating back and forth indefinitely.

  2. HONESTY WHEN IMPOSSIBLE. If the machine cannot physically stop inside the
     window (coasting distance exceeds the window itself), the agent must NOT
     claim an arrival. It reports a fault telling the user to home, and drops
     `homed`, because the true position is genuinely unknown.

  3. HOMING RESTS ON THE HOME FLAG. Homing stops on an index edge and then
     coasts past it, so it must crawl back until the home sensor is triggered
     and stay there.
"""
import sys
import threading
import time

sys.path.insert(0, "/vercel/share/v0-project/pi-agent")
import paternoster_agent as pa

HALF = pa.SIM_SENSOR_HALF_WIDTH


class CoastingHW:
    """
    Velocity-modelled hardware: cutting power starts a coast, it does not stop
    the carousel. `decel` is friction in shelves/s^2 — lower means heavier.
    """

    def __init__(self, shelves=9, start_pos=0.0, decel=1.5):
        self.shelves = shelves
        self.pos = start_pos
        self.decel = decel
        self.vel = 0.0          # signed, shelves/sec
        self._target = 0.0      # commanded velocity while powered
        self._powered = False
        self._lock = threading.Lock()
        self._shelf_pulses = 0
        self._index_pulses = 0
        self._tick = threading.Event()
        self._itick = threading.Event()
        self._was_active = self._window(start_pos)
        self.reversals = 0
        self._last_sign = 0
        self._alive = True
        threading.Thread(target=self._spin, daemon=True).start()

    # ---- geometry ----
    def _window(self, pos):
        return abs(pos - round(pos)) <= HALF

    def _index_window(self, pos):
        return self._window(pos) and int(round(pos)) % self.shelves == 0

    # ---- physics ----
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
                    # Coast: friction pulls speed toward zero.
                    drop = self.decel * dt
                    if abs(self.vel) <= drop:
                        self.vel = 0.0
                    else:
                        self.vel -= drop if self.vel > 0 else -drop
                self.pos += self.vel * dt

                sign = 0 if self.vel == 0 else (1 if self.vel > 0 else -1)
                if sign != 0 and self._last_sign != 0 and sign != self._last_sign:
                    self.reversals += 1
                if sign != 0:
                    self._last_sign = sign

                active = self._window(self.pos)
                if active != self._was_active:
                    self._shelf_pulses += 1
                    self._tick.set()
                    if int(round(self.pos)) % self.shelves == 0:
                        self._index_pulses += 1
                        self._itick.set()
                self._was_active = active
            time.sleep(0.002)

    # ---- motor API ----
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

    # ---- sensor API ----
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

    def shelf_clear(self, timeout):
        deadline = time.monotonic() + timeout
        while self.shelf_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def index_active(self):
        with self._lock:
            return self._index_window(self.pos)

    def index_clear(self, timeout):
        deadline = time.monotonic() + timeout
        while self.index_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def cleanup(self):
        self._alive = False


def _run(hw, action, homed=True, speed=0.45, ramp=40, timeout=45):
    events = []
    c = pa.Carousel(hw, shelves=hw.shelves, emit=lambda e: events.append(e))
    c.homed = homed
    c.current_shelf = 0
    c.set_motion(move_speed=speed, ramp_pct=ramp)
    action(c)
    deadline = time.monotonic() + timeout
    while c.status == "idle" and time.monotonic() < deadline:
        time.sleep(0.005)
    while c.status != "idle" and time.monotonic() < deadline:
        time.sleep(0.02)
    time.sleep(0.4)
    c.shutdown()
    return c, events


def _kinds(events):
    return [e.get("type") for e in events]


def main():
    failures = []

    def check(ok, label, detail=""):
        print("  %-5s %s  %s" % ("ok" if ok else "FAIL", label, detail))
        if not ok:
            failures.append(label)

    # Coasting distance at creep duty, for reference:
    #   v = CREEP_DUTY / 0.4 ;  d = v^2 / (2 * decel)
    v_creep = pa.CREEP_DUTY / 0.4

    print("=" * 70)
    print(" 1/3  overshoot is corrected and converges (heavy but stoppable)")
    print("=" * 70)
    # decel 1.5 => creep coast ~0.13 shelves, inside the 0.18 window, so the
    # machine CAN stop on the flag. It must actually do so, and must not
    # oscillate to get there.
    for decel in (1.5, 2.5, 4.0):
        hw = CoastingHW(decel=decel)
        coast = v_creep ** 2 / (2 * decel)
        t0 = time.monotonic()
        c, events = _run(hw, lambda c: c.request_goto(1))
        took = time.monotonic() - t0
        off = abs(hw.pos - round(hw.pos))
        kinds = _kinds(events)
        check(hw.shelf_active() and "arrived" in kinds and hw.reversals <= 4,
              "decel %.1f: parked on sensor, no oscillation" % decel,
              "[off=%.3f edge=%.2f coast=%.3f reversals=%d %.1fs]"
              % (off, HALF, coast, hw.reversals, took))
        hw.cleanup()

    print()
    print("=" * 70)
    print(" 2/3  when it CANNOT stop in the window, say so instead of guessing")
    print("=" * 70)
    # decel 0.35 => creep coast ~0.56 shelves, far wider than the 0.18 window.
    # No control strategy can park inside it, so the honest outcome is a fault
    # telling the user to home — never a fabricated arrival.
    hw = CoastingHW(decel=0.35)
    coast = v_creep ** 2 / (2 * 0.35)
    c, events = _run(hw, lambda c: c.request_goto(1), timeout=60)
    kinds = _kinds(events)
    faults = [e for e in events if e.get("type") == "fault"]
    msg = faults[0].get("message", "") if faults else ""
    check("arrived" not in kinds,
          "no arrival claimed when position is unknown",
          "[events=%s coast=%.2f]" % (kinds, coast))
    check(bool(faults) and "home" in msg.lower(),
          "fault tells the user to home the carousel",
          "[%r]" % msg)
    check(c.homed is False,
          "homed reference dropped so the shelf number is not trusted",
          "[homed=%s]" % c.homed)
    check(hw.reversals <= 6,
          "gives up instead of oscillating forever",
          "[reversals=%d]" % hw.reversals)
    hw.cleanup()

    print()
    print("=" * 70)
    print(" 3/3  homing comes to rest ON the home flag")
    print("=" * 70)
    for decel in (1.5, 2.5, 4.0):
        # Start away from home so homing has to travel and then stop on the flag.
        hw = CoastingHW(start_pos=3.0, decel=decel)
        c, events = _run(hw, lambda c: c.request_home(), homed=False, timeout=60)
        kinds = _kinds(events)
        off = abs(hw.pos - round(hw.pos))
        on_home = hw.index_active()
        check(on_home and "homed" in kinds,
              "decel %.1f: resting on the home flag" % decel,
              "[off=%.3f on_home=%s homed=%s events=%s]"
              % (off, on_home, c.homed, kinds[-3:]))
        hw.cleanup()

    print()
    print("=" * 70)
    if failures:
        print(" %d CHECK(S) FAILED: %s" % (len(failures), failures))
        return 1
    print(" ALL CHECKS PASSED: alignment converges under momentum.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
