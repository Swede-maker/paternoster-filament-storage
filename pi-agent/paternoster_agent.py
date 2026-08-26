#!/usr/bin/env python3
"""
PAX paternoster — Raspberry Pi GPIO agent.

This program runs ON a Raspberry Pi and drives one paternoster carousel:
  * a DC motor via a BTS7960 / IBT-2 half-bridge with PWM speed control, and
  * two inductive proximity sensors:
      - SHELF sensor: pulses once as every shelf passes the pick window,
      - INDEX sensor: active only at shelf 1 (the home / absolute reference).

It exposes a WebSocket server that the PAX web app connects to. The wire format
matches `lib/node-protocol.ts` in the web app exactly:

  app  -> pi : {"type":"home"} | {"type":"goto","shelf":N} | {"type":"stop"}
               | {"type":"config","shelves":N} | {"type":"hello"}
  pi   -> app: {"type":"hello",...} | {"type":"state",...} | {"type":"pos","shelf":N}
               | {"type":"arrived","shelf":N} | {"type":"homed","shelf":N}
               | {"type":"fault","message":"..."}

Shelf indexes are 0-based on the wire (shelf 0 == the INDEX sensor position).

Run on the Pi:
    python3 paternoster_agent.py --name "Paternoster 1" --shelves 9

Test on a laptop (no GPIO hardware needed) with the built-in simulator:
    python3 paternoster_agent.py --simulate --shelves 9
"""

import argparse
import asyncio
import json
import threading
import time
from typing import Callable, Optional

# --------------------------------------------------------------------------
# Pin configuration (BCM numbering). Adjust to match your wiring.
# --------------------------------------------------------------------------
# BTS7960 / IBT-2 43A dual half-bridge. Unlike an L298N there is no single
# "enable = PWM" pin: RPWM and LPWM are BOTH PWM inputs and *which one* you drive
# picks the direction. Drive only one at a time — driving both together shoots
# through the bridge.
PIN_MOTOR_RPWM = 12  # -> RPWM (PWM, drives one direction)
PIN_MOTOR_LPWM = 13  # -> LPWM (PWM, drives the other direction)
PIN_MOTOR_EN = 22    # -> R_EN + L_EN tied together (HIGH = bridge enabled)
PIN_SHELF_SENSOR = 23  # inductive sensor: one pulse per shelf
PIN_INDEX_SENSOR = 24  # inductive sensor: active only at shelf 1 (home)

# Motion tuning. These are DEFAULTS ONLY — the app overrides them at runtime via
# the `config` command, so the speed and soft-start sliders reach the motor. Do
# not read these constants inside motion code; read the Carousel instance fields
# (self.move_speed / self.ramp_pct) or slider changes will silently do nothing.
HOMING_SPEED = 0.35   # 0..1 PWM duty during homing
MOVE_SPEED = 0.45     # 0..1 PWM duty during normal moves
# A BTS7960 with a geared carousel will not break stiction much below this duty;
# it just buzzes and heats. Speed requests are clamped up to this floor.
MIN_DUTY = 0.25
# Soft start/stop: seconds spent ramping at 100% ramp intensity. The ramp is
# applied in small PWM steps while the motor is already powered.
MAX_RAMP_SECONDS = 1.2
RAMP_STEP_SECONDS = 0.02  # PWM update interval while ramping
# Hard ceiling on the soft STOP once the target shelf's pulse has been counted.
# Every millisecond of deceleration is extra travel PAST the shelf we were asked
# to stop at, so a full MAX_RAMP_SECONDS soft stop could coast the better part of
# a whole shelf beyond the target. Softness after the target is worth far less
# than stopping where the user asked, so the stop ramp gets its own short budget.
STOP_RAMP_SECONDS = 0.25
PULSE_TIMEOUT = 8.0   # seconds to wait for the next shelf pulse before faulting
HOME_TIMEOUT = 30.0   # seconds to find the index sensor before faulting
SENSOR_BOUNCE = 0.01  # debounce (s) for the inductive sensors
# Max time to drive off the index flag when homing starts while already on it.
# The motor runs throughout; this only bounds how long we watch for it to clear.
INDEX_CLEAR_TIMEOUT = 10.0
# Fallback blanking for the rare case where a move STARTS with the shelf window
# already empty (an aborted move, or a fault that left the carousel mid-travel).
# In the normal case the flag is sitting in the window and the far more accurate
# `shelf_clear()` wait below is used instead of this fixed guess.
# The motor runs normally during this window: it filters counting, not power.
# Keep it well under the real per-shelf travel time (~0.5s at MOVE_SPEED).
PULSE_BLANKING = 0.15

# ---- Parking ON the sensor -----------------------------------------------
# The carousel parks with the target shelf's flag still INSIDE the sensor
# window, so "in position" is a fact that can be re-checked at any time rather
# than dead reckoning. Two consequences drive the motion code:
#   * A move BEGINS with the sensor already active. The flag must be driven out
#     of the window before counting starts, or the level dropping as it leaves
#     (or a bounce right on the boundary) is counted as the target's arrival and
#     the move ends after ~30mm.
#   * A move must END inside the window. A soft stop always coasts, so after
#     stopping the sensor is re-checked and the shelf is crept back into the
#     window if it drifted out.
# Bounds how long we watch the parked flag leave the window. The motor runs
# throughout; this only limits the wait, exactly like INDEX_CLEAR_TIMEOUT.
SHELF_CLEAR_TIMEOUT = 10.0
# Realignment crawl. MIN_DUTY is the slowest duty that still breaks stiction,
# which is precisely what "go even more slow in reverse" needs.
CREEP_DUTY = MIN_DUTY
CREEP_TIMEOUT = 6.0
# Extra crawl after the window edge is found, so the flag settles nearer the
# MIDDLE of the window instead of balancing on its boundary, where the smallest
# vibration or drift would read as "not in position".
CENTER_NUDGE_SECONDS = 0.12
# SIMULATION ONLY. Half-width of the sensor window in shelf units, i.e. how much
# of the travel between two shelves reads "detected". A ~35mm flag on a ~200mm
# shelf pitch is about 0.18. Without a window the simulated sensor is a zero-
# width tripwire that is never active while parked, which cannot reproduce any
# of the park-on-sensor behaviour this code exists to get right.
SIM_SENSOR_HALF_WIDTH = 0.18

# Output type of the inductive proximity sensors. This decides which logic level
# counts as "shelf detected", so getting it wrong makes the sensors look dead and
# homing fails with "index sensor not found".
#
#   "NPN" (sinking, active-LOW)  - output floats when idle and pulls to GND when
#                                  triggered. Needs a pull-UP so the pin idles
#                                  high. This is the safe choice for a Pi: the
#                                  signal line only ever sees 3.3 V (from the
#                                  pull-up) or GND, never the sensor's 12/24 V.
#   "PNP" (sourcing, active-HIGH) - output floats when idle and sources +V when
#                                  triggered. Needs a pull-DOWN, AND a level
#                                  shifter/divider, because a 12/24 V sensor
#                                  would otherwise feed 12/24 V straight into a
#                                  3.3 V GPIO and destroy the Pi.
SENSOR_TYPE = "NPN"

# Which way the motor turns for "up" (decreasing shelf index). Flip if your
# carousel runs backwards relative to the app's direction labels.
HOMING_DIRECTION = "down"


# ==========================================================================
# Hardware backends
# ==========================================================================
class RealHardware:
    """Drives real GPIO through gpiozero (Motor + two inductive sensors)."""

    def __init__(self) -> None:
        from gpiozero import Motor, DigitalOutputDevice, DigitalInputDevice  # imported lazily

        # BTS7960: passing NO `enable` to Motor makes gpiozero PWM the two
        # direction pins directly, which is exactly what RPWM/LPWM want — it
        # drives one pin with the duty cycle and holds the other at 0.
        self.motor = Motor(
            forward=PIN_MOTOR_RPWM,
            backward=PIN_MOTOR_LPWM,
            pwm=True,
        )
        # R_EN and L_EN tied to one GPIO: HIGH arms the bridge, LOW makes the
        # outputs float. Pulling this LOW is a true hardware stop that works even
        # if a PWM pin is stuck, so the estop path uses it.
        self.enable = DigitalOutputDevice(PIN_MOTOR_EN, initial_value=True)
        # An NPN (sinking) sensor pulls the line to GND when it detects a shelf,
        # so we pull the pin up and let gpiozero treat LOW as active. A PNP
        # (sourcing) sensor is the mirror image: pull down, HIGH is active.
        # gpiozero derives `is_active` from pull_up, so the rest of this class
        # stays level-agnostic and only this flag has to change.
        pull_up = SENSOR_TYPE.upper() == "NPN"
        self.shelf = DigitalInputDevice(PIN_SHELF_SENSOR, pull_up=pull_up, bounce_time=SENSOR_BOUNCE)
        self.index = DigitalInputDevice(PIN_INDEX_SENSOR, pull_up=pull_up, bounce_time=SENSOR_BOUNCE)

        # ------------------------------------------------------------------
        # Sensors are EDGE COUNTERS, never a power gate.
        #
        # This class used to answer "has a shelf passed?" with gpiozero's
        # `wait_for_active()`, which returns instantly when the sensor is
        # ALREADY active. A parked carousel sits with a shelf right in the
        # sensor window, so every such call returned True immediately, the
        # move loop burned through all its steps in microseconds, and the
        # motor was switched off again before it could physically turn. The
        # observable result was a motor that only twitched, and that appeared
        # to run only while a sensor saw something.
        #
        # `when_activated` fires ONLY on a real inactive->active transition, so
        # a sensor that is already covered contributes no count at all. Counts
        # accumulate in the background completely independently of motor power:
        # the motion code starts the motor, then consumes counts as they
        # arrive. Sensor LEVEL never decides whether the motor is energised.
        # ------------------------------------------------------------------
        self._lock = threading.Lock()
        self._shelf_pulses = 0
        self._index_pulses = 0
        self._shelf_tick = threading.Event()
        self._index_tick = threading.Event()
        self.shelf.when_activated = self._on_shelf
        self.index.when_activated = self._on_index

    def _on_shelf(self) -> None:
        with self._lock:
            self._shelf_pulses += 1
        self._shelf_tick.set()

    def _on_index(self) -> None:
        with self._lock:
            self._index_pulses += 1
        self._index_tick.set()

    def forward(self, speed: float) -> None:
        self.enable.on()   # re-arm in case an estop left the bridge disabled
        self.motor.forward(speed)

    def backward(self, speed: float) -> None:
        self.enable.on()
        self.motor.backward(speed)

    def stop(self) -> None:
        # Zero the PWM first so the bridge brakes cleanly, then disarm it. Doing
        # it in this order avoids floating the outputs while a duty cycle is
        # still applied.
        self.motor.stop()
        self.enable.off()

    def reset_pulses(self) -> None:
        """Drop stale counts. Call before a move; never touches motor power."""
        with self._lock:
            self._shelf_pulses = 0
            self._index_pulses = 0
        self._shelf_tick.clear()
        self._index_tick.clear()

    def _take(self, kind: str, timeout: float) -> bool:
        """
        Consume one counted pulse, waiting up to `timeout` for one to arrive.
        The counter is the source of truth and the Event is only a wake-up
        hint, so a pulse landing between the check and the clear is still
        counted rather than lost.
        """
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

    def take_shelf_pulse(self, timeout: float) -> bool:
        return self._take("shelf", timeout)

    def take_index_pulse(self, timeout: float) -> bool:
        return self._take("index", timeout)

    def index_clear(self, timeout: float) -> bool:
        """
        Block until the index window is EMPTY, leaving motor power untouched so
        the carousel keeps driving off the flag while we watch.
        """
        deadline = time.monotonic() + timeout
        while self.index.is_active:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def index_active(self) -> bool:
        return bool(self.index.is_active)

    def shelf_clear(self, timeout: float) -> bool:
        """
        Block until the shelf window is EMPTY, leaving motor power untouched so
        the carousel keeps driving off the flag while we watch.

        This is the counterpart to `index_clear` for the per-shelf sensor, and it
        is what makes parking ON the sensor safe: the level is only consulted to
        decide when COUNTING may begin, never whether the motor is energised.
        """
        deadline = time.monotonic() + timeout
        while self.shelf.is_active:
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def shelf_active(self) -> bool:
        return bool(self.shelf.is_active)

    def cleanup(self) -> None:
        try:
            self.motor.stop()
            self.enable.off()  # leave the bridge disarmed on exit
            self.motor.close()
            self.enable.close()
            self.shelf.close()
            self.index.close()
        except Exception:
            pass


class SimHardware:
    """
    Pure-software stand-in so you can run/develop the agent without a Pi.
    A background thread advances a simulated position while the motor "runs",
    producing shelf edges and an index edge at position 0.
    """

    def __init__(self, shelves: int) -> None:
        self.shelves = shelves
        self._pos = 0.0            # continuous position in shelves
        self._dir = 0             # -1, 0, +1
        self._speed = 0.0
        self._lock = threading.Lock()
        # Mirrors RealHardware: counted edges, not levels.
        self._shelf_pulses = 0
        self._index_pulses = 0
        self._shelf_tick = threading.Event()
        self._index_tick = threading.Event()
        # Position 0.0 is a shelf in place, so the window starts ACTIVE. Seeding
        # this True is what stops a phantom pulse being reported at startup.
        self._shelf_was_active = True
        self._running = True
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()

    # ---- sensor geometry (lock-free; callers already hold the lock) ----
    def _shelf_window_active(self) -> bool:
        """True while a shelf flag is inside the sensor window."""
        return abs(self._pos - round(self._pos)) <= SIM_SENSOR_HALF_WIDTH

    def _index_window_active(self) -> bool:
        return self._shelf_window_active() and int(round(self._pos)) % self.shelves == 0

    def _loop(self) -> None:
        last = time.monotonic()
        while self._running:
            now = time.monotonic()
            dt = now - last
            last = now
            with self._lock:
                if self._dir != 0 and self._speed > 0:
                    # ~1 shelf every (0.4 / speed) seconds.
                    self._pos += self._dir * dt * (self._speed / 0.4)
                # Derive the LEVEL from geometry, then the EDGE from the level —
                # the same order as the real hardware, where gpiozero raises
                # `when_activated` on an inactive->active transition. The old
                # `int(before) != int(pos)` test was a zero-width tripwire: it
                # fired mid-way between shelves and was never active at rest, so
                # a parked-on-sensor carousel was impossible to simulate.
                active = self._shelf_window_active()
                if active and not self._shelf_was_active:
                    self._shelf_pulses += 1
                    self._shelf_tick.set()
                    if self._index_window_active():
                        self._index_pulses += 1
                        self._index_tick.set()
                self._shelf_was_active = active
            time.sleep(0.005)

    def forward(self, speed: float) -> None:
        with self._lock:
            self._dir = +1
            self._speed = speed

    def backward(self, speed: float) -> None:
        with self._lock:
            self._dir = -1
            self._speed = speed

    def stop(self) -> None:
        with self._lock:
            self._dir = 0
            self._speed = 0.0

    def reset_pulses(self) -> None:
        with self._lock:
            self._shelf_pulses = 0
            self._index_pulses = 0
        self._shelf_tick.clear()
        self._index_tick.clear()

    def _take(self, kind: str, timeout: float) -> bool:
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

    def take_shelf_pulse(self, timeout: float) -> bool:
        return self._take("shelf", timeout)

    def take_index_pulse(self, timeout: float) -> bool:
        return self._take("index", timeout)

    def index_clear(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while self.index_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def index_active(self) -> bool:
        with self._lock:
            return self._index_window_active()

    def shelf_clear(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while self.shelf_active():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def shelf_active(self) -> bool:
        with self._lock:
            return self._shelf_window_active()

    def cleanup(self) -> None:
        self._running = False


# ==========================================================================
# Carousel controller
# ==========================================================================
class Carousel:
    """
    Owns the motion state machine. Runs commands on a worker thread and reports
    progress through the `emit` callback (called with a dict = one event).
    """

    def __init__(self, hw, shelves: int, emit: Callable[[dict], None]) -> None:
        self.hw = hw
        self.shelves = shelves
        self.emit = emit
        self.current_shelf = 0
        self.homed = False
        self.status = "idle"  # idle | moving | homing

        # Live motion settings. The app pushes these with `config` whenever the
        # speed or soft-start slider moves, so they must be INSTANCE state, not
        # module constants. The constants above are only the initial values.
        self.move_speed = MOVE_SPEED
        self.homing_speed = HOMING_SPEED
        self.ramp_pct = 40

        self._cmd: Optional[tuple] = None
        self._abort = threading.Event()
        self._wake = threading.Event()
        self._alive = True
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    # ---- public API (called from the WebSocket thread) ----
    def request_home(self) -> None:
        self._set_command(("home",))

    def request_goto(self, shelf: int) -> None:
        self._set_command(("goto", shelf % self.shelves))

    def request_stop(self) -> None:
        self._abort.set()
        self.hw.stop()

    def set_shelves(self, shelves: int) -> None:
        if shelves > 0:
            self.shelves = shelves

    def set_motion(self, move_speed=None, homing_speed=None, ramp_pct=None) -> None:
        """
        Apply speed / soft-start settings from the app's sliders.

        Duties are clamped to [MIN_DUTY, 1.0]: below MIN_DUTY a geared carousel
        will not overcome stiction and the motor only buzzes, which would look
        exactly like "the slider broke the machine".
        """
        if move_speed is not None:
            self.move_speed = max(MIN_DUTY, min(1.0, float(move_speed)))
        if homing_speed is not None:
            self.homing_speed = max(MIN_DUTY, min(1.0, float(homing_speed)))
        if ramp_pct is not None:
            self.ramp_pct = max(0, min(100, int(ramp_pct)))
        print(
            f"[agent] motion set: move={self.move_speed:.2f} "
            f"home={self.homing_speed:.2f} ramp={self.ramp_pct}%",
            flush=True,
        )

    # ---- ramping ----
    def _ramp_seconds(self) -> float:
        return (self.ramp_pct / 100.0) * MAX_RAMP_SECONDS

    def _drive(self, direction: str, target: float, max_seconds: float | None = None) -> None:
        """
        Start the motor and ramp it up to `target` duty (soft start).

        The motor is energised at MIN_DUTY immediately and never de-energised
        mid-ramp, so this changes how fast it accelerates, never whether it has
        power. With ramp_pct = 0 it applies full duty in one step.

        `max_seconds` caps the ramp for short moves. A soft start longer than the
        move itself means the motor is still accelerating when it arrives, so it
        never actually reaches the requested duty — which made the speed slider
        feel completely dead on single-shelf hops.
        """
        drive = self.hw.backward if direction == "up" else self.hw.forward
        ramp = self._ramp_seconds()
        if max_seconds is not None:
            ramp = min(ramp, max_seconds)
        if ramp <= 0 or target <= MIN_DUTY:
            drive(target)
            return
        steps = max(1, int(ramp / RAMP_STEP_SECONDS))
        for i in range(1, steps + 1):
            if self._abort.is_set():
                return
            # Start from MIN_DUTY rather than 0 so the carousel actually breaks
            # away instead of humming at a duty too low to turn it.
            drive(MIN_DUTY + (target - MIN_DUTY) * (i / steps))
            time.sleep(RAMP_STEP_SECONDS)

    def _decelerate(self, direction: str, current: float, max_seconds: float | None = None) -> None:
        """
        Soft stop: ease the duty down before cutting power.

        `max_seconds` caps the ramp. Deceleration after the target shelf's pulse
        is pure overshoot, so callers stopping ON a target pass a short budget.
        """
        ramp = self._ramp_seconds()
        if max_seconds is not None:
            ramp = min(ramp, max_seconds)
        if ramp <= 0 or current <= MIN_DUTY:
            self.hw.stop()
            return
        drive = self.hw.backward if direction == "up" else self.hw.forward
        steps = max(1, int(ramp / RAMP_STEP_SECONDS))
        for i in range(steps, 0, -1):
            if self._abort.is_set():
                break
            drive(MIN_DUTY + (current - MIN_DUTY) * (i / steps))
            time.sleep(RAMP_STEP_SECONDS)
        self.hw.stop()

    def _creep_until_active(self, direction: str, timeout: float) -> bool:
        """
        Crawl in `direction` at CREEP_DUTY until the shelf window reads active.

        On success the motor is left RUNNING so the caller can keep crawling a
        little further to centre the flag. On failure or abort it is stopped.
        """
        drive = self.hw.backward if direction == "up" else self.hw.forward
        drive(CREEP_DUTY)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._abort.is_set():
                self.hw.stop()
                return False
            if self.hw.shelf_active():
                return True
            time.sleep(0.005)
        self.hw.stop()
        return False

    def _settle_on_sensor(self, direction: str) -> None:
        """
        Leave the carousel parked with the shelf flag INSIDE the sensor window.

        A soft stop always coasts, so counting alone cannot guarantee where the
        shelf physically ended up. This consults the sensor and corrects:

        * Window empty  -> overshot. Crawl back the way we came at CREEP_DUTY
          until the window is found again.
        * Window active -> we are balanced on the edge we just entered, since a
          pulse fires the moment the flag reaches the window boundary.

        Either way the flag is then eased a little deeper into the window, so it
        settles nearer the middle than the boundary. Parking on the very edge is
        what makes a shelf read as "not in position" after a nudge or a power
        cycle, and it is also what turns the next move's departure into a
        bounce-prone miscount.
        """
        if self._abort.is_set():
            return

        reverse = "down" if direction == "up" else "up"
        nudge = CENTER_NUDGE_SECONDS
        if self.hw.shelf_active():
            # Already inside; centre it by continuing the way we were going.
            nudge_dir = direction
        else:
            if not self._creep_until_active(reverse, CREEP_TIMEOUT):
                self.hw.stop()
                self.hw.reset_pulses()
                self.emit({"type": "fault",
                           "message": "Shelf not aligned: sensor never re-triggered"})
                return
            # Found the window from the far side, so "deeper in" is that way too.
            # We stopped the instant the boundary was detected, so the flag is
            # right on the edge and gets the full nudge to reach the middle.
            nudge_dir = reverse

        drive = self.hw.backward if nudge_dir == "up" else self.hw.forward
        drive(CREEP_DUTY)
        # Creep in short slices, stopping the moment the flag leaves the window,
        # so a nudge can never push it out the far side. A single blind sleep is
        # what stranded the shelf between shelves when the move started
        # mid-travel and the crawl entered the window already past its centre.
        slice_s = 0.02
        waited = 0.0
        while waited < nudge:
            time.sleep(slice_s)
            waited += slice_s
            if self._abort.is_set() or not self.hw.shelf_active():
                break
        self.hw.stop()

        # If the nudge itself carried the flag out the far side, come back and
        # accept the edge rather than leaving the shelf parked outside the
        # window: being on the boundary is imperfect, being outside is a fault.
        #
        # Retry from alternating sides. A single attempt was not enough: when a
        # move begins mid-travel the crawl can cross the whole window, and one
        # unchecked correction left the shelf stranded between two shelves.
        for attempt in range(3):
            if self.hw.shelf_active() or self._abort.is_set():
                break
            back = "down" if nudge_dir == "up" else "up"
            probe = back if attempt % 2 == 0 else nudge_dir
            self._creep_until_active(probe, CREEP_TIMEOUT)
            self.hw.stop()

        self.hw.stop()
        if not self.hw.shelf_active() and not self._abort.is_set():
            self.emit({"type": "fault",
                       "message": "Shelf not aligned: could not settle on sensor"})

        # Alignment is not travel. Drop the edges it produced so the next move
        # does not count them as shelves.
        self.hw.reset_pulses()

    def shutdown(self) -> None:
        self._alive = False
        self._abort.set()
        self._wake.set()

    def snapshot(self) -> dict:
        return {"type": "state", "status": self.status, "shelf": self.current_shelf, "homed": self.homed}

    # ---- internals ----
    def _set_command(self, cmd: tuple) -> None:
        self._abort.set()      # interrupt any in-flight motion
        self.hw.stop()
        self._cmd = cmd
        self._wake.set()

    def _run(self) -> None:
        while self._alive:
            self._wake.wait()
            self._wake.clear()
            cmd = self._cmd
            self._cmd = None
            self._abort.clear()
            if not cmd:
                continue
            try:
                if cmd[0] == "home":
                    self._do_home()
                elif cmd[0] == "goto":
                    self._do_goto(cmd[1])
            except Exception as exc:  # pragma: no cover - hardware faults
                self.hw.stop()
                self.status = "idle"
                self.emit({"type": "fault", "message": str(exc)})

    def _do_home(self) -> None:
        self.status = "homing"
        self.emit(self.snapshot())

        # Energise the motor FIRST and unconditionally. Motor power must never
        # depend on what the sensors currently see.
        self.hw.reset_pulses()
        # Soft-started at the CURRENT homing speed, not the module default, so
        # the sliders affect homing too.
        home_direction = "up" if HOMING_DIRECTION == "down" else "down"
        self._drive(home_direction, self.homing_speed)

        # Classic "already sitting on the switch" problem: if the carousel is
        # parked with a shelf inside the index window, the flag is active before
        # we even start. The old code asked "is index active?" and got an
        # instant yes, so homing declared success after a few microseconds of
        # motor time and the carousel never moved. Drive off the flag first —
        # the motor stays powered the whole time — and only then look for the
        # genuine inactive->active edge that actually means "home".
        if self.hw.index_active():
            self.hw.index_clear(INDEX_CLEAR_TIMEOUT)
            self.hw.reset_pulses()  # ignore the edge produced by leaving the flag

        found = self.hw.take_index_pulse(HOME_TIMEOUT)
        self.hw.stop()
        if self._abort.is_set():
            self.status = "idle"
            return
        if not found:
            self.status = "idle"
            self.emit({"type": "fault", "message": "Homing timed out: index sensor not found"})
            return
        # Homing stops on the index edge, which leaves the shelf flag on the
        # boundary of the shelf window rather than inside it. Every move now
        # assumes it starts parked in that window, so align before declaring
        # home — otherwise the very first move after homing takes the degraded
        # blanking path instead of waiting for a real departure edge.
        self._settle_on_sensor(home_direction)
        self.current_shelf = 0
        self.homed = True
        self.status = "idle"
        self.emit({"type": "homed", "shelf": 0})

    def _do_goto(self, target: int) -> None:
        # An un-homed carousel is still allowed to move. Refusing here meant a
        # failed home (e.g. a miswired index sensor) left the machine completely
        # immobile, including the manual Move Up/Down buttons, so the motor
        # could never be exercised to diagnose the very problem blocking it.
        # Without a home reference the move is simply relative: we still count
        # shelves, but `homed` stays False so the app knows the absolute
        # position is not yet trustworthy.
        if target == self.current_shelf and self.homed:
            self.emit({"type": "arrived", "shelf": target})
            return

        self.status = "moving"
        self.emit(self.snapshot())

        # Shortest direction around the loop.
        up_steps = (self.current_shelf - target) % self.shelves     # "up" = index down
        down_steps = (target - self.current_shelf) % self.shelves   # "down" = index up
        if up_steps <= down_steps:
            direction, steps = "up", up_steps
        else:
            direction, steps = "down", down_steps

        # Drop stale counts, then energise the motor ONCE. It now runs
        # continuously for the whole move: the loop below only *counts* shelves
        # going past, and nothing in it consults a sensor level to decide
        # whether the motor should be powered.
        self.hw.reset_pulses()
        step = -1 if direction == "up" else +1
        # Soft start at the CURRENT slider speed. Reading the MOVE_SPEED constant
        # here was why the speed slider did nothing to the hardware.
        speed = self.move_speed

        # Gentle duty for the last shelf of travel, so the carousel is already
        # crawling when it reaches the target instead of slamming into a stop.
        approach = speed
        if self.ramp_pct > 0:
            approach = speed - (speed - MIN_DUTY) * (self.ramp_pct / 100.0)

        # A single-shelf hop IS its own final shelf: there is no room to cruise
        # fast and then slow down, and running one shelf at full speed guaranteed
        # a big coast past the target. Do the whole hop at the approach duty.
        cruise = approach if steps <= 1 else speed

        # The carousel parks INSIDE the sensor window, so a move normally starts
        # with the sensor already active. The parked flag must be driven OUT of
        # the window before counting begins, otherwise the level dropping as it
        # leaves — or the smallest bounce on that boundary — is counted as the
        # target shelf arriving and the move ends after ~30mm.
        #
        # This happens at MIN_DUTY, BEFORE the soft start, and the order matters:
        # `_drive` blocks for the whole ramp (up to 1.2s), which is long enough
        # to carry the carousel past an entire shelf. Waiting for the window
        # afterwards would then discard pulses for shelves already travelled and
        # overshoot by nearly a full shelf. Detecting the departure at crawl
        # speed keeps it unambiguous.
        motor_start = time.monotonic()
        if direction == "up":
            self.hw.backward(MIN_DUTY)
        else:
            self.hw.forward(MIN_DUTY)

        if self.hw.shelf_active():
            if not self.hw.shelf_clear(SHELF_CLEAR_TIMEOUT):
                self.hw.stop()
                self.status = "idle"
                self.emit({"type": "fault",
                           "message": "Shelf sensor never cleared; check sensor wiring or jam"})
                return
            self.hw.reset_pulses()  # drop the edge produced by leaving the flag
        else:
            # Window already empty (an aborted move or fault left the carousel
            # mid-travel). There is no departure edge to wait for, so fall back
            # to blanking against a phantom re-entry pulse.
            elapsed = time.monotonic() - motor_start
            if elapsed < PULSE_BLANKING:
                time.sleep(PULSE_BLANKING - elapsed)
            self.hw.reset_pulses()

        # Now the soft start proper, continuing up from the crawl duty the motor
        # is already running at. Short moves get a capped ramp so the requested
        # duty is actually reached while there is still travel left to feel it.
        self._drive(direction, cruise, max_seconds=STOP_RAMP_SECONDS if steps <= 1 else None)
        speed = cruise

        # A slow speed or a long soft start means the first shelf legitimately
        # takes longer to arrive. Scaling the jam timeout keeps a slow-but-
        # healthy move from being misreported as a jam.
        pulse_timeout = PULSE_TIMEOUT * (MOVE_SPEED / max(MIN_DUTY, speed)) + self._ramp_seconds()

        counted = 0
        # True once a shelf has been counted and we are waiting for that shelf's
        # departure edge. The move starts with the parked flag already driven out
        # of the window, so the next edge is a genuine arrival.
        pending_departure = False
        while counted < steps:
            if self._abort.is_set():
                self.hw.stop()
                self.status = "idle"
                return
            # The ONLY sensor-related stop left is this jam guard, and it fires
            # on elapsed TIME with no pulse at all — never on a sensor simply
            # reading inactive. A covered or uncovered sensor cannot cut power.
            if not self.hw.take_shelf_pulse(pulse_timeout):
                self.hw.stop()
                self.status = "idle"
                self.emit({"type": "fault", "message": "Jam? No shelf pulse within timeout"})
                return
            # An inductive sensor is a LEVEL, so each shelf passing can produce
            # TWO edges: one as the flag enters the window and one as it leaves.
            # Counting raw edges counted every shelf twice and ended a 3-shelf
            # move after about 2 shelves. A shelf counts only on ARRIVAL; the
            # matching departure edge is consumed and discarded.
            #
            # Reading the level to classify the edge is racy on its own: at speed
            # the flag can cross the whole window before we get to look. So the
            # level is only trusted while it still says "inside", and otherwise
            # we fall back to alternating arrival/departure, which is what a
            # level sensor always does.
            if pending_departure and not self.hw.shelf_active():
                pending_departure = False
                continue
            pending_departure = True
            counted += 1
            # Soft stop, part 1: with one shelf left to travel, drop to a slower
            # approach duty so the carousel is already crawling when it reaches
            # the target, instead of running at full speed into a hard stop.
            # Interpolated by ramp intensity: 0% keeps full speed to the end.
            if counted == steps - 1 and steps > 1 and approach < speed:
                if direction == "up":
                    self.hw.backward(approach)
                else:
                    self.hw.forward(approach)
                speed = approach
            self.current_shelf = (self.current_shelf + step) % self.shelves
            # Drift correction from a counted index EDGE, never a level read.
            # Reading the level here was the same mistake in a third place: just
            # after homing the carousel is still physically sitting on the home
            # flag, so the level was still active and the very first shelf pulse
            # got "corrected" back to 0 — reporting 0,1,2 for a 3-shelf move.
            # An edge only appears when the home flag genuinely passes by again.
            # It also stays off un-homed, where a stuck-active sensor would
            # otherwise pin the position to 0 forever.
            if self.homed and self.hw.take_index_pulse(0.0):
                self.current_shelf = 0
            self.emit({"type": "pos", "shelf": self.current_shelf})

        # Soft stop, part 2: ease the duty down to a halt rather than cutting
        # power dead. `_decelerate` falls through to a plain stop at ramp 0%.
        self._decelerate(direction, speed, max_seconds=STOP_RAMP_SECONDS)
        # Counting says we arrived; the sensor says where we actually are. Park
        # the shelf inside the window so "in position" stays verifiable.
        self._settle_on_sensor(direction)
        self.status = "idle"
        if self.homed:
            self.current_shelf = target
        self.emit({"type": "arrived", "shelf": self.current_shelf})


# ==========================================================================
# WebSocket server
# ==========================================================================
async def serve(args) -> None:
    import websockets
    # Base class of ConnectionClosedOK/ConnectionClosedError, so catching it
    # covers both a graceful close and an abrupt drop with no close frame.
    from websockets.exceptions import ConnectionClosed

    shelves = max(1, args.shelves)

    # Why this is reported instead of just logged: a silent fall back to
    # simulation is indistinguishable from working hardware. The agent connects,
    # accepts commands and reports smooth motion while the motor pins stay idle,
    # so the app looks healthy and the carousel never turns. The app therefore
    # gets told, in every `hello`, whether it is talking to real GPIO.
    sim_reason: Optional[str] = None

    if args.simulate:
        hw = SimHardware(shelves)
        sim_reason = "started with --simulate"
        print(f"[agent] running in SIMULATION mode ({shelves} shelves)", flush=True)
    else:
        try:
            hw = RealHardware()
            # flush=True matters under systemd: stdout is a pipe, not a TTY, so
            # Python block-buffers it and this line can sit unflushed indefinitely.
            # Without it `journalctl | grep -i gpio` returns nothing from the
            # agent, making a perfectly healthy agent look silent and dead.
            print("[agent] GPIO ready: driving real hardware", flush=True)
        except Exception as exc:
            if args.strict_gpio:
                # Refuse to pretend. Better a dead service you can see in
                # `systemctl status` than a live one that quietly does nothing.
                print(
                    f"[agent] FATAL: GPIO unavailable ({exc}); --strict-gpio set, refusing to simulate",
                    flush=True,
                )
                raise SystemExit(1)
            sim_reason = f"GPIO unavailable: {exc}"
            hw = SimHardware(shelves)
            print("=" * 72, flush=True)
            print("[agent] WARNING: GPIO IS UNAVAILABLE — RUNNING IN SIMULATION", flush=True)
            print(f"[agent] reason: {exc}", flush=True)
            print("[agent] The motor will NOT move. Commands will look like they", flush=True)
            print("[agent] succeed because motion is faked in software.", flush=True)
            print("[agent] On a Pi 5, gpiozero needs the lgpio pin factory:", flush=True)
            print("[agent]     sudo apt install -y python3-lgpio", flush=True)
            print("[agent]     GPIOZERO_PIN_FACTORY=lgpio", flush=True)
            print("=" * 72, flush=True)
    loop = asyncio.get_running_loop()
    clients: "set[object]" = set()

    def broadcast(event: dict) -> None:
        """Called from the Carousel worker thread → hop back onto the loop."""
        data = json.dumps(event)
        for ws in list(clients):
            asyncio.run_coroutine_threadsafe(_safe_send(ws, data), loop)

    async def _safe_send(ws, data: str) -> None:
        try:
            await ws.send(data)
        except Exception:
            pass

    carousel = Carousel(hw, shelves, broadcast)

    async def handler(ws) -> None:
        clients.add(ws)
        try:
            # Greet + send current state immediately. These MUST stay inside the
            # try: the app closes the socket whenever its last browser tab goes
            # away, and if that lands mid-greeting an unguarded send raises
            # ConnectionClosedError straight out of the handler — which both
            # prints a scary traceback and skips the `finally` below, leaking the
            # dead socket in `clients` forever.
            await ws.send(json.dumps({"type": "hello", "name": args.name, "shelves": carousel.shelves, "firmware": "pax-agent-1.0", "simulated": sim_reason is not None, "simReason": sim_reason}))
            await ws.send(json.dumps(carousel.snapshot()))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                t = msg.get("type")
                if t == "home":
                    carousel.request_home()
                elif t == "goto":
                    carousel.request_goto(int(msg.get("shelf", 0)))
                elif t == "stop":
                    carousel.request_stop()
                    carousel.status = "idle"
                    broadcast(carousel.snapshot())
                elif t == "config":
                    carousel.set_shelves(int(msg.get("shelves", carousel.shelves)))
                    # Previously this handler ignored everything except
                    # `shelves`, so the speed and soft-start sliders were
                    # delivered to the Pi and then silently dropped.
                    carousel.set_motion(
                        move_speed=msg.get("moveSpeed"),
                        homing_speed=msg.get("homingSpeed"),
                        ramp_pct=msg.get("rampPct"),
                    )
                elif t == "hello":
                    await ws.send(json.dumps({"type": "hello", "name": args.name, "shelves": carousel.shelves, "simulated": sim_reason is not None, "simReason": sim_reason}))
        except ConnectionClosed:
            # Routine, not an error: the app drops the socket when its last
            # viewer leaves, and a dev-server restart drops it abruptly (which
            # surfaces as ConnectionClosedError "no close frame received or
            # sent"). Either way the app reconnects on its own, so stay quiet and
            # keep serving — the motor state lives in `carousel`, not the socket.
            pass
        finally:
            clients.discard(ws)

    print(f"[agent] '{args.name}' listening on ws://0.0.0.0:{args.port}/", flush=True)
    async with websockets.serve(handler, "0.0.0.0", args.port):
        try:
            await asyncio.Future()  # run forever
        finally:
            carousel.shutdown()
            hw.cleanup()


def main() -> None:
    p = argparse.ArgumentParser(description="PAX paternoster Raspberry Pi agent")
    p.add_argument("--name", default="Paternoster", help="Human-readable unit name")
    p.add_argument("--port", type=int, default=8765, help="WebSocket port (match the app)")
    p.add_argument("--shelves", type=int, default=9, help="Number of shelves on this carousel")
    p.add_argument("--simulate", action="store_true", help="Run without real GPIO (fake motion)")
    p.add_argument(
        "--strict-gpio",
        action="store_true",
        help="Exit instead of silently simulating when GPIO is unavailable (recommended for the real unit)",
    )
    args = p.parse_args()
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        print("\n[agent] stopped")


if __name__ == "__main__":
    main()
