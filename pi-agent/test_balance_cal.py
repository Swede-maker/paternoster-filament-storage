"""
Motor balance auto-calibration: two simulated chains, motor B intrinsically
`bias` faster than motor A for the same duty. Starting with both flags in
their sensors, the run must time both chains over N turns, hold the first to
finish, and set a trim that makes them equal (B slowed by 1 - 1/(1+bias)).
A second run from the trimmed state must land on the same value.
Run: python3 test_balance_cal.py
"""
import sys, time

import paternoster_agent as pa


class TwoChainHW(pa.SimHardware):
    """Chain A = the sim's own position (shelf sensor). Chain B = a second
    position integrated here (home sensor), faster by `bias`."""

    def __init__(self, shelves, bias):
        super().__init__(shelves, "dc")
        self.dc_trim_pct = 0.0
        self.bias = bias
        self.cmd_speed = 0.0
        self._pos_b = 0.0
        self._b_held = False
        self._a_held = False
        self._last_b = time.monotonic()
        self.holds = []

    def _scales(self):
        t = float(self.dc_trim_pct)
        return (1.0 + t / 100.0 if t < 0 else 1.0, 1.0 - t / 100.0 if t > 0 else 1.0)

    def _apply(self):
        sa, _ = self._scales()
        with self._lock:
            self._dir = 1 if self.cmd_speed > 0 and not self._a_held else 0
            self._speed = self.cmd_speed * sa

    def forward(self, speed):
        self.cmd_speed = float(speed)
        self._apply()

    def backward(self, speed):
        self.forward(speed)

    def stop(self):
        self.cmd_speed = 0.0
        self._a_held = self._b_held = False
        self._apply()

    def can_chain_sync(self):
        return True

    def hold_one(self, index):
        self.holds.append(index)
        if index == 0:
            self._a_held = True
            self._apply()
        else:
            self._b_held = True

    def release_one(self, index, forward, speed):
        if index == 0:
            self._a_held = False
            self._apply()
        else:
            self._b_held = False

    def _advance_b(self):
        now = time.monotonic()
        dt = now - self._last_b
        self._last_b = now
        if self.cmd_speed > 0 and not self._b_held:
            _, sb = self._scales()
            self._pos_b += dt * (self.cmd_speed * sb * (1.0 + self.bias) / 0.4)

    def index_active(self):
        self._advance_b()
        # Same window geometry as the sim's shelf flag, once per lap.
        frac = self._pos_b - round(self._pos_b)
        return abs(frac) <= pa.SIM_SENSOR_HALF_WIDTH and int(round(self._pos_b)) % self.shelves == 0

    def shelf_active(self):
        return super().shelf_active()


def run(hw, shelves, turns):
    events = []
    car = pa.Carousel(hw, shelves, lambda e: events.append(e))
    car.set_motion(move_speed=0.8, ramp_pct=0)
    car.set_chain_sync(shelf_side="a")
    try:
        car.request_balance_calibrate(turns)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if any(e.get("type") == "balance" and e.get("phase") in ("done", "failed") for e in events):
                break
            time.sleep(0.02)
    finally:
        car.shutdown()
    return [e for e in events if e.get("type") == "balance"]


def main():
    shelves, bias, turns = 6, 0.03, 2
    expected = (1.0 - 1.0 / (1.0 + bias)) * 100.0

    hw = TwoChainHW(shelves, bias)
    frames = run(hw, shelves, turns)
    done = frames[-1]
    print("run 1:", done.get("phase"), done.get("message"))
    assert done.get("phase") == "done", frames
    assert hw.holds == [1], f"motor B (faster) should have been held once, got {hw.holds}"
    assert done["trimPct"] > 0, "B is faster so the trim must slow B (positive)"
    assert abs(done["trimPct"] - expected) < 0.15, f"trim {done['trimPct']} vs expected {expected:.3f}"
    assert done["bMs"] < done["aMs"]

    # Second pass from the trimmed state must converge on the same number.
    hw2 = TwoChainHW(shelves, bias)
    hw2.dc_trim_pct = done["trimPct"]
    frames2 = run(hw2, shelves, turns)
    done2 = frames2[-1]
    print("run 2:", done2.get("phase"), done2.get("message"))
    assert done2.get("phase") == "done", frames2
    assert abs(done2["trimPct"] - expected) < 0.15, f"second pass {done2['trimPct']} vs {expected:.3f}"

    # Not parked on the flags: must refuse without moving.
    hw3 = TwoChainHW(shelves, bias)
    hw3._pos = 2.5
    frames3 = run(hw3, shelves, turns)
    assert frames3[-1].get("phase") == "failed" and "Not ready" in frames3[-1]["message"], frames3
    assert hw3.cmd_speed == 0.0

    print("OK: expected trim B -%.3f %%, measured %.3f then %.3f" % (expected, done["trimPct"], done2["trimPct"]))


if __name__ == "__main__":
    try:
        main()
    except AssertionError as exc:
        print("FAIL:", exc)
        sys.exit(1)
