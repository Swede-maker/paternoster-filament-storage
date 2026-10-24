"""
Proves a "move one shelf" request advances the carousel by exactly ONE shelf.

The bug this pins down: `_drive()` BLOCKS for the whole soft-start ramp, and the
old code then slept PULSE_BLANKING and called reset_pulses(). At ramp 40% that
discarded every pulse in the first ~0.63s, but a shelf only takes ~0.5-0.9s to
arrive, so the genuine first pulse was thrown away and the NEXT carrier was
counted in its place. The carousel physically travelled two shelves while
reporting one — exactly the "shelf 1 passed the sensor so it thinks shelf 2 just
passed" symptom seen on the real machine.

We measure PHYSICAL travel, not the reported count, because the reported count
was self-consistently wrong.
"""
import sys, threading, time

sys.path.insert(0, "/vercel/share/v0-project/pi-agent")
import paternoster_agent as pa


class FakeHW:
    """
    Physical model of the carousel. Position is measured in shelves, and a shelf
    pulse fires each time an integer boundary is crossed — the same thing the
    inductive sensor does when a carrier passes it.
    """

    def __init__(self, shelves=9):
        self.shelves = shelves
        self.pos = 0.0
        self._dir = 0
        self._speed = 0.0
        self._lock = threading.Lock()
        self._shelf_pulses = 0
        self._index_pulses = 0
        self._shelf_tick = threading.Event()
        self._index_tick = threading.Event()
        # Parked at 0.0 is inside the window, so seed the edge detector active.
        self._shelf_was_active = True
        self._running = True
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()

    def _loop(self):
        last = time.monotonic()
        while self._running:
            now = time.monotonic()
            dt = now - last
            last = now
            with self._lock:
                if self._dir != 0 and self._speed > 0:
                    # Same scaling the other harness uses: duty 0.4 => 1 shelf/s.
                    self.pos += self._dir * dt * (self._speed / 0.4)
                # ENTRY EDGE ONLY — metal arriving in front of the sensor.
                #
                # This mirrors the real driver, where the shelf pulse counter is
                # wired to `when_activated` alone; `when_deactivated` goes to a
                # separate exit handler and does NOT raise a shelf pulse.
                #
                # This harness used to count BOTH edges, on the reasoning that an
                # inductive sensor is a level and leaving the window is as much a
                # transition as entering it. True of the level, but not of what the
                # counter is fed: counting both doubled every shelf, so a 3-shelf
                # move "completed" after 1.18 shelves of travel. It encoded the
                # very fault being fixed — treating a full
                # HIGH -> LOW -> HIGH round trip as the unit of progress instead
                # of the moment metal arrives.
                active = self._shelf_window_active()
                if active and not self._shelf_was_active:
                    self._shelf_pulses += 1
                    self._shelf_tick.set()
                    if int(round(self.pos)) % self.shelves == 0:
                        self._index_pulses += 1
                        self._index_tick.set()
                self._shelf_was_active = active
            time.sleep(0.002)

    def _shelf_window_active(self):
        return abs(self.pos - round(self.pos)) <= pa.SIM_SENSOR_HALF_WIDTH

    def forward(self, speed):
        with self._lock:
            self._dir, self._speed = +1, speed

    def backward(self, speed):
        with self._lock:
            self._dir, self._speed = -1, speed

    def stop(self):
        with self._lock:
            self._dir, self._speed = 0, 0.0

    def reset_pulses(self):
        with self._lock:
            self._shelf_pulses = self._index_pulses = 0
        self._shelf_tick.clear()
        self._index_tick.clear()

    def _take(self, kind, timeout):
        tick = self._shelf_tick if kind == "shelf" else self._index_tick
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
            tick.clear()
            tick.wait(min(remaining, 0.05))

    def take_shelf_pulse(self, t):
        return self._take("shelf", t)

    def take_index_pulse(self, t):
        return self._take("index", t)

    def index_active(self):
        return False

    def index_clear(self, timeout):
        return True

    def shelf_active(self):
        with self._lock:
            return self._shelf_window_active()

    def shelf_clear(self, timeout):
        deadline = time.monotonic() + timeout
        while self.shelf_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def cleanup(self):
        self._running = False


def travel_for(ramp_pct, move_speed, steps=1, shelves=9):
    """Return (physical shelves moved, reported shelf, event kinds)."""
    events = []
    hw = FakeHW(shelves=shelves)
    car = pa.Carousel(hw, shelves, lambda e: events.append(e))
    car.set_motion(move_speed=move_speed, ramp_pct=ramp_pct)
    # The real machine sits parked with the carrier just past the sensor.
    car.homed = True
    car.current_shelf = 0
    start = hw.pos
    try:
        car.request_goto(steps % shelves)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if car.status == "idle" and any(
                e.get("type") in ("arrived", "fault") for e in events
            ):
                break
            time.sleep(0.02)
        time.sleep(0.1)  # let any post-stop coast settle
        moved = abs(hw.pos - start)
    finally:
        car.shutdown()
        hw.cleanup()
    return moved, car.current_shelf, [e.get("type") for e in events]


def main():
    failures = []
    print("Physical travel for a ONE-shelf request")
    print("(a result near 2.0 is the off-by-one overshoot)\n")
    print(f"{'ramp%':>6} {'speed':>6} {'moved':>8}  verdict")

    for ramp in (0, 20, 40, 60, 80, 100):
        for speed in (0.35, 0.45, 0.7, 1.0):
            moved, reported, kinds = travel_for(ramp, speed)
            ok = moved < 1.5 and "fault" not in kinds
            if not ok:
                failures.append((ramp, speed, moved, kinds))
            print(f"{ramp:>6} {speed:>6.2f} {moved:>8.2f}  {'ok' if ok else 'OVERSHOOT'}")

    print("\nMulti-shelf moves (3 shelves requested)")
    for ramp in (0, 40, 100):
        moved, reported, kinds = travel_for(ramp, 0.45, steps=3)
        ok = 2.5 <= moved < 3.5 and "fault" not in kinds
        if not ok:
            failures.append((ramp, 0.45, moved, kinds))
        print(f"  ramp {ramp:>3}%  moved {moved:.2f}  reported {reported}  "
              f"{'ok' if ok else 'WRONG'}")

    print()
    if failures:
        for ramp, speed, moved, kinds in failures:
            print(f"FAILED: ramp={ramp}% speed={speed} moved={moved:.2f} events={kinds}")
        sys.exit(1)
    print("ALL CHECKS PASSED: one-shelf requests move exactly one shelf.")


if __name__ == "__main__":
    main()
