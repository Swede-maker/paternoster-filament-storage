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
# Floor for an OPERATOR-supplied duty from the app's PWM slider. Much lower than
# MIN_DUTY on purpose: MIN_DUTY protects the agent's own crawls, where a stalled
# motor would break shelf counting, but clamping the slider to it silently
# discarded any lower request and made the control appear dead. Stiction varies
# per machine, so the operator is trusted to find the usable range.
SLIDER_MIN_DUTY = 0.05
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
# How often a long sensor wait re-checks for an emergency stop. Small enough to
# feel instant to an operator, large enough not to spin the CPU.
ABORT_POLL_SECONDS = 0.02
SENSOR_BOUNCE = 0.01  # debounce (s) for the inductive sensors
# ---------------------------------------------------------------------------
# Mechanical shelf-bounce filter.
#
# A shelf can swing/rock as it settles, leaving the sensor window and swinging
# straight back into it. Each re-entry is a fresh rising edge, so the SAME shelf
# was counted twice or more and the carousel believed it had travelled further
# than it had.
#
# The filter is a LOCKOUT APPLIED AFTER a counted shelf: once a shelf is counted,
# further rising edges are ignored for a short period, which is exactly how long
# that shelf's own rocking lasts. The next genuine shelf arrives well after the
# lockout, so it counts.
#
# The direction of the test matters more than its length. An earlier version was
# release-based — an edge only counted once the window had been EMPTY for a while
# first — and that is a precondition IN FRONT OF the stop signal, so the filter
# could delay or drop the very edge that must cut power. It did exactly that on
# every move (see _on_shelf). A lockout can only ever ignore a LATER edge, so the
# rising edge that stops the carousel is always published instantly.
#
# The period is NOT a fixed wall-clock value, because the safe ceiling depends on
# speed. Per-shelf travel is ~0.5s at MOVE_SPEED, so a flat 1.0-1.5s lockout would
# outlast the gap between shelves and swallow genuine ones. Scaling with duty
# keeps it a constant fraction of the real shelf spacing at every speed.
#
# This filters COUNTING only. It never gates motor power, and position still
# comes from counted pulses rather than from elapsed time.
SHELF_SETTLE_AT_MOVE_SPEED = 0.20
SHELF_SETTLE_MAX = 1.5


def shelf_settle_for(duty: float) -> float:
    """
    Post-trigger bounce lockout for a given PWM duty.

    Travel time per shelf is inversely proportional to duty, so the lockout scales
    the same way and stays at a constant FRACTION of the real shelf spacing. That
    is what makes one setting correct at 45% and at 5% alike. Capped so a
    near-stalled duty cannot produce an absurdly long blind window.
    """
    lockout = SHELF_SETTLE_AT_MOVE_SPEED * (MOVE_SPEED / max(0.01, duty))
    return min(SHELF_SETTLE_MAX, lockout)
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
# How long to wait for the parked flag to slide back INTO the window when a move
# reverses out of an empty window. Only needs to cover the small overshoot the
# previous stop coasted past the sensor, so it is short. If it expires the flag
# was never there (the machine was left mid-travel), and counting simply starts
# with the next real shelf.
REVERSE_REENTRY_TIMEOUT = 1.5

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
# The crawl is PULSED, not continuous: drive for CREEP_PULSE_ON, cut power, let
# it settle for CREEP_PULSE_OFF, then read the sensor. A continuous crawl cannot
# be stopped inside a narrow window — by the time the level is read and `stop()`
# lands, the flag has already coasted out the far side, so the correction
# overshoots in the new direction and the carousel oscillates on one shelf
# forever. Pulsing bounds how far a single step can travel and guarantees the
# sensor is read while the motor is genuinely stopped.
CREEP_PULSE_ON = 0.04
CREEP_PULSE_OFF = 0.05
# How long to wait after cutting power before trusting a sensor reading. Cutting
# power does not stop a loaded carousel; it coasts. Raise this if the machine is
# heavy and alignment decisions still seem to be made on a moving flag.
MOTION_SETTLE = 0.20
# How many verify-and-correct rounds to attempt before declaring the position
# unknown. Bounded on purpose: if the carousel coasts further than the sensor
# window is wide, no amount of retrying can park inside it, and looping forever
# is exactly the "spins back and forth on one shelf" failure. Better to stop and
# ask for a re-home.
SETTLE_ATTEMPTS = 4
# Longest we will wait for a coast to finish before calling the position
# unknown. Must exceed the machine's real coast-down time; a carousel that
# genuinely cannot hold the sensor within this window needs mechanical
# attention (or a lower move speed), not a longer timeout.
COAST_MAX = 3.0
# How long the sensor level must stay unchanged before the carousel is believed
# to be at rest. This must be LONGER than the slowest credible crossing of the
# sensor window, because a machine drifting through the window also holds the
# level steady — just not for long. Too small and a slow coast reads as a park
# (the flag then drifts out and the position silently goes wrong); too large and
# every move pays the wait. It only needs to exceed window_width / creep_speed.
REST_STABLE = 0.9
# Hard cap on ONE correction attempt. Realignment only ever recovers a flag we
# just coasted past, so it should need a fraction of a shelf. Bounding it stops a
# failed correction from turning into an open-ended hunt that parks on a
# different shelf than the one being reported.
CREEP_BUDGET = 1.5
# Hard cap on how many creep pulses one recovery may use. This is the distance
# bound that keeps alignment honest: a recovery that crawls far enough will
# eventually reach the NEXT shelf's flag, pass the "on a flag" test, and report
# the wrong shelf as correct. Sized so the total crawl stays well under one
# shelf pitch. Lower it if a failed alignment ever ends up a shelf out.
CREEP_MAX_PULSES = 12
# Total sensor edges the ENTIRE alignment may pass, across all retries. A single
# attempt being bounded is not enough — several bounded attempts still add up to
# a different shelf. Two is the honest limit: leaving the flag we overshot and
# re-entering it. A third edge means we have entered a DIFFERENT window, and
# anything found there is a different shelf no matter how well centred it is.
SETTLE_MAX_EDGES = 2
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
        # Mechanical bounce filter state: the time the last shelf was COUNTED.
        # `None` means "no recent count", so the next rising edge passes straight
        # through. See _on_shelf for why this is a lockout AFTER a trigger and
        # never a wait BEFORE one.
        self._last_counted: Optional[float] = None
        self._shelf_settle = 0.0
        self._suppressed_bounces = 0
        self.shelf.when_activated = self._on_shelf
        self.index.when_activated = self._on_index

        # Which way the motor is turning right now, and which way it was turning
        # at the moment the shelf flag LEFT the sensor window.
        #
        # The second is the only reliable answer to "which side of the sensor is
        # the flag parked on", and that is what decides whether the next move
        # will drag it back through. It has to be MEASURED, not inferred from the
        # move direction: depending on how hard the machine brakes, a move can
        # end just PAST the flag (heavy carousel coasts through) or just BEFORE it
        # (the alignment crawl backs out the near side). Those are opposite sides
        # from the same move direction, so assuming either one is wrong half the
        # time. The falling edge is what actually happened.
        self.travel_direction: Optional[str] = None
        self.flag_exit_direction: Optional[str] = None
        self.shelf.when_deactivated = self._on_shelf_exit

    def set_shelf_settle(self, seconds: float) -> None:
        """Lockout applied AFTER a counted shelf, to swallow that shelf's bounce."""
        with self._lock:
            self._shelf_settle = max(0.0, seconds)

    def _on_shelf_exit(self) -> None:
        if self.travel_direction is not None:
            self.flag_exit_direction = self.travel_direction

    def _on_shelf(self) -> None:
        """
        RISING EDGE. Untriggered -> triggered. This is the event the whole machine
        stops on, so it is published IMMEDIATELY and unconditionally, unless it is
        a re-trigger of the shelf that was just counted.

        The bounce filter is a LOCKOUT AFTER a counted shelf, never a wait BEFORE
        one. That distinction is the entire bug that made the carousel drive past
        its target:

        This used to be release-based — an edge only counted if the window had
        been EMPTY for `settle` first. That puts a precondition in front of the
        stop signal, so the filter could DELAY or DROP the very edge that must cut
        power. It reliably did: on the last shelf the move drops to the slower
        `approach` duty, `settle` is recomputed for that slow duty (0.40s) while
        the carousel is still physically coasting near cruise (real gap 0.25s), so
        the target's arrival edge was swallowed every time and the loop ran on to
        the NEXT shelf. It also failed outright whenever the metal flag covered
        more than ~60% of the shelf pitch, because then the empty gap is shorter
        than the settle at any speed.

        A lockout cannot do that. The first edge after a reset always passes with
        zero delay, so trigger -> stop is exact; only the SAME shelf rocking back
        into the window inside the lockout is ignored.
        """
        now = time.monotonic()
        with self._lock:
            last = self._last_counted
            lockout = self._shelf_settle
            if last is not None and lockout > 0 and (now - last) < lockout:
                # Same shelf rocking in the window again, not the next shelf.
                self._suppressed_bounces += 1
                return
            self._last_counted = now
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
            # Clear the bounce lockout too. A move ends by stopping ON a flag, so
            # `_last_counted` is only milliseconds old when the next move starts.
            # Leaving it set would make the lockout suppress the NEXT move's first
            # genuine arrival — reintroducing the drive-past-the-target bug at the
            # start of every move instead of the end.
            self._last_counted = None
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
        # Mirrors RealHardware's bounce filter state: time of the last COUNTED
        # shelf, used as a lockout after a trigger rather than a wait before one.
        self._last_counted: Optional[float] = None
        self._shelf_settle = 0.0
        self._suppressed_bounces = 0
        # Mirrors RealHardware: current travel, and the travel at the flag's last
        # departure from the sensor window.
        self.travel_direction: Optional[str] = None
        self.flag_exit_direction: Optional[str] = None
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
                    # Same post-trigger LOCKOUT as the real hardware: a rising
                    # edge is published immediately unless it is the shelf just
                    # counted rocking back in. Never a wait before the edge.
                    if (self._last_counted is not None
                            and self._shelf_settle > 0
                            and (now - self._last_counted) < self._shelf_settle):
                        self._suppressed_bounces += 1
                    else:
                        self._last_counted = now
                        self._shelf_pulses += 1
                        self._shelf_tick.set()
                    # The INDEX pulse is raised OUTSIDE the bounce filter, on
                    # every rising edge, matching real hardware where the index
                    # sensor is a physically separate input with its own callback.
                    #
                    # Nesting it inside the filter meant a bouncing home flag
                    # suppressed the index pulse as well, so homing could sail
                    # past the home position and time out. Over-counting the index
                    # is harmless (homing only asks "have we seen it yet?"),
                    # whereas missing it loses the datum the whole axis is
                    # referenced from.
                    if self._index_window_active():
                        self._index_pulses += 1
                        self._index_tick.set()
                elif self._shelf_was_active and not active:
                    # Falling edge: the flag has just cleared the window, so the
                    # current travel fixes which side it now rests on. It no
                    # longer feeds the bounce filter, because the filter must not
                    # depend on how long the window has been empty.
                    if self.travel_direction is not None:
                        self.flag_exit_direction = self.travel_direction
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

    def set_shelf_settle(self, seconds: float) -> None:
        with self._lock:
            self._shelf_settle = max(0.0, seconds)

    def reset_pulses(self) -> None:
        with self._lock:
            self._shelf_pulses = 0
            self._index_pulses = 0
            # Mirrors RealHardware: clearing the lockout is what stops the
            # previous move's final pulse suppressing the next move's first one.
            self._last_counted = None
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

        # NOTE: which side of the sensor the parked shelf flag sits on is NOT
        # tracked here. It lives in the hardware layer as `hw.flag_exit_direction`
        # and is measured on the flag's falling edge, because how hard the machine
        # brakes decides whether a move ends just past the flag or just before it
        # — opposite sides from the same move direction.

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

        Clamped to [SLIDER_MIN_DUTY, 1.0], NOT to MIN_DUTY.

        MIN_DUTY (25%) is the floor for the agent's own internal crawls, where a
        stalled motor would break the counting logic. Applying it here silently
        raised any lower setting back to 25%, so dragging the PWM slider below
        that did nothing at all — the operator cannot tune out coasting with a
        control that ignores them. Every carousel has a different stiction point,
        so the floor is deliberately low and finding the usable range is the point
        of the slider. If the motor only buzzes, the setting is too low: raise it.
        """
        if move_speed is not None:
            self.move_speed = max(SLIDER_MIN_DUTY, min(1.0, float(move_speed)))
        if homing_speed is not None:
            self.homing_speed = max(SLIDER_MIN_DUTY, min(1.0, float(homing_speed)))
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

    def _energise(self, direction: str, duty: float) -> None:
        """
        The ONE place the motor is ever given a direction.

        Publishes the current travel to the hardware layer, which uses it to
        timestamp the shelf flag's DEPARTURE from the sensor. Every path that
        moves the machine goes through here — the main move, the soft start and
        stop, the homing sweep and the alignment crawl — so whichever of them was
        last to carry the flag out of the window is the one recorded, which is
        exactly what the next move needs to know.
        """
        self.hw.travel_direction = direction
        # Re-scale the mechanical bounce filter for the duty we are about to run
        # at. Slower travel means a longer real gap between shelves, so the filter
        # can afford to be (and must be) proportionally longer to reject a slow
        # shelf swing; faster travel needs it short so a genuine shelf is never
        # rejected. Setting it here means every mover — main move, ramps, homing
        # sweep, alignment crawl — gets a filter matched to its actual speed.
        setter = getattr(self.hw, "set_shelf_settle", None)
        if setter is not None:
            setter(shelf_settle_for(duty))
        if direction == "up":
            self.hw.backward(duty)
        else:
            self.hw.forward(duty)

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
        ramp = self._ramp_seconds()
        if max_seconds is not None:
            ramp = min(ramp, max_seconds)
        # Only skip the ramp when there is no ramp. The old `target <= MIN_DUTY`
        # guard meant every low-duty move jumped straight to full requested duty
        # with no soft start, which is the harshest possible start on exactly the
        # slow, carefully-tuned moves that need gentleness most.
        if ramp <= 0:
            self._energise(direction, target)
            return
        steps = max(1, int(ramp / RAMP_STEP_SECONDS))
        # Start from MIN_DUTY so the carousel breaks away instead of humming at a
        # duty too low to turn it — but never ABOVE the duty asked for. Hardcoding
        # MIN_DUTY here meant a 12% request was driven at 25%: the operator's PWM
        # setting was silently doubled, the carousel arrived far too fast to stop
        # on the flag, and dragging the slider down did nothing at all.
        floor = min(MIN_DUTY, target)
        for i in range(1, steps + 1):
            if self._abort.is_set():
                return
            self._energise(direction, floor + (target - floor) * (i / steps))
            time.sleep(RAMP_STEP_SECONDS)

    # NOTE: there is deliberately no `_decelerate` / soft-stop ramp any more.
    #
    # Stopping ON a sensor and ramping down are incompatible: every millisecond
    # of ramp is extra travel past the flag that was just detected. The ramp also
    # had a floor bug that made it useless where it mattered most — easing from
    # `current` down to `min(MIN_DUTY, current)` is a no-op once the operator sets
    # a duty below MIN_DUTY, so at 10% or 6% it held FULL requested duty for the
    # whole ramp and then cut power, i.e. pure overshoot with no braking at all.
    # That is why going "mega slow" did not help: the slower the setting, the more
    # completely the ramp degenerated into a fixed-length coast.
    #
    # Arrival now cuts power outright. The acceleration ramp in `_drive` stays;
    # softening the START is free, because nothing is being aimed at.

    def _creep_pulse(self, direction: str) -> None:
        """One bounded crawl step: drive briefly, then stop and let it settle."""
        self._energise(direction, CREEP_DUTY)
        time.sleep(CREEP_PULSE_ON)
        self.hw.stop()
        time.sleep(CREEP_PULSE_OFF)

    def _drain_shelf_edges(self) -> int:
        """
        Consume and count every shelf edge recorded so far, without waiting.

        Edges are logged by an interrupt in the real hardware, which is why this
        is trustworthy as a distance measure during a slow crawl: nothing is
        missed even if the crossing happens while this thread is sleeping.
        """
        n = 0
        while self.hw.take_shelf_pulse(0):
            n += 1
        return n

    def _creep_until_active(self, direction: str, timeout: float,
                            active_fn=None, budget: int = 0) -> tuple:
        """
        Crawl in `direction` in bounded pulses until the sensor reads active,
        then STOP. The motor is always left stopped, whatever the outcome.

        Pulsing is what makes "reverse slowly until it triggers again" actually
        stop on the flag. A continuous crawl kept coasting straight through the
        window, so each correction overshot the other way and the carousel
        oscillated on the same shelf indefinitely.

        `budget` is the edge count already spent by the caller, and the returned
        `(ok, budget)` carries the updated total back. Threading one shared total
        through every attempt is what stops a series of individually-bounded
        crawls from adding up to a whole shelf of travel.
        """
        if active_fn is None:
            active_fn = self.hw.shelf_active
        deadline = time.monotonic() + timeout
        pulses = 0
        # Measure how far the recovery has travelled using the SENSOR EDGE
        # COUNTER. Polling the level in this loop cannot do it: a single creep
        # pulse on a heavy machine can cross an entire flag while we are asleep
        # inside `_creep_pulse`, so the crossing is simply never observed and the
        # crawl wanders on. The edge counter is interrupt-driven in the real
        # hardware, so it cannot miss a crossing however briefly it happens.
        #
        # This matters because an unbounded crawl eventually reaches a
        # NEIGHBOURING shelf's flag, passes the "am I on a flag?" test, and
        # reports the wrong shelf as correct.
        #
        # Deliberately NOT reset here: the counter is shared with the caller's
        # running total. Clearing it discarded travel from earlier attempts, so
        # several "bounded" attempts silently added up to a whole shelf and the
        # wrong flag was accepted as the target.
        edges = budget
        while time.monotonic() < deadline:
            if self._abort.is_set():
                self.hw.stop()
                return False, edges
            edges += self._drain_shelf_edges()
            if edges > SETTLE_MAX_EDGES or pulses >= CREEP_MAX_PULSES:
                # Travelled as far as a recovery may ever go. Stop and let the
                # caller declare the position unknown rather than parking on some
                # other shelf and calling it success.
                self.hw.stop()
                return False, edges
            if active_fn():
                # Triggered — but possibly still coasting. Only a reading that
                # HOLDS once the machine is at rest proves we stopped on the
                # flag rather than sailing through the window.
                self.hw.stop()
                parked = self._parked_on_flag(active_fn)
                # Count the coast's OWN travel before judging. Waiting for the
                # machine to stop is itself movement, and on a heavy carousel that
                # coast can cross a whole flag — so the crawl comes to rest neatly
                # on the NEXT shelf's flag, which satisfies "on a flag" while
                # being a shelf wrong. Draining after the decision made this a
                # race: the same move randomly reported an arrival or a fault.
                edges += self._drain_shelf_edges()
                if parked:
                    return edges <= SETTLE_MAX_EDGES, edges
                # Coasted out the far side of the window.
                #
                # This is still a SUCCESS, and insisting otherwise is what made
                # homing impossible. The sensor window is narrower than the
                # carousel's own stopping distance, so "come to rest INSIDE the
                # window" is a condition the mechanism cannot meet at all: every
                # creep pulse that reaches the flag also carries past it. The old
                # code read that as failure and crawled again, alternating sides,
                # hunting back and forth across the sensor until the attempt
                # budget ran out and homing gave up with "home sensor not
                # triggered" — while the flag had in fact crossed the sensor
                # several times.
                #
                # What matters is that we KNOW WHERE WE ARE, and we do: the flag
                # was just seen and we stopped a short, bounded distance past it.
                # Position is established by the CROSSING, not by residency.
                #
                # Deliberately does NOT touch the skip-a-trigger state. The crawl
                # only ever nudges within a fraction of a shelf, so it never
                # changes WHICH flag we are next to — and it runs opposite to the
                # move, so recording it here inverted the next move's decision.
                if edges <= SETTLE_MAX_EDGES:
                    return True, edges
                # Strayed too far to know which flag that was. Keep crawling; the
                # timeout and the caller's bounded retry decide when to give up.
            self._creep_pulse(direction)
            pulses += 1
        self.hw.stop()
        edges += self._drain_shelf_edges()
        ok = self._parked_on_flag(active_fn) and edges <= SETTLE_MAX_EDGES
        return ok, edges

    def _settle_on_sensor(self, direction: str, active_fn=None,
                          label: str = "Shelf") -> bool:
        """
        Leave the carousel parked with the flag INSIDE the sensor window, and
        report whether that actually succeeded.

        A soft stop always coasts, so counting alone cannot say where the shelf
        physically stopped. The rule is deliberately simple:

        * Already resting on the flag -> done. Leave it exactly where it is.
        * Otherwise -> we overshot. Crawl BACK the way we came in small pulses
          and stop the moment the sensor triggers AND holds at rest.

        Every judgement is made with the machine stopped, and every crawl is
        bounded in distance. If the flag still cannot be held, the position is
        unknown: this returns False and the caller must refuse to claim an
        arrival. Guessing is what let the browser advance through shelves while
        the carousel shuffled around one spot.
        """
        if active_fn is None:
            active_fn = self.hw.shelf_active
        if self._abort.is_set():
            return False

        reverse = "down" if direction == "up" else "up"

        # Cutting power does not stop the carousel — it coasts. Let it come fully
        # to rest and THEN look, before touching the motor again.
        #
        # There is deliberately no "centring" nudge here. Nudging deeper into the
        # window looked harmless but ran while the machine was still rolling, so
        # it added to the momentum and threw the flag clear out the far side. The
        # recovery crawl then ran backwards past the target and parked on the
        # PREVIOUS shelf's flag — which passes an "am I on a flag?" test while
        # being one shelf wrong. That is the loop where the browser kept changing
        # shelves while the carousel shuffled around the same place. A flag that
        # merely reads off-centre is fine; a flag on the wrong shelf is not.
        # Count the post-move coast before trusting this first reading: the flag
        # it comes to rest on may not be the one the move was counting.
        self.hw.reset_pulses()
        if self._parked_on_flag(active_fn):
            coasted = self._drain_shelf_edges()
            if coasted <= SETTLE_MAX_EDGES:
                self.hw.reset_pulses()
                return True

        # Verify-and-correct. Each round comes to a complete REST before judging,
        # then requires the sensor to stay triggered. Sampling a moving flag was
        # reporting success while the carousel was merely passing THROUGH the
        # window, which is how an arrival got claimed for a machine that could
        # not stop there at all.
        #
        # ONE edge budget for the WHOLE alignment, not per attempt. Each retry
        # travels, and several bounded retries still add up to a different shelf.
        # Without this running total the last attempt could come to rest on a
        # neighbouring flag and be accepted, because "am I on a flag?" is true
        # there too — the carousel then sat one shelf off while the browser
        # happily displayed the target.
        # Seed the budget with the travel already spent overshooting, rather than
        # resetting it. That coast is part of how far we have strayed from the
        # flag the move was counting, so forgetting it would let the correction
        # wander a further whole shelf and still call the result a success.
        drift = self._drain_shelf_edges()
        probe = reverse
        for _ in range(SETTLE_ATTEMPTS):
            if self._abort.is_set():
                break
            drift += self._drain_shelf_edges()
            if drift > SETTLE_MAX_EDGES:
                break
            parked = self._parked_on_flag(active_fn)
            # Settle-waiting is travel too, so count it before trusting `parked`.
            drift += self._drain_shelf_edges()
            if drift > SETTLE_MAX_EDGES:
                break
            if parked:
                self.hw.reset_pulses()
                return True
            # Not on the flag. Crawl back onto it, alternating sides so a
            # correction that itself overshoots is undone rather than repeated
            # in the same direction forever.
            #
            # Each attempt is strictly BOUNDED (CREEP_BUDGET). Alignment is a
            # nudge back onto a flag we just left, never a search: an unbounded
            # crawl walked several shelves away while hunting and then parked on
            # the WRONG one while still reporting success — the "browser changes
            # shelves but the carousel is somewhere else" failure.
            ok, drift = self._creep_until_active(probe, CREEP_BUDGET,
                                                 active_fn, drift)
            if ok:
                self.hw.reset_pulses()
                return True
            probe = direction if probe == reverse else reverse

        self.hw.stop()
        drift += self._drain_shelf_edges()
        # Alignment is not travel. Drop the edges it produced so the next move
        # does not count them as shelves.
        self.hw.reset_pulses()
        if self._abort.is_set():
            return False
        if drift > SETTLE_MAX_EDGES:
            # We are probably sitting on SOME flag, but too far from where the
            # move ended for it to be the right one. Being on a flag is not the
            # same as being on the correct flag, and reporting the target here is
            # precisely how the display drifted away from the machine.
            return False
        # One last honest look, at rest.
        return self._parked_on_flag(active_fn)

    def _parked_on_flag(self, active_fn) -> bool:
        """
        True only if the sensor is triggered AND stays triggered while stopped.

        Both halves matter. Cutting power starts a coast, so a single reading can
        catch the flag mid-flight through the window; requiring it to still be
        there after the machine has settled distinguishes "parked on the sensor"
        from "passing the sensor".
        """
        self.hw.stop()
        # Wait out the coast FIRST, then judge. Watching for the sensor to hold
        # "active" for a short spell is not proof of rest: a slow carousel
        # crossing the window holds it triggered for exactly as long, which is
        # how an arrival got claimed for a machine that then drifted two thirds
        # of a shelf further on. So give the mechanism the full COAST_MAX to stop
        # moving, and only then read the sensor.
        #
        # Rest is detected from the sensor alone, without a position encoder: the
        # level is sampled repeatedly, and the machine is treated as stopped once
        # it has been unchanging for REST_STABLE. Crucially, a *changing* level
        # proves motion, so any flag crossing the window boundary resets the
        # clock rather than being mistaken for a park.
        deadline = time.monotonic() + COAST_MAX
        last = active_fn()
        steady_since = time.monotonic()
        while time.monotonic() < deadline:
            if self._abort.is_set():
                return False
            time.sleep(0.02)
            now = active_fn()
            if now != last:
                last = now
                steady_since = time.monotonic()
                continue
            if time.monotonic() - steady_since >= REST_STABLE:
                break
        # Whatever the level is now, it has been stable long enough to trust.
        return bool(active_fn())

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

    def _await(self, wait_fn, timeout: float) -> bool:
        """
        Abort-aware wrapper around a blocking sensor wait.

        Slices the wait into short spans and re-checks `_abort` between them, so
        an emergency stop is honoured within milliseconds instead of after the
        full timeout. Homing waited up to HOME_TIMEOUT (30 s) in ONE call, so the
        worker thread sat inside that call, deaf to everything, and could not even
        report the stop or accept the next command until it expired.

        Slicing is safe: the pulse counters accumulate in the sensor callbacks,
        independently of whoever is waiting, so a pulse landing during any slice
        is still counted rather than lost.
        """
        deadline = time.monotonic() + timeout
        while True:
            if self._abort.is_set():
                return False
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            if wait_fn(min(ABORT_POLL_SECONDS, remaining)):
                return True

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
            self._await(self.hw.index_clear, INDEX_CLEAR_TIMEOUT)
            self.hw.reset_pulses()  # ignore the edge produced by leaving the flag

        found = self._await(self.hw.take_index_pulse, HOME_TIMEOUT)
        self.hw.stop()
        if self._abort.is_set():
            self.status = "idle"
            return
        if not found:
            self.status = "idle"
            self.emit({"type": "fault", "message": "Homing timed out: index sensor not found"})
            return
        # `take_index_pulse` returns on the interrupt-captured rising EDGE, so the
        # stop() above already cut power at the moment the index metal was sensed.
        # That is home. The motor is finished.
        #
        # No alignment crawl here either, for exactly the reason given at the end
        # of _do_goto: the crawl re-read the sensor only AFTER waiting out a 3 s
        # coast, by which time the metal had drifted out of the window, so it
        # decided it had missed the flag and drove off hunting for a full
        # HIGH -> LOW -> HIGH crossing. On the home flag that produced the same
        # visible fault as on the shelves — stop correctly on the metal, then
        # rotate until the metal had gone by.
        #
        # There used to be a SECOND rotation right after this one: if the shelf
        # sensor did not happen to be active once home was found, the code crawled
        # again to hunt the shelf flag. With two sensors that are physically offset
        # that hunt starts by definition, so homing ended with the carousel
        # shuffling off the home flag it had just correctly landed on. Home is
        # defined by the INDEX sensor; whether the shelf flag also lines up is a
        # mounting question, not something to fix by driving the motor.

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
        step = -1 if direction == "up" else +1

        speed = self.move_speed

        # Gentle duty for the FINAL shelf, so the carousel is already crawling by
        # the time the target metal reaches the sensor.
        #
        # This is the only thing that shortens the mechanical coast after power is
        # cut, and coast distance goes with the SQUARE of speed — so this single
        # number decides whether the machine rests on the metal or slides clear of
        # it. Software reaction time is irrelevant next to it.
        #
        # It drops all the way to the slowest usable duty rather than being
        # interpolated by `ramp_pct`. Scaling it was why the sheet was still being
        # overshot at the default setting: ramp_pct=40 eased only 40% of the way
        # down, leaving the approach at ~82% of full speed (0.45 -> 0.37) and a
        # coast wider than a few-cm sheet. `ramp_pct` legitimately controls how
        # gently the motor SPEEDS UP; letting it also dictate the arrival speed
        # meant a mid-slider ramp setting silently traded away arrival accuracy.
        #
        # MIN_DUTY is the slowest duty that still TURNS the motor, so it is exactly
        # the right arrival speed: as gentle as the hardware allows, never below
        # the stall threshold. It is deliberately not derived from `speed` —
        # writing it as `min(MIN_DUTY, speed)` produced a sub-stall approach at low
        # slider settings (speed 0.01 -> 0.01) and the carousel simply stopped
        # short of the target.
        approach = MIN_DUTY

        # A ONE-SHELF HOP IS ENTIRELY A FINAL APPROACH, so it runs at the arrival
        # duty from the start — there is no intermediate shelf at which to slow
        # down, because the very first trigger is the target.
        #
        # This was written as `max(approach, min(speed, 1.0))` to keep the speed
        # slider effective on short moves. That inverted the priority: it forced
        # cruise up to the full requested duty, which made `approach == speed`, so
        # the changeover in the loop found nothing to change and the single most
        # common move on the machine — step to the next shelf — took its target
        # flag at full speed. Measured on the reversal harness: the carousel
        # arrived at duty 0.45 and coasted 0.392 of a pitch past the flag, while
        # the same move at the arrival duty stops within 0.1.
        #
        # The slider still governs multi-shelf moves, where it decides the cruise
        # between shelves. It cannot also govern the last few centimetres without
        # trading away the accuracy of the stop.
        cruise = approach if steps <= 1 else speed

        # ==================================================================
        # 0. SAMPLE THE PARKED STATE — before anything moves.
        # ==================================================================
        # Two instantaneous reads, taken while the carousel is still stationary.
        # This is NOT a wait and it does not gate the motor: nothing here blocks,
        # and the machine sets off immediately afterwards regardless of what the
        # sensor says.
        #
        # It has to happen before the motor starts. Read a moment later and the
        # flag has already been dragged back into the window, so the carousel
        # looks parked ON a flag when it was actually parked just past one — and
        # the re-entry then gets counted as the target, stopping the move dead on
        # the spot it began.
        parked_on_flag = self.hw.shelf_active()

        # WHICH trigger is the target.
        #
        # A stop leaves the carousel coasted just PAST the flag, outside the
        # window. Turning round drives that same flag straight back in, so the
        # first trigger of a reversing move is the shelf we are ALREADY on, not a
        # new one.
        #
        # `flag_exit_direction` is measured by the hardware at the flag's falling
        # edge — the travel that actually carried it out of the window. That is a
        # sensor observation, not a prediction: a heavy carousel coasts through
        # and rests past the flag, a well-braked one gets backed out the near
        # side, and only the real departure tells the two apart.
        #
        # If the flag is still in the window it never left, so there is no
        # re-entry to discard.
        # Read via getattr: not every hardware backend tracks the exit direction,
        # and a bare attribute access raised AttributeError mid-move on those,
        # aborting the move where it stood. Absent the measurement, no trigger is
        # discarded — the safe default, since discarding one wrongly is what loses
        # a shelf.
        exit_direction = getattr(self.hw, "flag_exit_direction", None)
        ignore_parked_flag = (not parked_on_flag
                              and exit_direction is not None
                              and direction != exit_direction)

        # ==================================================================
        # 1. START THE MOTOR.
        # ==================================================================
        # Energise at the breakaway duty and return IMMEDIATELY. The soft start is
        # then continued by the watch loop below, one small step per pass, so the
        # sensor is being read from the very first instant of motion.
        #
        # `_drive()` was used here and it BLOCKED for the whole ramp — at
        # ramp_pct=100 that is over a second of the motor running at speed with
        # nothing watching the sensor. Measured: the carousel travelled 1.9 shelves
        # inside that call on a one-shelf move, so the target's metal went past
        # completely unseen and the move only ended when a later shelf happened to
        # trigger. That was the last place the motor ran without the sensor in
        # charge, and it is exactly the "sails past the metal" symptom.
        self.hw.reset_pulses()

        # Non-blocking ramp state, stepped inside the loop.
        ramp_floor = min(MIN_DUTY, cruise)
        ramp_seconds = 0.0 if steps <= 1 else self._ramp_seconds()
        ramp_started = time.monotonic()

        # NO RAMP MEANS FULL REQUESTED DUTY IMMEDIATELY — not a crawl.
        #
        # This branch is essential, not a shortcut. Opening at `ramp_floor`
        # unconditionally left the duty pinned at MIN_DUTY for the entire move
        # whenever ramp_pct was 0, because the in-loop stepper below is skipped
        # when `ramp_seconds` is zero. The operator's speed slider then did
        # nothing at all at the 0% ramp setting: every move crawled at 25%.
        if ramp_seconds <= 0:
            speed = cruise
        else:
            speed = ramp_floor
        self._energise(direction, speed)

        # ==================================================================
        # 2. WATCH THE SENSOR. 3. STOP THE INSTANT THE TARGET TRIGGERS IT.
        # ==================================================================
        # The whole move is this one loop. It watches the shelf sensor, counts a
        # shelf on each trigger, and the moment the count reaches the target it
        # cuts power. Nothing predicts where the carousel is: there is no
        # dead reckoning, no elapsed-time position, no calculated stopping point.
        # The sensor decides, and the only clock is the runaway guard below.
        #
        # `seen_inactive` starts from the sensor's real state so that the flag the
        # carousel is parked on cannot be miscounted as an arrival. It gates only
        # the COUNTING, never the motor — the machine sets off regardless of what
        # the sensor reads.
        POLL = 0.001
        counted = 0
        # Set once the arrival duty has been applied, so the soft start above can
        # never accelerate back out of it.
        on_final_approach = False
        # From the state sampled at step 0, not re-read here: by now the flag may
        # already have moved back into the window.
        seen_inactive = not parked_on_flag

        # ------------------------------------------------------------------
        # RUNAWAY STOP — the only guard, and the only use of a clock here.
        #
        # It does NOT decide position and does NOT decide when to stop on target;
        # the sensor does both, above. It catches exactly one failure: the sensor
        # reporting NOTHING AT ALL — wire off, flag missing, jammed carousel,
        # seized motor. Without it the loop has no exit and the motor runs at full
        # duty until someone kills it at the wall.
        #
        # Every trigger resets it, so it can only fire on true silence, never on a
        # slow-but-healthy move. Scaled by duty because a lower PWM legitimately
        # takes longer to reach the next shelf.
        # ------------------------------------------------------------------
        silence_limit = PULSE_TIMEOUT * (MOVE_SPEED / max(0.01, cruise)) + self._ramp_seconds()
        last_trigger = time.monotonic()

        while True:
            if self._abort.is_set():
                self.hw.stop()
                self.status = "idle"
                return

            # SOFT START, continued here instead of in a blocking call, so that
            # every millisecond of acceleration happens with the sensor being
            # read.
            #
            # NOT gated on the shelf count. `counted < steps - 1` was tried and it
            # coupled acceleration to sensor progress: on a fast or continuously
            # triggering sensor the count reaches the penultimate shelf within the
            # first couple of 1 ms passes, so the ramp was cancelled before it had
            # raised the duty at all and the whole move crawled at the breakaway
            # value. Acceleration must depend only on elapsed time.
            #
            # `on_final_approach` latches the last leg. Without it this block
            # would immediately accelerate back out of the arrival duty the
            # changeover below had just set — `approach` is deliberately lower
            # than `cruise`, so `speed < cruise` stays true and the ramp would
            # undo the one thing that keeps the coast short.
            if ramp_seconds > 0 and speed < cruise and not on_final_approach:
                frac = (time.monotonic() - ramp_started) / ramp_seconds
                target_duty = cruise if frac >= 1.0 else ramp_floor + (cruise - ramp_floor) * frac
                if target_duty > speed:
                    self._energise(direction, target_duty)
                    speed = target_duty

            # "TRIGGERED" is reported by two independent observers, and either one
            # counts:
            #
            #   - a rising edge CAPTURED by the sensor callback (`when_activated`
            #     on real hardware). This is an interrupt: it physically cannot
            #     miss an edge.
            #   - the LIVE level, read right here.
            #
            # Both are the same event, and neither is sufficient alone. A poll can
            # miss a flag that crosses the window between two reads — at speed
            # that is exactly how the carousel used to sail past the target. A
            # callback can be delayed by a busy CPU. Taking either as "triggered"
            # means no single miss can carry the machine past the shelf.
            #
            # A QUEUED PULSE ALWAYS MEANS "METAL ARRIVED", so it is trusted on its
            # own, without confirming the level.
            #
            # That holds because the pulse queue is fed from `when_activated`
            # ONLY; `when_deactivated` goes to the separate exit handler and never
            # raises a shelf pulse. Requiring `and active` here looks safer but
            # silently disables the interrupt path in the one case it exists for:
            # a fast, narrow flag whose whole crossing falls between two 1 ms
            # polls. The edge is captured, the level read misses it, and the
            # carousel counts nothing and drives on past the shelf.
            #
            # If a backend ever did pulse on both edges, the fix belongs in that
            # driver — the falling edge must not reach this queue.
            pulsed = self.hw.take_shelf_pulse(0.0)
            active = self.hw.shelf_active()

            if pulsed:
                triggered = True
                seen_inactive = False
            elif not active:
                seen_inactive = True
                triggered = False
            elif seen_inactive:
                triggered = True
                seen_inactive = False
            else:
                # Still sitting in the same flag we already counted.
                triggered = False

            if triggered and ignore_parked_flag:
                # The flag we set off from, sliding back into the window. Not a
                # shelf gained. Reset the runaway guard, since the sensor is
                # plainly alive and reporting.
                ignore_parked_flag = False
                last_trigger = time.monotonic()
                time.sleep(POLL)
                continue

            if triggered:
                counted += 1
                last_trigger = time.monotonic()

                if counted >= steps:
                    # THIS IS THE TARGET. Cut power immediately, before any
                    # bookkeeping, while the flag is still in the window.
                    self.hw.stop()
                    self.current_shelf = target
                    self.emit({"type": "pos", "shelf": self.current_shelf})
                    break

                if counted == steps - 1:
                    on_final_approach = True

                if counted == steps - 1 and approach != speed:
                    # The next trigger is the target, so drop to the arrival duty
                    # now. Applied whenever it DIFFERS from the current duty, not
                    # only when it is lower: a long soft start may still be below
                    # the approach duty at this point, and the old `approach <
                    # speed` test silently skipped the changeover in that case,
                    # leaving the final shelf to be taken at whatever partial ramp
                    # duty happened to be set.
                    self._energise(direction, approach)
                    speed = approach

                self.current_shelf = (self.current_shelf + step) % self.shelves
                self.emit({"type": "pos", "shelf": self.current_shelf})

            # Checked on EVERY pass, deliberately outside the if/elif above.
            # As an `elif` it was unreachable in the one case it exists for: a
            # dead sensor reads inactive forever, so the first branch always won
            # and the guard never ran.
            if time.monotonic() - last_trigger > silence_limit:
                # Total sensor silence. Kill the motor.
                self.hw.stop()
                self.status = "idle"
                # An abort is an operator decision, not a jam — don't cry wolf.
                if self._abort.is_set():
                    return
                self.emit({"type": "fault",
                           "message": "Jam? No shelf pulse within timeout"})
                self.emit(self.snapshot())
                return

            time.sleep(POLL)

        # ==================================================================
        # THE MOVE IS OVER. THE MOTOR DOES NOT TURN AGAIN.
        # ==================================================================
        # Power was cut in the loop above, at the instant the sensor saw the
        # metal. That instant IS the arrival, and it is the position we keep.
        #
        # There is deliberately NO alignment crawl here any more. It was actively
        # undoing the thing it was meant to protect:
        #
        #   The crawl began by asking `_parked_on_flag`, which cuts power and then
        #   waits up to COAST_MAX (3 s) for the sensor level to hold steady for
        #   REST_STABLE (0.9 s) BEFORE reading it. The metal sheet is only a few
        #   centimetres long, so during that wait the sheet quietly coasts out of
        #   the sensor. The read then came back "not triggered", the code
        #   concluded it had overshot, and it drove the carousel off looking for a
        #   flag — hunting for a full HIGH -> LOW -> HIGH crossing when the sensor
        #   had ALREADY been LOW at the only moment that mattered.
        #
        #   Worse, `_creep_until_active` treats "crossed the flag and came to rest
        #   just past it" as success (position established by the CROSSING, not by
        #   residency). So the crawl's own definition of done was the metal having
        #   gone by — which is precisely the wrong end.
        #
        # Net effect from the operator's seat: the carousel stopped correctly on
        # the metal, then rotated itself forward until the metal had passed and
        # called that "aligned". Cutting power on the trigger and then leaving the
        # motor alone is the whole fix.
        #
        # A few cm of metal is generous tolerance. If the machine ever coasts
        # clear past the sheet, that is a mechanical/speed matter — lower the move
        # duty — not something to correct by driving further.
        self.status = "idle"

        if self.homed:
            self.current_shelf = target
        # Report whether the metal is still in front of the sensor, for
        # diagnostics only. It does NOT gate the arrival and never moves the
        # motor: the trigger already told us where we are.
        self.emit({"type": "arrived",
                   "shelf": self.current_shelf,
                   "onSensor": bool(self.hw.shelf_active())})


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
