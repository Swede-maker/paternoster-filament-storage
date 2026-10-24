"""
Proves motor power is no longer gated by sensor state.

FakeHW models the physical reality that broke things: the carousel is PARKED with
a shelf sitting inside the sensor window, so the sensors read ACTIVE before
anything moves. It records how long the motor was actually energised, because
that is the number the old code got wrong (microseconds instead of seconds).
"""
import sys, threading, time

sys.path.insert(0, "/vercel/share/v0-project/pi-agent")
import paternoster_agent as pa


class FakeHW:
    """Physical model: pulses only happen when the motor is actually powered."""

    def __init__(self, shelves=9, start_on_flag=True):
        self.shelves = shelves
        self._pos = 0.0
        self._dir = 0
        self._speed = 0.0
        self._lock = threading.Lock()
        self._shelf_pulses = 0
        self._index_pulses = 0
        self._shelf_tick = threading.Event()
        self._index_tick = threading.Event()
        # The whole point: the sensor is covered while parked. Position 0.0 sits
        # inside both windows, so "on the flag" is now expressed as a position
        # rather than a latched boolean.
        self._pos = 0.0 if start_on_flag else shelves / 2.0
        # Parked at 0.0 means the shelf window is already active, so seed the
        # edge detector True or startup fabricates a pulse that never happened.
        self._shelf_was_active = True
        self.motor_on_time = 0.0
        self.power_cycles = 0
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
                    self.motor_on_time += dt
                    self._pos += self._dir * dt * (self._speed / 0.4)
                # Shelf edges are derived from the window LEVEL, matching both
                # gpiozero's when_activated and SimHardware. A zero-width
                # tripwire is never active at rest, so it cannot model a
                # carousel parked inside the sensor window.
                active = self._shelf_window_active()
                if active != self._shelf_was_active:
                    self._shelf_pulses += 1
                    self._shelf_tick.set()
                    if int(round(self._pos)) % self.shelves == 0:
                        self._index_pulses += 1
                        self._index_tick.set()
                self._shelf_was_active = active
            time.sleep(0.002)

    def _shelf_window_active(self):
        return abs(self._pos - round(self._pos)) <= pa.SIM_SENSOR_HALF_WIDTH

    # The home flag is a real window at every full revolution, exactly like the
    # shelf flags. It used to be a latched boolean cleared by `abs(pos) > 0.25`,
    # which only described position 0 and so reported "off the home flag"
    # everywhere else — homing could never align onto it.
    def _index_window_active(self):
        return self._shelf_window_active() and int(round(self._pos)) % self.shelves == 0

    def forward(self, speed):
        with self._lock:
            if self._dir == 0:
                self.power_cycles += 1
            self._dir, self._speed = +1, speed

    def backward(self, speed):
        with self._lock:
            if self._dir == 0:
                self.power_cycles += 1
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
        with self._lock:
            return self._index_window_active()

    def index_clear(self, timeout):
        deadline = time.monotonic() + timeout
        while self.index_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
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


def run(label, fn):
    events = []
    hw = FakeHW()
    car = pa.Carousel(hw, 9, lambda e: events.append(e))
    try:
        fn(car)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if car.status == "idle" and any(
                e.get("type") in ("homed", "arrived", "fault") for e in events
            ):
                break
            time.sleep(0.05)
    finally:
        car.shutdown()
        hw.cleanup()
    kinds = [e.get("type") for e in events]
    print(f"\n=== {label} ===")
    print(f"  motor powered for : {hw.motor_on_time:.2f}s")
    print(f"  power cycles      : {hw.power_cycles}")
    print(f"  events            : {kinds}")
    print(f"  final shelf       : {car.current_shelf}  homed={car.homed}")
    return hw, car, events


print("Sensor starts ACTIVE (carousel parked on the flag) — the failing case.")

hw, car, ev = run("HOME while parked on index flag", lambda c: c.request_home())
assert hw.motor_on_time > 0.3, f"motor barely ran ({hw.motor_on_time:.3f}s) - still gated!"
assert "homed" in [e.get("type") for e in ev], "homing did not complete"
print("  -> motor ran for a real duration and homing completed")

hw2, car2, ev2 = run("GOTO 4 shelves while un-homed", lambda c: c.request_goto(4))
assert hw2.motor_on_time > 0.3, f"motor barely ran ({hw2.motor_on_time:.3f}s)"
assert "fault" not in [e.get("type") for e in ev2], "un-homed move was refused"
print("  -> un-homed move ran instead of being refused")

print("\nAll gating assertions passed.")
