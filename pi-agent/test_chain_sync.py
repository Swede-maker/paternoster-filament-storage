"""
Chain sync at shelf 1: with the home sensor lagging the shelf sensor by more
than the tolerance, the shelf-side bridge must be held once the lead exceeds
the tolerance and released when the home flag arrives; with the lag inside the
tolerance nothing may be held. Run: python3 test_chain_sync.py
"""
import sys, time

import paternoster_agent as pa


class LaggingHomeHW(pa.SimHardware):
    """Two-bridge DC sim whose home flag trails the shelf flag by `lag_s`."""

    def __init__(self, shelves, lag_s):
        super().__init__(shelves, "dc")
        self.lag_s = lag_s
        self.holds = []
        self.releases = []
        self._rise = None
        self._was_active = False

    def can_chain_sync(self):
        return True

    def hold_one(self, index):
        self.holds.append((index, time.monotonic()))
        if index == 0:
            # The shelf flag rides on chain A: holding bridge A freezes the
            # simulated position, as the real shelf sensor would stop counting.
            with self._lock:
                self._held_dir, self._held_speed = self._dir, self._speed
                self._dir, self._speed = 0, 0.0

    def release_one(self, index, forward, speed):
        self.releases.append((index, time.monotonic()))
        if index == 0:
            with self._lock:
                self._dir, self._speed = self._held_dir, speed

    def index_active(self):
        # A delayed copy of the real window: active from lag_s after the real
        # flag arrived, for about as long as the real window stays open.
        now = time.monotonic()
        real = super().index_active()
        if real and not self._was_active:
            self._rise = now
        self._was_active = real
        return self._rise is not None and self.lag_s <= now - self._rise <= self.lag_s + 0.4


def run(lag_s, tolerance_ms, start, target, shelves=8):
    events = []
    hw = LaggingHomeHW(shelves, lag_s)
    hw._pos = float(start)
    car = pa.Carousel(hw, shelves, lambda e: events.append(e))
    car.set_motion(move_speed=0.6, ramp_pct=0)
    car.set_chain_sync(enabled=True, tolerance_ms=tolerance_ms, shelf_side="a")
    car.homed = True
    car.current_shelf = start
    try:
        car.request_goto(target)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if car.status == "idle" and any(e.get("type") in ("arrived", "fault") for e in events):
                break
            time.sleep(0.02)
    finally:
        car.shutdown()
        hw.cleanup()
    kinds = [e.get("type") for e in events]
    car.events = events
    return hw, car, kinds


def main():
    failures = []

    # Mid-lap pass: 6 -> 1 goes down through 7, 0 (shelf 1), 1.
    hw, car, kinds = run(lag_s=0.3, tolerance_ms=100, start=6, target=1)
    print(f"mid-lap, lag 300 ms / tol 100 ms: holds={[('A' if i == 0 else 'B') for i, _ in hw.holds]} "
          f"releases={[('A' if i == 0 else 'B') for i, _ in hw.releases]} lead={car._chain_sync_last_lead_ms} "
          f"corrected={car._chain_sync_last_corrected} shelf={car.current_shelf} events={kinds[-2:]}")
    if "fault" in kinds or car.current_shelf != 1:
        failures.append("mid-lap move did not arrive cleanly with sync on")
    if not hw.holds or any(i != 0 for i, _ in hw.holds):
        failures.append("expected the shelf-side bridge (A) to be held when the shelf sensor leads")
    if len(hw.releases) < len(hw.holds):
        failures.append("every held bridge must be released again")
    if car._chain_sync_last_lead_ms is None or not (200 <= car._chain_sync_last_lead_ms <= 500):
        failures.append(f"recorded lead {car._chain_sync_last_lead_ms} ms, expected roughly 300")
    if not car._chain_sync_last_corrected:
        failures.append("pass should be marked corrected")

    # Parking on shelf 1: 2 -> 0 goes down through 1 and stops on 0.
    hw, car, kinds = run(lag_s=0.3, tolerance_ms=100, start=2, target=0)
    print(f"park,    lag 300 ms / tol 100 ms: holds={[('A' if i == 0 else 'B') for i, _ in hw.holds]} "
          f"lead={car._chain_sync_last_lead_ms} corrected={car._chain_sync_last_corrected} "
          f"shelf={car.current_shelf} events={kinds[-2:]}")
    if "fault" in kinds or car.current_shelf != 0:
        failures.append("parking move did not arrive cleanly with sync on")
    if not hw.holds or hw.holds[-1][0] != 0:
        failures.append("parking on shelf 1 with the shelf sensor first must hold bridge A for the home side")
    if car._chain_sync_last_lead_ms is None or not (200 <= car._chain_sync_last_lead_ms <= 500):
        failures.append(f"parking lead {car._chain_sync_last_lead_ms} ms, expected roughly 300")

    hw, car, kinds = run(lag_s=0.05, tolerance_ms=200, start=6, target=1)
    print(f"mid-lap, lag 50 ms / tol 200 ms:  holds={hw.holds} lead={car._chain_sync_last_lead_ms} "
          f"corrected={car._chain_sync_last_corrected} events={kinds[-2:]}")
    if "fault" in kinds:
        failures.append("move faulted with sync on (inside tolerance)")
    if hw.holds:
        failures.append("nothing may be held while the lead is inside the tolerance")
    if car._chain_sync_last_corrected:
        failures.append("pass inside tolerance must not be marked corrected")

    # Dead home sensor: the shelf side is held, the home side drives on alone
    # and its flag never comes. The move must end in a safety-stop fault with
    # both bridges cut, the position dropped and no "arrived".
    t0 = time.monotonic()
    hw, car, kinds = run(lag_s=1e9, tolerance_ms=100, start=6, target=1)
    took = time.monotonic() - t0
    faults = [e for e in car.events if e.get("type") == "fault"]
    print(f"dead home sensor:                holds={[('A' if i == 0 else 'B') for i, _ in hw.holds]} "
          f"homed={car.homed} status={car.status} took={took:.1f}s events={kinds[-2:]}")
    if "fault" not in kinds or "arrived" in kinds:
        failures.append("dead sensor must end in a fault, not an arrival")
    if car.homed:
        failures.append("safety stop must drop the position (homed=False)")
    if car.status != "idle":
        failures.append("safety stop must leave the carousel idle")
    if not hw.holds:
        failures.append("the leading bridge must have been held before the safety stop")
    if hw.releases:
        failures.append("safety stop must not release the held bridge back into drive")
    if took > pa.CHAIN_SYNC_MAX_WAIT_S + 30:
        failures.append(f"safety stop took {took:.1f}s, expected within the wait cap of the pass")
    if not any("safety stop" in str(e.get("message", "")).lower() for e in faults):
        failures.append("fault message must say it was a chain sync safety stop")

    if failures:
        print("\nFAILURES:")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    print("\nALL CHECKS PASSED: chain sync holds the leading bridge only past the tolerance.")


if __name__ == "__main__":
    main()
