#!/usr/bin/env python3
"""
PAX paternoster — Raspberry Pi GPIO agent.

This program runs ON a Raspberry Pi and drives one paternoster carousel. The
carousel always has TWO motors, one per chain, one on each side:
  * EITHER two brushed DC motors, each on its own BTS7960 / IBT-2 half-bridge,
    with PWM speed control ("dc" drive mode, the default: both bridges get the
    same duty and direction for a move, and each motor can be jogged on its own
    for a number of MILLISECONDS to level the chains),
  * OR two StepperOnline iSV57T integrated servos on pulse/direction lines
    ("servo" drive mode: synchronised dual-motor moves, speed by pulse
    frequency, exact-count micro-jog per motor in PULSES), and
  * two inductive proximity sensors (identical in both modes):
      - SHELF sensor: pulses once as every shelf passes the pick window,
      - INDEX sensor: active only at shelf 1 (the home / absolute reference).

The drive mode is chosen in the web app (setup wizard / Settings) and pushed in
`config.motorMode`; the agent persists it in MOTOR_CONF_PATH and initialises
the matching backend on boot. `--motor dc|servo` overrides it.

It exposes a WebSocket server that the PAX web app connects to. The wire format
matches `lib/node-protocol.ts` in the web app exactly:

  app  -> pi : {"type":"home"} | {"type":"goto","shelf":N} | {"type":"stop"}
               | {"type":"config","shelves":N,"motorMode":"dc|servo",...}
               | {"type":"jog","motor":"a|b|both","direction":"up|down",
                  "pulses":N}            (servo: exact pulse count)
                  "ms":N,"speed":0..1}   (dc: run time in milliseconds)
               | {"type":"release"} | {"type":"hold"}   (servo: free / re-energise)
               | {"type":"hello"}
  pi   -> app: {"type":"hello",...,"motorMode":"dc|servo"} | {"type":"state",...}
               | {"type":"pos","shelf":N} | {"type":"arrived","shelf":N}
               | {"type":"homed","shelf":N} | {"type":"fault","message":"..."}
               | {"type":"servo","mode":"dc|servo","alarmA":bool,"alarmB":bool,
                  "held":bool,"holdTimeoutS":N,...}
                 (drive status; in dc mode the alarm/hold fields are absent)

Shelf indexes are 0-based on the wire (shelf 0 == the INDEX sensor position).

Run on the Pi:
    python3 paternoster_agent.py --name "Paternoster 1" --shelves 9

Test on a laptop (no GPIO hardware needed) with the built-in simulator:
    python3 paternoster_agent.py --simulate --shelves 9
"""

import argparse
import asyncio
import json
import math
import threading
import time
from typing import Callable, Optional

# Wi-Fi / hotspot management (NetworkManager). Optional: the agent must keep
# driving the motor even if paxnet.py is missing or nmcli is not installed —
# the `net.*` commands then answer with a clear error instead of crashing.
try:
    import paxnet  # noqa: E402
except Exception as _paxnet_exc:  # pragma: no cover
    paxnet = None
    _PAXNET_IMPORT_ERROR = repr(_paxnet_exc)
else:
    _PAXNET_IMPORT_ERROR = None

# --------------------------------------------------------------------------
# Pin configuration (BCM numbering). Adjust to match your wiring.
# --------------------------------------------------------------------------
# DC drive mode: TWO BTS7960 / IBT-2 43A half-bridges, one per motor (motor A
# on one side of the carousel, motor B on the other). Unlike an L298N there is
# no single "enable = PWM" pin: RPWM and LPWM are BOTH PWM inputs and *which
# one* you drive picks the direction. Drive only one at a time — driving both
# together shoots through the bridge.
#
# Both bridges receive the same duty and direction during a move so the two
# chains stay in step; motor B's direction is inverted in software when the
# two motors face each other (DC_MIRROR_B / "Mirror motor B" in the app). Each
# bridge can also be run ALONE for a timed jog to level the chains.
PIN_MOTOR_A_RPWM = 12  # bridge A -> RPWM (PWM, drives one direction)
PIN_MOTOR_A_LPWM = 13  # bridge A -> LPWM (PWM, drives the other direction)
PIN_MOTOR_A_EN = 22    # bridge A -> R_EN + L_EN tied together (HIGH = armed)
PIN_MOTOR_B_RPWM = 20  # bridge B -> RPWM
PIN_MOTOR_B_LPWM = 21  # bridge B -> LPWM
PIN_MOTOR_B_EN = 27    # bridge B -> R_EN + L_EN tied together
# Backwards-compatible aliases (motor_test.py and older notes refer to these).
PIN_MOTOR_RPWM = PIN_MOTOR_A_RPWM
PIN_MOTOR_LPWM = PIN_MOTOR_A_LPWM
PIN_MOTOR_EN = PIN_MOTOR_A_EN
# Motor B usually sits across the carousel from motor A and therefore turns the
# opposite way for the same chain direction. Flip from the app if yours is
# wired alike (shares the "Mirror motor B" switch with the servo backend).
DC_MIRROR_B = True
# Largest PWM balance the app may ask for, in percent of duty taken off the
# faster bridge. Mirrors MAX_DC_TRIM_PCT in lib/filament.ts.
DC_TRIM_MAX_PCT = 20.0
# Timed jog on a DC bridge. There is no step unit, so a jog is "run this motor
# for N milliseconds" at a fixed duty; the app's step size is in ms. The duty
# defaults to the same cruise duty as a move so a single motor reliably breaks
# stiction; the app may pass its own `speed`.
DC_JOG_DUTY = 0.45
DC_JOG_MAX_MS = 5000
# Time slice used to poll for an estop while a timed jog runs.
DC_JOG_SLICE_S = 0.01
# Inductive sensor. This is a LEVEL, not a pulse: it stays active for as long as
# a shelf's metal flag is in front of it, and a parked carousel is ALWAYS sitting
# with a flag in the window. So the sensor reads active before a move even starts,
# and that standing signal is not a shelf that has been passed.
#
# Shelves are therefore counted as TRANSITIONS — the flag leaves the window, the
# next flag enters it — never as "one pulse per shelf". Treating the level as a
# pulse is what made a move of N shelves finish after N-1.
PIN_SHELF_SENSOR = 23
PIN_INDEX_SENSOR = 24  # inductive sensor: active only at shelf 1 (home)
# Twin carousels (hardware only): two independent carousels on one Pi. The LEFT
# one uses motor A and the sensors above; the RIGHT one uses motor B and its own
# shelf + home sensors on these pins (wired exactly like 23/24).
PIN_SHELF_SENSOR_R = 19
PIN_INDEX_SENSOR_R = 4
TWIN_SIDES = ("left", "right")

# --------------------------------------------------------------------------
# Servo drive mode: two StepperOnline iSV57T integrated servos on PUL/DIR.
#
# Selected per unit from the app (setup wizard / Settings → "Motor drive") and
# remembered in MOTOR_CONF_PATH so the right backend comes up on the next boot.
# The sensors are identical in both modes; only the motor pins differ.
#
# PUL on GPIO12 / GPIO13: these are the Pi's two hardware-PWM channels, so the
# pulse train is generated by the PWM peripheral and not by a Python loop —
# jitter-free at any frequency the drive accepts. Motor A and motor B get their
# own channel so they can also be jogged INDIVIDUALLY for chain alignment; for
# a move both channels run the same frequency and direction.
#
# The iSV57T opto inputs want 4–5 V at 7–16 mA (manual §3). A Pi GPIO is 3.3 V
# and is only rated for a few mA, so drive PUL/DIR through a 5 V line driver
# (74AHCT125 / 74HCT245) — see README "Servo wiring". ALM is an open-collector
# output: wire ALM- to GND and ALM+ to the GPIO; the Pi's pull-up reads LOW in
# normal operation and HIGH when the drive trips (over-current / over-voltage /
# position-following error).
# --------------------------------------------------------------------------
PIN_SERVO_PUL_A = 12
PIN_SERVO_PUL_B = 13
PIN_SERVO_DIR_A = 5
PIN_SERVO_DIR_B = 6
PIN_SERVO_ALM_A = 16
PIN_SERVO_ALM_B = 26
# "Release" outputs. The iSV57T has NO enable (ENA) input — its control
# connector is only PUL/DIR/ALM — so a parked servo always holds with full
# torque and cannot be turned by hand while powered. The only way to let go is
# to cut the drive's 24–36 V supply. Wire each output to a relay / high-side
# MOSFET module in the +Vdc lead of the matching drive (or tie both outputs to
# one relay that feeds both drives). The agent opens the relay after the idle
# timeout or on request and closes it again before the next move or jog.
# Leave the outputs unconnected if you do not want this; nothing else changes.
PIN_SERVO_ENA_A = 17
PIN_SERVO_ENA_B = 25
# True: GPIO HIGH = relay open = motor free. Set False for a relay module that
# is active-low (most cheap opto relay boards: IN pulled LOW closes the relay).
SERVO_ENA_ACTIVE_RELEASES = True
# Time for the drive to boot after its supply returns before the first pulse
# edge arrives. The iSV57T needs ~1 s after power-up; the step pulses sent
# before that are lost.
SERVO_ENABLE_SETTLE_S = 1.2
# Idle seconds before the servos are released automatically. 0 = never release
# (hold with full torque). Defaults to 0 because release only does something
# with the optional supply relay wired. The app overrides this per unit via
# `config.servoHoldTimeoutS`.
SERVO_HOLD_TIMEOUT_S = 0
# Upper bound for the operator's "safe move time" (config.sensorArmS): how long
# after a move or homing run starts the sensors are ignored. 0 = off (default).
SENSOR_ARM_MAX_S = 10.0

# Pulses per motor revolution. Must equal the drive's DIP S1–S3 setting (or
# Pr0.08 when S1–S3 are all OFF). Factory default is 4000 → 0.09° per pulse.
SERVO_PULSES_PER_REV = 4000
# Pulse frequency at 100 % speed. The drive accepts up to 300 kHz, but a
# geared carousel does not need anything close to that: 8 000 pps at 4000 ppr is
# 120 rpm at the motor shaft. The app's "Motor speed" slider scales 0..1 of this.
SERVO_MAX_PPS = 8000
# Lowest frequency the slider floor maps to; below this the carousel just
# twitches between pulses.
SERVO_MIN_PPS = 200
# Idle frequency programmed into the PWM channel while it is switched off.
SERVO_IDLE_HZ = 1000
# Micro-jog pulse rate. Deliberately slow (bit-banged, exact pulse count) so a
# jog of N pulses moves exactly N pulses — this is an ALIGNMENT tool.
SERVO_JOG_PPS = 800
SERVO_JOG_MAX_PULSES = 20000
# Manual §3: DIR must be stable at least 5 µs before the first PUL edge. Python
# cannot sleep 5 µs reliably, so wait 1 ms — invisible to the operator.
SERVO_DIR_SETUP_S = 0.001
# Motor B faces the other way on most dual-chain builds, so its DIR is inverted
# for the two to pull the same way. Flip from the app if yours is wired alike.
SERVO_MIRROR_B = True

# Where the agent remembers the selected drive mode and servo parameters between
# restarts. Written whenever the app pushes a `config` with motor fields.
MOTOR_CONF_PATH = "/var/lib/pax-agent/motor.json"

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
# Fraction of the last measured shelf-to-shelf interval that the smooth
# deceleration on the final approach is allowed to occupy. The decel ramp runs
# BEFORE the target flag is detected, across the pitch that already exists
# between the penultimate shelf and the target, so it never adds overshoot — but
# it MUST finish before the flag arrives or the carousel would still be fast at
# the stop. Sizing it to a fraction of the observed pitch guarantees that: the
# final leg starts at cruise and then slows, so it always lasts longer than the
# cruise-speed pitch this fraction is taken from.
DECEL_LEG_FRACTION = 0.6
PULSE_TIMEOUT = 8.0   # seconds to wait for the next shelf pulse before faulting
HOME_TIMEOUT = 30.0   # default seconds to find the index sensor before faulting
# The servo build turns the carousel through a 1:50 gearbox and is a good deal
# slower between flags than the DC build these timeouts were tuned on, so give
# it twice as long before calling a move or a homing run stuck. DC keeps 1x.
SERVO_TIMEOUT_SCALE = 2.0
# The operator can override the homing time per carousel from Settings →
# Motor drive → "Homing time" (config.homeTimeoutS). The drive default is
# HOME_TIMEOUT × the scale above (30 s DC / 60 s servo). Bounds below.
HOME_TIMEOUT_MIN_S = 5.0
HOME_TIMEOUT_MAX_S = 600.0
# Motor drive → "Shelf timeout" (config.shelfTimeoutS). Replaces the
# PULSE_TIMEOUT × drive-scale base of the move's jam guard; speed scaling, ramp
# and Safe move time are still added on top.
SHELF_TIMEOUT_MIN_S = 2.0
SHELF_TIMEOUT_MAX_S = 300.0
# Motor drive → "Auto-correct chains at shelf 1" (DC, two bridges). Shelf 1
# carries both the shelf flag and the home flag, so the two sensors should fire
# together as it passes. If one leads the other by more than the tolerance, the
# leading side's bridge is paused until the lagging sensor fires.
CHAIN_SYNC_DEFAULT_TOLERANCE_MS = 150.0
CHAIN_SYNC_MAX_TOLERANCE_MS = 5000.0
# Longest a paused bridge waits for the other sensor before the move is cut
# with a safety-stop fault, so a dead sensor or a stuck chain can never leave
# the carousel driving on one chain for a lap. The chains are then out of level
# and the operator must jog them straight and re-home. Operator-adjustable per
# carousel ("Safety stop after"); this is the default and the allowed range.
CHAIN_SYNC_MAX_WAIT_S = 3.0
CHAIN_SYNC_MIN_WAIT_S = 0.5
CHAIN_SYNC_MAX_WAIT_LIMIT_S = 60.0
# Motor balance auto-calibration: full carousel turns each chain is timed over.
# More turns average out sensor jitter; three is plenty for a 0.01 % result on
# a lap of a minute.
BALANCE_CAL_DEFAULT_TURNS = 3
BALANCE_CAL_MAX_TURNS = 10
# Once the first chain has finished its turns, the other may need this fraction
# of the first chain's time (plus a floor) to catch up. ±20 % of trim can only
# fix a 25 % speed difference, so anything slower than that is a mechanical
# problem, not a balance problem, and the run is cut.
BALANCE_CAL_CATCH_UP_FRACTION = 0.25
# The home sensor only fires once per lap during calibration, and the chains
# start on the flag, so its silence guard must cover a whole lap plus slack.
BALANCE_CAL_LAP_GUARD_MARGIN = 1.5
BALANCE_CAL_CATCH_UP_FLOOR_S = 3.0
# How often a long sensor wait re-checks for an emergency stop. Small enough to
# feel instant to an operator, large enough not to spin the CPU.
ABORT_POLL_SECONDS = 0.02
SENSOR_BOUNCE = 0.01  # debounce (s) for the inductive sensors
# How often the sensor-watch thread samples the shelf sensor's logical level to
# report it to the app. This drives only the UI status lamp — NOT shelf counting
# (that is edge-driven in the motion code) — so a light 20 Hz poll is plenty
# responsive without loading the CPU or perturbing the timing-critical counting.
SENSOR_POLL_SECONDS = 0.05
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
# ---------------------------------------------------------------------------
# Distance-based shelf-edge filter (Carousel._do_goto).
#
# The time lockout above only knows "how long ago"; it cannot tell a slow swing
# from a slow shelf. A DISTANCE test can. On the servo build the pulse odometer
# says exactly how far the chain has moved since the last counted edge, so an
# edge that arrives inside BOUNCE_PITCH_FRACTION of a shelf pitch is the same
# shelf rocking back into the window, never the next one — regardless of ramp or
# speed. The DC build has no odometer, so it falls back to the same test in TIME,
# against the pitch interval just measured in this move (BOUNCE_TIME_FRACTION,
# deliberately looser because the first interval of a move includes the ramp).
BOUNCE_PITCH_FRACTION = 0.5
BOUNCE_TIME_FRACTION = 0.35
# The FIRST edge of a move. A stop that lands exactly as the flag reaches the
# sensor can leave the shelf a hair short of the window, or rocking back out of
# it; the next move then drags that same flag in and the carousel believes it
# gained a shelf it never travelled. Any edge within this fraction of a pitch of
# the starting point is that parked shelf, not a new one.
START_REENTRY_PITCH_FRACTION = 0.3
# Pulse positioning (servo): deceleration leg before the target as a fraction of
# a shelf pitch, and how often the duty is re-issued along it.
PULSE_DECEL_PITCH_FRACTION = 0.5
PULSE_DUTY_UPDATE_S = 0.02
# The calibration revolution may take a while on a slow chain: allowance for the
# full turn, as a multiple of HOME_TIMEOUT (already drive-scaled).
CALIBRATE_TIMEOUT_SCALE = 3.0


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


# Travel time for ONE shelf pitch at MOVE_SPEED. Not used to decide position --
# the sensor always does that -- only to say how EARLY an edge has to be before it
# is physically impossible for it to be the next shelf.
SHELF_TRAVEL_AT_MOVE_SPEED = 0.5

# Fraction of a shelf pitch that two accepted shelf counts must be separated by.
#
# The chain can only rock by its own backlash, a fixed mechanical property well
# under one shelf spacing. An edge that appears after less travel than this cannot
# be a new shelf, because the next shelf is a WHOLE pitch away. Kept below 0.5 so
# the rule can never reach halfway to a genuine shelf: if a machine ever has more
# slack than this the cure is to tension the chain, not to widen the window, and
# widening it past 0.5 would start swallowing real shelves.
DEPARTURE_SLACK_FRACTION = 0.45


def min_shelf_gap_for(duty: float) -> float:
    """
    The shortest time in which the carousel could genuinely reach the NEXT shelf.

    Anything sooner is mechanical -- chain slack, a lurch, a flag rocking back
    across the sensor -- and must not be counted. Used ONLY to reject the
    physically impossible, never to decide where the carousel is; the sensor
    always does that.

    Scaled by duty because travel time per pitch is inversely proportional to it,
    so the window stays the same fraction of the real shelf SPACING at every
    speed. That is what makes one constant correct at 45% duty and at 5% alike.

    Two things a single sensor cannot distinguish by level alone, both of which
    produce a real rising edge and both of which were being counted as shelves:

      - THE START OF A MOVE. The carousel is parked on a flag, so energising the
        motor takes up slack: the flag drops back out of the window and is then
        pulled forwards into it again.
      - THE ARRIVAL CHANGEOVER. At one shelf short of target the duty drops to
        the arrival value, and that sudden torque change lets the chain lurch,
        which can carry the shelf just counted back across the sensor.

    Distance travelled is the one thing that separates those from a real shelf.
    """
    pitch = SHELF_TRAVEL_AT_MOVE_SPEED * (MOVE_SPEED / max(0.01, duty))
    return min(SHELF_SETTLE_MAX, DEPARTURE_SLACK_FRACTION * pitch)
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

# Invert what the sensor signal MEANS, without touching how it is wired.
#
# True  -> a shelf is present when the sensor reads INACTIVE (signal absent).
# False -> a shelf is present when the sensor reads ACTIVE (signal present).
#
# Set this, not SENSOR_TYPE, to fix "it counts in the gaps instead of on the
# shelves". SENSOR_TYPE controls the pull resistor, which is an ELECTRICAL
# property: changing it to flip the logic would leave an NPN line floating, and
# a real PNP sensor needs a level shifter first or it puts 12/24 V into a 3.3 V
# GPIO. This flag is pure logic and is always safe to change.
#
# Use True for a normally-closed sensor, or when the flags are cut as NOTCHES in
# an otherwise continuous ring rather than as tabs — in both cases the signal is
# present everywhere EXCEPT at a shelf, so every edge and level below has to be
# read the other way round.
SENSOR_INVERT = True

# Which way the motor turns for "up" (decreasing shelf index). Flip if your
# carousel runs backwards relative to the app's direction labels.
HOMING_DIRECTION = "down"


def home_travel_direction() -> str:
    """
    The carousel direction ("up"/"down") the homing sweep runs in. The balance
    calibration defaults to the same direction so the operator sees both turn
    the same way, and so a single shared balance is measured where it matters
    most: on the homing pass that levels the chains.
    """
    return "up" if HOMING_DIRECTION == "down" else "down"


# ==========================================================================
# Persisted motor-drive selection
# ==========================================================================
def load_motor_conf() -> dict:
    """Read the drive mode + servo tuning saved by a previous `config`."""
    try:
        with open(MOTOR_CONF_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as exc:
        print(f"[agent] motor.json unreadable ({exc}); using defaults", flush=True)
        return {}


def save_motor_conf(conf: dict) -> None:
    """
    Persist the drive mode so the next boot initialises the right backend
    before the app has even connected. Best-effort: a read-only filesystem must
    not take the motor down, it just means the mode is re-applied on connect.
    """
    try:
        import os

        os.makedirs(os.path.dirname(MOTOR_CONF_PATH), exist_ok=True)
        tmp = MOTOR_CONF_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(conf, fh)
        os.replace(tmp, MOTOR_CONF_PATH)
    except Exception as exc:
        print(f"[agent] could not persist motor config ({exc}); will re-apply on next connect", flush=True)


# ==========================================================================
# Hardware backends
# ==========================================================================
def _present(devices) -> tuple:
    """GPIO devices that exist (twin mode leaves the other side's channel None)."""
    return tuple(d for d in devices if d is not None)


class RealHardware:
    """
    Drives real GPIO through gpiozero: two DC motors, each on its own BTS7960
    bridge (motor A / motor B, one per chain), plus the two inductive sensors.

    The motor half lives in `_init_motor` / `forward` / `backward` / `stop` /
    `_close_motor` / `jog` so `ServoHardware` can swap in PUL/DIR control while
    reusing every sensor-counting detail below unchanged. The motion code only
    ever calls `forward`/`backward`/`stop` with a 0..1 "speed", which a DC
    bridge turns into a PWM duty on BOTH bridges and a servo drive turns into a
    pulse frequency on both PUL lines.
    """

    motor_mode = "dc"

    def __init__(
        self,
        mirror_b: Optional[bool] = None,
        motor_index: Optional[int] = None,
        shelf_pin: int = PIN_SHELF_SENSOR,
        index_pin: int = PIN_INDEX_SENSOR,
    ) -> None:
        from gpiozero import DigitalInputDevice  # imported lazily

        if mirror_b is not None:
            self.mirror_b = bool(mirror_b)
        # Twin carousels: this backend owns ONE motor (0 = A, 1 = B) and only
        # claims that motor's pins, so a second backend can own the other one.
        self.motor_index = motor_index if motor_index in (0, 1) else None
        # Twin side only: run this carousel's one motor the other way round.
        self.reverse = False
        self._init_motor()
        # An NPN (sinking) sensor pulls the line to GND when it detects a shelf,
        # so we pull the pin up and let gpiozero treat LOW as active. A PNP
        # (sourcing) sensor is the mirror image: pull down, HIGH is active.
        # gpiozero derives `is_active` from pull_up, so the rest of this class
        # stays level-agnostic and only this flag has to change.
        pull_up = SENSOR_TYPE.upper() == "NPN"
        self.shelf = DigitalInputDevice(shelf_pin, pull_up=pull_up, bounce_time=SENSOR_BOUNCE)
        self.index = DigitalInputDevice(index_pin, pull_up=pull_up, bounce_time=SENSOR_BOUNCE)

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
        # WHICH EDGE MEANS "METAL ARRIVED" depends on SENSOR_INVERT.
        #
        # gpiozero names these after the electrical level, not after the shelf. On
        # an inverted sensor the signal is present in the GAPS, so metal arriving
        # DEACTIVATES the input and `when_deactivated` is the arrival edge. Leaving
        # these unswapped is what makes the carousel count in the gaps and stop
        # between shelves — the count would be off by exactly half a pitch.
        if SENSOR_INVERT:
            self.shelf.when_deactivated = self._on_shelf
            self.index.when_deactivated = self._on_index
        else:
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
        # The exit edge is the opposite one, mirrored the same way — otherwise it
        # would be bound to the same edge as the arrival above and every arrival
        # would immediately register as a departure.
        if SENSOR_INVERT:
            self.shelf.when_activated = self._on_shelf_exit
        else:
            self.shelf.when_deactivated = self._on_shelf_exit

    def set_shelf_settle(self, seconds: float) -> None:
        """Lockout applied AFTER a counted shelf, to swallow that shelf's bounce."""
        with self._lock:
            self._shelf_settle = max(0.0, seconds)

    def arm_shelf_lockout(self) -> None:
        """
        Start the bounce lockout NOW, without counting a shelf.

        Used when a move starts parked on a flag. That flag is about to be
        dragged out of the window and can rock back into it as the chain takes
        up; arming the lockout makes the hardware treat such a return as the
        bounce it is. Without this the first edge of every move was accepted
        unconditionally, because `reset_pulses` had just cleared the lockout.
        """
        with self._lock:
            self._last_counted = time.monotonic()

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

    # ---- motor backend (DC / two BTS7960 bridges) ---------------------------
    # `mirror_b` is read by `_init_motor` through `getattr` so a subclass that
    # does not set it (ServoHardware has its own) still constructs cleanly.
    mirror_b: bool = DC_MIRROR_B
    # PWM balance from the app's "Motor balance" slider, -20..+20 %. Two
    # brushed motors never match for the same duty, so the FASTER bridge is
    # scaled down: negative trims A, positive trims B, 0 = equal duty.
    dc_trim_pct: float = 0.0
    # Optional second balance for "up" travel (the homing direction). Gearboxes
    # and brushes rarely drag the same amount both ways, so when
    # `dc_trim_per_dir` is on, "down" uses dc_trim_pct and "up" uses this one.
    dc_trim_up_pct: float = 0.0
    dc_trim_per_dir: bool = False

    def _channels(self) -> tuple:
        """Motor indexes this backend owns: both, or just its twin-side motor."""
        mi = getattr(self, "motor_index", None)
        return (mi,) if mi in (0, 1) else (0, 1)

    def trim_for_direction(self, direction: str) -> float:
        """The balance in force for carousel travel `direction` ("up"/"down")."""
        if direction == "up" and self.dc_trim_per_dir:
            return float(self.dc_trim_up_pct)
        return float(self.dc_trim_pct)

    def _trim_scale(self, index: int, forward: bool = True) -> float:
        if getattr(self, "motor_index", None) is not None:
            return 1.0  # balance only means something with two motors
        # Bridge "forward" is carousel "down" (see Carousel._energise and jog).
        t = self.trim_for_direction("down" if forward else "up")
        t = max(-DC_TRIM_MAX_PCT, min(DC_TRIM_MAX_PCT, t))
        if index == 0 and t < 0:
            return 1.0 + t / 100.0
        if index == 1 and t > 0:
            return 1.0 - t / 100.0
        return 1.0

    def _init_motor(self) -> None:
        from gpiozero import Motor, DigitalOutputDevice

        # BTS7960: passing NO `enable` to Motor makes gpiozero PWM the two
        # direction pins directly, which is exactly what RPWM/LPWM want — it
        # drives one pin with the duty cycle and holds the other at 0.
        # Index 0 is motor A, index 1 is motor B — the same order the servo
        # backend and the `jog` command use.
        # An unowned channel (twin mode) stays None so its pins remain free.
        pins = (
            (PIN_MOTOR_A_RPWM, PIN_MOTOR_A_LPWM, PIN_MOTOR_A_EN),
            (PIN_MOTOR_B_RPWM, PIN_MOTOR_B_LPWM, PIN_MOTOR_B_EN),
        )
        owned = self._channels()
        self.motors = tuple(
            Motor(forward=p[0], backward=p[1], pwm=True) if i in owned else None
            for i, p in enumerate(pins)
        )
        # R_EN and L_EN of each bridge tied to one GPIO: HIGH arms the bridge,
        # LOW makes the outputs float. Pulling this LOW is a true hardware stop
        # that works even if a PWM pin is stuck, so the estop path uses it.
        self.enables = tuple(
            DigitalOutputDevice(p[2], initial_value=True) if i in owned else None
            for i, p in enumerate(pins)
        )
        self._motor_lock = threading.Lock()
        self._jog_abort = False

    def _drive_one(self, index: int, forward: bool, speed: float) -> None:
        """Run ONE bridge in the carousel's `forward` sense, honouring mirror B."""
        if self.motors[index] is None:
            return
        if self.motor_index is not None:
            # Twin side: one motor, flipped by its own "Reverse" switch only.
            bridge_forward = forward != bool(getattr(self, "reverse", False))
        else:
            bridge_forward = forward if (index == 0 or not self.mirror_b) else (not forward)
        duty = max(0.0, min(1.0, float(speed) * self._trim_scale(index, forward)))
        self.enables[index].on()  # re-arm in case an estop left the bridge disabled
        if bridge_forward:
            self.motors[index].forward(duty)
        else:
            self.motors[index].backward(duty)

    def forward(self, speed: float) -> None:
        with self._motor_lock:
            for i in self._channels():
                self._drive_one(i, True, speed)

    def backward(self, speed: float) -> None:
        with self._motor_lock:
            for i in self._channels():
                self._drive_one(i, False, speed)

    def stop(self) -> None:
        # Zero the PWM first so each bridge brakes cleanly, then disarm it. Doing
        # it in this order avoids floating the outputs while a duty cycle is
        # still applied.
        with self._motor_lock:
            for m in self.motors:
                if m is not None:
                    m.stop()
            for en in self.enables:
                if en is not None:
                    en.off()

    def can_chain_sync(self) -> bool:
        """Two bridges owned by this process: the chain-sync pause has a motor to hold."""
        return getattr(self, "motor_index", None) is None and all(m is not None for m in self.motors)

    def hold_one(self, index: int) -> None:
        """Pause ONE bridge (coast) while the other keeps driving; the enable stays armed."""
        with self._motor_lock:
            m = self.motors[index]
            if m is not None:
                m.stop()

    def release_one(self, index: int, forward: bool, speed: float) -> None:
        """Run a paused bridge again at the current duty, in the carousel's `forward` sense."""
        with self._motor_lock:
            self._drive_one(index, forward, speed)

    def _close_motor(self) -> None:
        self.stop()  # leave both bridges disarmed on exit
        for dev in (*self.motors, *self.enables):
            if dev is not None:
                dev.close()

    def jog(self, motor: str, direction: str, amount: int, speed: Optional[float] = None) -> None:
        """
        Timed jog: run motor "a", "b" or "both" in `direction` for `amount`
        MILLISECONDS at a fixed duty. This is the DC equivalent of the servo's
        pulse-count jog — the alignment tool for levelling the two chains. It
        blocks on the Carousel worker; `abort_jog()` (estop) cuts it short
        within one DC_JOG_SLICE_S.
        """
        ms = max(0, min(DC_JOG_MAX_MS, int(amount)))
        if ms == 0:
            return
        duty = DC_JOG_DUTY if speed is None else max(SLIDER_MIN_DUTY, min(1.0, float(speed)))
        if self.motor_index is not None:
            # Twin side: its one motor IS the carousel, whatever was asked.
            targets = (self.motor_index,)
        else:
            targets = (0, 1) if motor == "both" else ((0,) if motor == "a" else (1,))
        # Same convention as Carousel._energise: "down" is the bridge's forward.
        forward = direction == "down"
        self._jog_abort = False
        with self._motor_lock:
            for i in targets:
                self._drive_one(i, forward, duty)
        deadline = time.monotonic() + ms / 1000.0
        try:
            while time.monotonic() < deadline:
                if self._jog_abort:
                    break
                time.sleep(min(DC_JOG_SLICE_S, max(0.0, deadline - time.monotonic())))
        finally:
            self.stop()

    def abort_jog(self) -> None:
        self._jog_abort = True

    def set_servo_params(
        self, mirror_b=None, dc_trim_pct=None, dc_trim_up_pct=None, dc_trim_per_dir=None, **_: object
    ) -> None:
        """
        Drive tuning from the app's `config`. The DC bridge cares about
        `mirror_b` and the PWM balance; pulses/rate are servo-only and ignored.
        """
        if mirror_b is not None:
            self.mirror_b = bool(mirror_b)
        changed = False
        if dc_trim_pct is not None:
            new_trim = max(-DC_TRIM_MAX_PCT, min(DC_TRIM_MAX_PCT, float(dc_trim_pct)))
            if new_trim != self.dc_trim_pct:
                self.dc_trim_pct = new_trim
                changed = True
        if dc_trim_up_pct is not None:
            new_up = max(-DC_TRIM_MAX_PCT, min(DC_TRIM_MAX_PCT, float(dc_trim_up_pct)))
            if new_up != self.dc_trim_up_pct:
                self.dc_trim_up_pct = new_up
                changed = True
        if dc_trim_per_dir is not None and bool(dc_trim_per_dir) != self.dc_trim_per_dir:
            self.dc_trim_per_dir = bool(dc_trim_per_dir)
            changed = True
        if changed:
            if self.dc_trim_per_dir:
                print(
                    f"[agent] motor balance down = {self.dc_trim_pct:+.3f} % "
                    f"(A x{self._trim_scale(0, True):.3f} / B x{self._trim_scale(1, True):.3f}), "
                    f"up = {self.dc_trim_up_pct:+.3f} % "
                    f"(A x{self._trim_scale(0, False):.3f} / B x{self._trim_scale(1, False):.3f})",
                    flush=True,
                )
            else:
                print(
                    f"[agent] motor balance = {self.dc_trim_pct:+.3f} % both directions "
                    f"(A x{self._trim_scale(0):.3f} / B x{self._trim_scale(1):.3f})",
                    flush=True,
                )

    def servo_snapshot(self) -> Optional[dict]:
        """
        Drive status (`servo` event on the wire, kept for compatibility). In DC
        mode it tells the app which backend is live and how motor B is mirrored;
        there are no alarm lines on a BTS7960, so those fields are absent.
        """
        return {
            "type": "servo",
            "mode": "dc",
            "mirrorB": self.mirror_b,
            "dcTrimPct": self.dc_trim_pct,
            "dcTrimUpPct": self.dc_trim_up_pct,
            "dcTrimPerDirection": self.dc_trim_per_dir,
            "jogMaxMs": DC_JOG_MAX_MS,
        }

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
        while self._index_level():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    # Every level read in this class goes through these two helpers, so the
    # inversion is applied in exactly one place per sensor and cannot drift
    # between the "is metal there now" checks and the "wait until it is gone"
    # loops. Reading `.is_active` directly anywhere below would bypass it.
    def _shelf_level(self) -> bool:
        """True when a shelf flag is in front of the sensor."""
        raw = bool(self.shelf.is_active)
        return (not raw) if SENSOR_INVERT else raw

    def _index_level(self) -> bool:
        """True when the home flag is in front of the sensor."""
        raw = bool(self.index.is_active)
        return (not raw) if SENSOR_INVERT else raw

    def index_active(self) -> bool:
        return self._index_level()

    def shelf_clear(self, timeout: float) -> bool:
        """
        Block until the shelf window is EMPTY, leaving motor power untouched so
        the carousel keeps driving off the flag while we watch.

        This is the counterpart to `index_clear` for the per-shelf sensor, and it
        is what makes parking ON the sensor safe: the level is only consulted to
        decide when COUNTING may begin, never whether the motor is energised.
        """
        deadline = time.monotonic() + timeout
        while self._shelf_level():
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def shelf_active(self) -> bool:
        return self._shelf_level()

    def in_shelf_lockout(self) -> bool:
        """
        True while metal in the window still belongs to the shelf just counted.

        The interrupt path applies this lockout in `_on_shelf`, but the counting
        loop ALSO detects shelves by polling `shelf_active()`, and that path had
        no lockout at all. So a flag rocking back into the window was rejected as
        a bounce on one path and accepted as a new shelf on the other -- which is
        how the lurch at the arrival changeover got counted and every multi-shelf
        move finished one shelf early. Exposing the same state lets the poll path
        honour the same decision instead of contradicting it.
        """
        with self._lock:
            last = self._last_counted
            lockout = self._shelf_settle
            if last is None or lockout <= 0:
                return False
            return (time.monotonic() - last) < lockout

    def cleanup(self) -> None:
        try:
            self._close_motor()
            self.shelf.close()
            self.index.close()
        except Exception:
            pass


class ServoHardware(RealHardware):
    """
    Two iSV57T integrated servos driven by pulse (PUL) and direction (DIR).

    Sensors, shelf counting and the lockout logic are inherited unchanged from
    RealHardware; only the motor half is replaced:

      * `forward`/`backward(speed)` set both DIR lines and start a continuous
        50 % duty pulse train on both PUL lines at `speed × max_pps` Hz. The
        drive runs in position mode (Pr0.01 = 0) and follows the pulse stream,
        so velocity control IS pulse-frequency control. Both channels carry the
        same frequency and direction, so the two motors stay synchronised.
      * `stop()` zeroes the duty: the PUL line goes low and the servo holds its
        last position with full torque. A stopped servo therefore brakes far
        harder than a coasting DC motor, which is why servo users see less
        overshoot and can usually run a faster approach.
      * `release()` / `engage()` drive the ENA inputs. Released, the motors are
        de-energised and the carousel can be turned by hand; the Carousel
        releases them after an idle timeout and every move/jog re-engages them
        first (with a short settle so no pulses are lost).
      * `jog(motor, direction, pulses)` bit-bangs an exact number of pulses to
        ONE motor (or both) at a slow rate. This is the alignment tool: if the
        two chains drift, nudge one side until the shelf hangs level.
    """

    motor_mode = "servo"

    def __init__(
        self,
        pulses_per_rev: int = SERVO_PULSES_PER_REV,
        max_pps: int = SERVO_MAX_PPS,
        mirror_b: bool = SERVO_MIRROR_B,
        ignore_alarm: bool = False,
        single_motor: bool = False,
        motor_index: Optional[int] = None,
        shelf_pin: int = PIN_SHELF_SENSOR,
        index_pin: int = PIN_INDEX_SENSOR,
    ) -> None:
        self.pulses_per_rev = max(1, int(pulses_per_rev))
        self.max_pps = max(SERVO_MIN_PPS, min(300_000, int(max_pps)))
        self.mirror_b = bool(mirror_b)
        # One-servo hardware carousel: only channel A is pulsed and monitored.
        self.single_motor = bool(single_motor)
        # ALM has a pull-up, so an UNWIRED ALM pin reads exactly like a tripped
        # drive. Builds without ALM+/ALM- connected set this to run anyway.
        self.ignore_alarm = bool(ignore_alarm)
        super().__init__(motor_index=motor_index, shelf_pin=shelf_pin, index_pin=index_pin)

    def _init_motor(self) -> None:
        from gpiozero import PWMOutputDevice, DigitalOutputDevice, DigitalInputDevice

        # Twin mode claims only this side's channel; the other stays None so the
        # second backend on the same Pi can own those pins.
        owned = self._channels()

        def pair(make_a, make_b):
            return (make_a() if 0 in owned else None, make_b() if 1 in owned else None)

        self.pul = pair(
            lambda: PWMOutputDevice(PIN_SERVO_PUL_A, frequency=SERVO_IDLE_HZ, initial_value=0),
            lambda: PWMOutputDevice(PIN_SERVO_PUL_B, frequency=SERVO_IDLE_HZ, initial_value=0),
        )
        self.dir = pair(
            lambda: DigitalOutputDevice(PIN_SERVO_DIR_A, initial_value=False),
            lambda: DigitalOutputDevice(PIN_SERVO_DIR_B, initial_value=False),
        )
        # ALM is an opto-isolated open-collector output that CONDUCTS in normal
        # operation and goes high-impedance on a fault. With the Pi's pull-up,
        # gpiozero's `is_active` (pin LOW) therefore means "healthy".
        self.alm = pair(
            lambda: DigitalInputDevice(PIN_SERVO_ALM_A, pull_up=True, bounce_time=0.05),
            lambda: DigitalInputDevice(PIN_SERVO_ALM_B, pull_up=True, bounce_time=0.05),
        )
        # Start ENGAGED (holding) so power-up matches the drive's own default.
        # `active_high` folds the opto polarity in: `.on()` always means "release".
        self.ena = pair(
            lambda: DigitalOutputDevice(PIN_SERVO_ENA_A, active_high=SERVO_ENA_ACTIVE_RELEASES, initial_value=False),
            lambda: DigitalOutputDevice(PIN_SERVO_ENA_B, active_high=SERVO_ENA_ACTIVE_RELEASES, initial_value=False),
        )
        self._held = True
        self._motor_lock = threading.Lock()
        self._pulsing = False
        self._forward: Optional[bool] = None
        # Pulse ODOMETER. The pulse train is a PWM carrier at a set frequency,
        # so nothing counts the individual pulses; instead every segment of
        # constant frequency is integrated (hz × seconds, signed by direction)
        # the moment it ends. The drive steps once per pulse, so this IS the
        # commanded position, good to well under a percent — and the index flag
        # re-syncs the remainder on every pass (see Carousel._do_goto_pulses).
        self._odo_lock = threading.Lock()
        self._odo_pulses = 0.0
        self._odo_hz = 0
        self._odo_sign = 0
        self._odo_t0 = time.monotonic()

    def _odo_close_segment(self) -> None:
        """Bank the segment that is ending. Caller holds `_odo_lock`."""
        now = time.monotonic()
        if self._odo_hz > 0 and self._odo_sign != 0:
            self._odo_pulses += self._odo_sign * self._odo_hz * (now - self._odo_t0)
        self._odo_t0 = now

    def _odo_segment(self, hz: int, sign: int) -> None:
        """Start a new constant-frequency segment (hz=0 or sign=0 = stopped)."""
        with self._odo_lock:
            self._odo_close_segment()
            self._odo_hz = hz
            self._odo_sign = sign

    def pulse_position(self) -> float:
        """Signed pulses sent since start-up: forward() counts up, backward() down."""
        with self._odo_lock:
            self._odo_close_segment()
            return self._odo_pulses

    def pulse_rate(self, speed: float) -> float:
        """Pulses per second the carrier runs at for a 0..1 speed."""
        return float(self._hz_for(speed))

    @property
    def held(self) -> bool:
        """True while the servos are energised and holding position."""
        return self._held

    def engage(self) -> None:
        """Re-energise both servos. Blocks for the settle time if they were released."""
        with self._motor_lock:
            if self._held:
                return
            for e in _present(self.ena):
                e.off()
            time.sleep(SERVO_ENABLE_SETTLE_S)
            self._held = True

    def release(self) -> None:
        """De-energise both servos so the carousel can be moved by hand."""
        with self._motor_lock:
            self._odo_segment(0, 0)
            for p in _present(self.pul):
                p.value = 0
            self._pulsing = False
            for e in _present(self.ena):
                e.on()
            self._held = False

    # The motion code's "forward"/"backward" map onto DIR levels here. Motor B
    # is mirrored when the two servos face each other across the carousel.
    def _dir_levels(self, forward: bool) -> tuple[bool, bool]:
        if self.motor_index is not None:
            level = forward != bool(getattr(self, "reverse", False))
            return level, level
        a = forward
        b = (not forward) if self.mirror_b else forward
        return a, b

    def _hz_for(self, speed: float) -> int:
        speed = max(0.0, min(1.0, float(speed)))
        return max(SERVO_MIN_PPS, int(round(speed * self.max_pps)))

    def _active_pul(self) -> tuple:
        """PUL outputs that drive the carousel: A only on a one-servo build."""
        if self.motor_index is not None:
            return _present(self.pul)
        return self.pul[:1] if self.single_motor else self.pul

    def _set_dir(self, forward: bool) -> None:
        a, b = self._dir_levels(forward)
        if self.dir[0] is not None:
            self.dir[0].value = a
        if self.dir[1] is not None:
            self.dir[1].value = b

    def _run_pulses(self, forward: bool, speed: float) -> None:
        self.engage()
        with self._motor_lock:
            hz = self._hz_for(speed)
            if not self._pulsing or self._forward != forward:
                # Never flip DIR under a running pulse train: stop, set the
                # direction, give it the setup time the drive asks for, resume.
                self._odo_segment(0, 0)
                for p in _present(self.pul):
                    p.value = 0
                self._set_dir(forward)
                time.sleep(SERVO_DIR_SETUP_S)
            for p in self._active_pul():
                p.frequency = hz
            for p in self._active_pul():
                p.value = 0.5
            self._odo_segment(hz, 1 if forward else -1)
            self._pulsing = True
            self._forward = forward

    def forward(self, speed: float) -> None:
        self._run_pulses(True, speed)

    def backward(self, speed: float) -> None:
        self._run_pulses(False, speed)

    def stop(self) -> None:
        with self._motor_lock:
            self._odo_segment(0, 0)
            for p in _present(self.pul):
                p.value = 0
            self._pulsing = False

    def _close_motor(self) -> None:
        self.stop()
        # Leave the drives in their power-up (enabled) state, not released.
        for e in _present(self.ena):
            e.off()
        for dev in _present((*self.pul, *self.dir, *self.alm, *self.ena)):
            dev.close()

    def jog(self, motor: str, direction: str, amount: int, speed: Optional[float] = None) -> None:
        """
        Send exactly `amount` pulses to motor "a", "b" or "both" in `direction`
        ("up"/"down", the same words the move logic uses). `speed` is accepted
        for signature parity with the DC backend and ignored: the jog rate is
        fixed so the pulse count stays exact. Blocking; runs on the Carousel
        worker so an estop (`stop()` + abort) can cut it short only between
        pulses — a few hundred microseconds.
        """
        pulses = max(0, min(SERVO_JOG_MAX_PULSES, int(amount)))
        if pulses == 0:
            return
        if self.motor_index is not None:
            # Twin side: its one servo IS this carousel's drive.
            motor = "both"
            targets = (self.motor_index,)
        elif self.single_motor:
            # The one servo IS the carousel drive: any jog moves the carousel,
            # and channel B has nothing connected.
            if motor == "b":
                return
            motor = "both"
            targets = (0,)
        else:
            targets = (0, 1) if motor == "both" else ((0,) if motor == "a" else (1,))
        self.engage()
        # Same convention as Carousel._energise: "down" is the bridge's forward.
        forward = direction == "down"
        half = 0.5 / SERVO_JOG_PPS
        with self._motor_lock:
            self._odo_segment(0, 0)
            for p in _present(self.pul):
                p.value = 0
            self._pulsing = False
            self._set_dir(forward)
            time.sleep(SERVO_DIR_SETUP_S)
            self._jog_abort = False
            sent = 0
            for _ in range(pulses):
                if self._jog_abort:
                    break
                for i in targets:
                    self.pul[i].value = 1
                time.sleep(half)
                for i in targets:
                    self.pul[i].value = 0
                time.sleep(half)
                sent += 1
            # Only a jog of BOTH chains moves the carousel; nudging one side
            # levels a shelf without changing where the carousel is.
            if motor == "both" and sent:
                with self._odo_lock:
                    self._odo_close_segment()
                    self._odo_pulses += (1 if forward else -1) * sent

    def set_servo_params(
        self,
        pulses_per_rev=None,
        max_pps=None,
        mirror_b=None,
        ignore_alarm=None,
        single_motor=None,
        **_: object,
    ) -> None:
        if pulses_per_rev is not None:
            self.pulses_per_rev = max(1, int(pulses_per_rev))
        if max_pps is not None:
            self.max_pps = max(SERVO_MIN_PPS, min(300_000, int(max_pps)))
        if mirror_b is not None:
            self.mirror_b = bool(mirror_b)
        if ignore_alarm is not None:
            self.ignore_alarm = bool(ignore_alarm)
        if single_motor is not None:
            with self._motor_lock:
                self.single_motor = bool(single_motor)
                if self.single_motor and self.motor_index is None and self.pul[1] is not None:
                    self.pul[1].value = 0

    def alarms(self) -> tuple[bool, bool]:
        """(motor A alarm, motor B alarm) — True when the drive has tripped."""
        if self.ignore_alarm:
            return (False, False)
        # An unused channel has no drive on its ALM, so its pull-up would read
        # as a permanent fault; unowned / one-servo channels never report.
        a = self.alm[0] is not None and not self.alm[0].is_active
        b_used = self.alm[1] is not None and not (self.single_motor and self.motor_index is None)
        b = b_used and not self.alm[1].is_active
        return (a, b)

    def servo_snapshot(self) -> Optional[dict]:
        a, b = self.alarms()
        return {
            "type": "servo",
            "mode": "servo",
            "alarmA": a,
            "alarmB": b,
            "ignoreAlarm": self.ignore_alarm,
            "pulsesPerRev": self.pulses_per_rev,
            "maxPps": self.max_pps,
            "mirrorB": self.mirror_b,
            "singleMotor": self.single_motor,
            "held": self._held,
        }


class SimHardware:
    """
    Pure-software stand-in so you can run/develop the agent without a Pi.
    A background thread advances a simulated position while the motor "runs",
    producing shelf edges and an index edge at position 0.
    """

    def __init__(self, shelves: int, motor_mode: str = "dc") -> None:
        self.shelves = shelves
        # Pretend to be whichever drive the app selected, so the servo panel
        # (jog, alarm lamps) can be exercised without hardware.
        self.motor_mode = motor_mode if motor_mode in ("dc", "servo") else "dc"
        self.pulses_per_rev = SERVO_PULSES_PER_REV
        self.max_pps = SERVO_MAX_PPS
        self.mirror_b = SERVO_MIRROR_B
        self._held = True
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
        self.engage()
        with self._lock:
            self._dir = +1
            self._speed = speed

    def backward(self, speed: float) -> None:
        self.engage()
        with self._lock:
            self._dir = -1
            self._speed = speed

    def stop(self) -> None:
        with self._lock:
            self._dir = 0
            self._speed = 0.0

    def jog(self, motor: str, direction: str, amount: int, speed: Optional[float] = None) -> None:
        self._jog_abort = False
        self.engage()
        if self.motor_mode == "servo":
            pulses = max(0, min(SERVO_JOG_MAX_PULSES, int(amount)))
            # Take as long as the real bit-banged jog would, and nudge the
            # simulated position by the same fraction of a revolution (one rev
            # ≈ one shelf pitch in this toy model) so the sensor lamp reacts
            # like the real one.
            seconds = pulses / SERVO_JOG_PPS
            delta = pulses / self.pulses_per_rev
        else:
            ms = max(0, min(DC_JOG_MAX_MS, int(amount)))
            duty = DC_JOG_DUTY if speed is None else max(0.0, min(1.0, float(speed)))
            # Same toy model as `_loop`: one shelf every (0.4 / speed) seconds.
            seconds = ms / 1000.0
            delta = seconds * (duty / 0.4)
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline and not self._jog_abort:
            time.sleep(min(DC_JOG_SLICE_S, max(0.0, deadline - time.monotonic())))
        if motor != "both":
            return  # one chain alone does not move the carousel as a whole
        with self._lock:
            self._pos += delta if direction == "down" else -delta

    _jog_abort = False

    def abort_jog(self) -> None:
        self._jog_abort = True

    def set_servo_params(self, pulses_per_rev=None, max_pps=None, mirror_b=None, dc_trim_pct=None, **_: object) -> None:
        if pulses_per_rev is not None:
            self.pulses_per_rev = max(1, int(pulses_per_rev))
        if max_pps is not None:
            self.max_pps = max(SERVO_MIN_PPS, min(300_000, int(max_pps)))
        if mirror_b is not None:
            self.mirror_b = bool(mirror_b)
        if dc_trim_pct is not None:
            self.dc_trim_pct = max(-DC_TRIM_MAX_PCT, min(DC_TRIM_MAX_PCT, float(dc_trim_pct)))

    def __getattr__(self, name: str):
        # The odometer exists only on the servo drive. In DC mode the attribute
        # is absent, exactly as on RealHardware, so the Carousel's
        # `getattr(hw, "pulse_position", None)` probe takes the DC path.
        if name in ("pulse_position", "pulse_rate") and self.__dict__.get("motor_mode") == "servo":
            return self._sim_pulse_position if name == "pulse_position" else self._sim_pulse_rate
        raise AttributeError(name)

    def _sim_pulse_position(self) -> float:
        # Toy model: one motor revolution per shelf pitch, so a carousel
        # revolution calibrates to shelves × pulses_per_rev.
        with self._lock:
            return self._pos * self.pulses_per_rev

    def _sim_pulse_rate(self, speed: float) -> float:
        return max(1.0, (speed / 0.4) * self.pulses_per_rev)

    @property
    def held(self) -> bool:
        return self._held

    def engage(self) -> None:
        if self.motor_mode == "servo" and not self._held:
            time.sleep(SERVO_ENABLE_SETTLE_S)
        self._held = True

    def release(self) -> None:
        if self.motor_mode != "servo":
            raise RuntimeError("Only the servo drive can be released; DC motors are already de-energised when idle.")
        with self._lock:
            self._dir = 0
        self._held = False

    def servo_snapshot(self) -> Optional[dict]:
        if self.motor_mode != "servo":
            return {"type": "servo", "mode": "dc", "mirrorB": self.mirror_b, "jogMaxMs": DC_JOG_MAX_MS}
        return {
            "type": "servo",
            "mode": "servo",
            "alarmA": False,
            "alarmB": False,
            "pulsesPerRev": self.pulses_per_rev,
            "maxPps": self.max_pps,
            "mirrorB": self.mirror_b,
            "held": self._held,
        }

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

    # The simulator has one shared position, so "holding" a bridge changes
    # nothing; these exist so the chain-sync and balance routines can run.
    def can_chain_sync(self) -> bool:
        return self.motor_mode == "dc"

    def hold_one(self, index: int) -> None:
        return None

    def release_one(self, index: int, forward: bool, speed: float) -> None:
        return None

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

    def in_shelf_lockout(self) -> bool:
        """Mirror of the real driver's lockout, so both agree on what a bounce is."""
        with self._lock:
            last = self._last_counted
            lockout = self._shelf_settle
            if last is None or lockout <= 0:
                return False
            return (time.monotonic() - last) < lockout

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
        # Duty for the final shelf — the "slow" arrival speed the operator can now
        # tune from the app. MIN_DUTY is the gentlest duty that still reliably
        # turns the motor, so it is the right default; the slider can go lower for
        # a heavier carousel that coasts, at the risk of stalling if set too low.
        self.approach_speed = MIN_DUTY
        # Servo only: idle seconds before the drives are de-energised so the
        # carousel can be turned by hand. 0 = hold for ever. The watcher thread
        # below applies it; moves and jogs re-engage the servos themselves.
        self.hold_timeout_s = SERVO_HOLD_TIMEOUT_S
        self.sensor_arm_s = 0.0
        # Operator-set homing time; None = drive default (HOME_TIMEOUT × scale).
        self.home_timeout_s: Optional[float] = None
        self.shelf_timeout_s: Optional[float] = None
        self.chain_sync_enabled = False
        self.chain_sync_tolerance_ms = CHAIN_SYNC_DEFAULT_TOLERANCE_MS
        self.chain_sync_max_wait_s = CHAIN_SYNC_MAX_WAIT_S
        self.chain_sync_shelf_side = "a"
        self._chain_sync_last_lead_ms: Optional[float] = None
        self._chain_sync_last_corrected = False
        self._idle_since: Optional[float] = None

        # How a `goto` finds its shelf. "sensor": count shelf-flag edges (the
        # only option on DC). "pulses": servo only — drive a calibrated number
        # of pulses per shelf from the home datum, re-synchronised on every pass
        # of the index flag. Needs a calibration run first.
        self.position_mode = "sensor"
        # Result of the last calibration run (also restored from disk / the
        # app): pulses per carousel revolution, index window width in pulses.
        self.calibration_info: Optional[dict] = None
        self.carousel_pulses: Optional[int] = None
        self.index_window_pulses: Optional[int] = None
        # Odometer reading at the index rising edge that defined shelf 0, and
        # the travel direction that edge was taken in. None until homed.
        self._home_origin: Optional[float] = None
        self._home_edge_direction: Optional[str] = None
        # Shelf pitch in pulses learned from the shelf sensor during ordinary
        # sensor-mode moves (servo only, when not calibrated) so the distance
        # bounce filter has a yardstick before the first calibration.
        self._learned_pitch_pulses: Optional[float] = None
        # Seconds between two consecutive counted shelf flags at cruise, learned
        # from every multi-shelf move. Used to keep SAFE MOVE TIME shorter than
        # one shelf pitch so the blind window can never swallow whole shelves.
        self._learned_pitch_s: Optional[float] = None
        self.last_sync_drift: Optional[int] = None
        # Set by the server to persist a fresh calibration.
        self.on_calibration: Optional[Callable[[dict], None]] = None
        # Set by the server to persist a trim found by the balance calibration.
        self.on_balance: Optional[Callable[[float, str], None]] = None
        self.last_balance: Optional[dict] = None

        self._cmd: Optional[tuple] = None
        self._abort = threading.Event()
        self._wake = threading.Event()
        self._alive = True
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

        # Independent watcher that reports the physical shelf sensor's level to
        # the app. Kept OFF the motion path on purpose: shelf counting is driven
        # by the sensor's edge callbacks with carefully tuned lockouts, and this
        # must never interfere with that. It only reads the same debounced
        # logical level (`shelf_active()`, which already folds in SENSOR_INVERT
        # and polarity) and emits a `sensor` event when it changes.
        self._sensor_last: Optional[bool] = None
        self._sensor_thread = threading.Thread(target=self._watch_sensor, daemon=True)
        self._sensor_thread.start()

    # ---- public API (called from the WebSocket thread) ----
    def request_home(self) -> None:
        self._set_command(("home",))

    def request_goto(self, shelf: int) -> None:
        self._set_command(("goto", shelf % self.shelves))

    def request_calibrate(self) -> None:
        self._set_command(("calibrate",))

    def request_balance_calibrate(self, turns=None, direction=None) -> None:
        n = BALANCE_CAL_DEFAULT_TURNS
        if isinstance(turns, (int, float)) and not isinstance(turns, bool):
            n = max(1, min(BALANCE_CAL_MAX_TURNS, int(turns)))
        d = direction if direction in ("up", "down") else None
        self._set_command(("balance_calibrate", n, d))

    def set_position_mode(self, mode) -> bool:
        if mode not in ("sensor", "pulses", "index"):
            return False
        # A DC bridge has no pulse counter, so "pulses"/"index" (a stale servo
        # setting replayed by the app) cannot be honoured. Fall back to the shelf
        # sensor here, once, instead of faulting on every single goto.
        if mode != "sensor" and self._odometer() is None:
            if mode != self.position_mode:
                print(f"[agent] positioning '{mode}' needs a pulse counter; this drive has none -> sensor", flush=True)
            mode = "sensor"
        if mode == self.position_mode:
            return False
        self.position_mode = mode
        print(f"[agent] positioning = {mode}", flush=True)
        return True

    @property
    def shelf_sensor_fitted(self) -> bool:
        """False in "index" mode: only the home sensor is wired, every stop is by pulses."""
        return self.position_mode != "index"

    def _shelf_lamp(self) -> Optional[bool]:
        return bool(self.hw.shelf_active()) if self.shelf_sensor_fitted else None

    def restore_calibration(self, info) -> bool:
        """
        Adopt a calibration saved earlier (agent's own disk, or the app's copy
        after a re-install). A measurement this agent made itself always wins:
        only taken when nothing is known yet.
        """
        if self.carousel_pulses is not None or not isinstance(info, dict):
            return False
        try:
            ppr = int(info.get("pulsesPerRev") or 0)
        except (TypeError, ValueError):
            return False
        if ppr <= 0:
            return False
        win = info.get("indexWindowPulses")
        self.carousel_pulses = ppr
        self.index_window_pulses = int(win) if isinstance(win, (int, float)) and win > 0 else None
        self.calibration_info = {
            "type": "calibration",
            "ok": True,
            "pulsesPerRev": ppr,
            "indexWindowPulses": self.index_window_pulses,
            "shelfFlagsSeen": info.get("shelfFlagsSeen"),
            "shelves": info.get("shelves"),
            "message": info.get("message") or f"Calibration restored: {ppr} pulses per revolution.",
            "restored": True,
        }
        print(f"[agent] calibration restored: {ppr} pulses/rev, index window {self.index_window_pulses}", flush=True)
        return True

    def calibration_frame(self) -> Optional[dict]:
        if not self.calibration_info:
            return None
        frame = dict(self.calibration_info)
        frame["pulsesPerShelf"] = round(self.carousel_pulses / self.shelves) if self.carousel_pulses else None
        frame["lastDriftPulses"] = self.last_sync_drift
        return frame

    # ---- pulse odometer helpers (servo only; None on the DC bridges) ----
    def _odometer(self) -> Optional[float]:
        fn = getattr(self.hw, "pulse_position", None)
        if not callable(fn):
            return None
        try:
            return float(fn())
        except Exception:
            return None

    def _pulse_rate(self, duty: float) -> float:
        fn = getattr(self.hw, "pulse_rate", None)
        if callable(fn):
            try:
                return max(1.0, float(fn(duty)))
            except Exception:
                pass
        return max(1.0, duty * SERVO_MAX_PPS)

    def _pitch_pulses(self) -> Optional[float]:
        """Shelf pitch in pulses: calibrated if available, else learned from the sensor."""
        if self.carousel_pulses and self.shelves > 0:
            return self.carousel_pulses / self.shelves
        return self._learned_pitch_pulses

    def _pulse_mode_blocker(self) -> Optional[str]:
        if self._odometer() is None:
            return "this drive has no pulse counter"
        if not self.carousel_pulses:
            return "not calibrated yet, run Calibrate first"
        return None

    def request_stop(self) -> None:
        self._abort.set()
        aborter = getattr(self.hw, "abort_jog", None)
        if aborter is not None:
            aborter()
        self.hw.stop()

    def request_jog(self, motor: str, direction: str, amount: int, speed: Optional[float] = None) -> None:
        """
        Nudge one motor (or both). `amount` is in the drive's own unit: exact
        pulses on the servo backend, milliseconds of run time on the DC bridges.
        `speed` (0..1) is only used by the DC backend as the jog duty.
        """
        if motor not in ("a", "b", "both") or direction not in ("up", "down"):
            return
        self._set_command(("jog", motor, direction, int(amount), speed))

    def can_release(self) -> bool:
        return callable(getattr(self.hw, "release", None))

    def request_release(self) -> None:
        """
        De-energise the servos now so the carousel can be moved by hand.
        Refused while moving: releasing under a running pulse train would let
        a loaded shelf drop. The next move/jog re-engages automatically.
        """
        if not self.can_release():
            self.emit({"type": "fault", "message": "Release is a servo-drive feature; the DC bridges are already de-energised whenever the carousel is idle."})
            return
        if self.status != "idle":
            self.emit({"type": "fault", "message": "Servos not released: the carousel is moving. Stop it first."})
            return
        try:
            self.hw.release()
            print("[agent] servos released (free to turn by hand)", flush=True)
        except Exception as exc:
            self.emit({"type": "fault", "message": f"Could not release the servos: {exc}"})
        snap = self.servo_snapshot()
        if snap:
            self.emit(snap)

    def request_hold(self) -> None:
        """Re-energise the servos on demand (they also re-engage before any move)."""
        engage = getattr(self.hw, "engage", None)
        if not callable(engage):
            return
        try:
            engage()
            self._idle_since = time.monotonic()  # restart the idle clock
            print("[agent] servos engaged (holding)", flush=True)
        except Exception as exc:
            self.emit({"type": "fault", "message": f"Could not engage the servos: {exc}"})
        snap = self.servo_snapshot()
        if snap:
            self.emit(snap)

    def set_sensor_arm(self, seconds) -> bool:
        """Safe move time: seconds after a move/home starts before sensors count."""
        if seconds is None:
            return False
        try:
            value = round(max(0.0, min(SENSOR_ARM_MAX_S, float(seconds))), 2)
        except (TypeError, ValueError):
            return False
        if value == self.sensor_arm_s:
            return False
        self.sensor_arm_s = value
        print(f"[agent] safe move time = {value or 'off'} s", flush=True)
        return True

    def set_home_timeout(self, seconds) -> bool:
        """Homing time: seconds to find the index flag. None/0 = drive default."""
        if seconds is None:
            return False
        try:
            raw = float(seconds)
        except (TypeError, ValueError):
            return False
        value: Optional[float] = None if raw <= 0 else round(max(HOME_TIMEOUT_MIN_S, min(HOME_TIMEOUT_MAX_S, raw)), 1)
        if value == self.home_timeout_s:
            return False
        self.home_timeout_s = value
        print(f"[agent] homing time = {value if value is not None else 'drive default'} s", flush=True)
        return True

    def _home_timeout(self) -> float:
        """Effective homing time: the operator's value, else HOME_TIMEOUT × drive scale."""
        if self.home_timeout_s is not None:
            return self.home_timeout_s
        return HOME_TIMEOUT * self._timeout_scale()

    def set_shelf_timeout(self, seconds) -> bool:
        """Shelf timeout: base seconds without a shelf flag before a move faults. None/0 = drive default."""
        if seconds is None:
            return False
        try:
            raw = float(seconds)
        except (TypeError, ValueError):
            return False
        value: Optional[float] = None if raw <= 0 else round(max(SHELF_TIMEOUT_MIN_S, min(SHELF_TIMEOUT_MAX_S, raw)), 1)
        if value == self.shelf_timeout_s:
            return False
        self.shelf_timeout_s = value
        print(f"[agent] shelf timeout = {value if value is not None else 'drive default'} s", flush=True)
        return True

    def set_chain_sync(self, enabled=None, tolerance_ms=None, shelf_side=None, max_wait_s=None) -> bool:
        """Chain sync at shelf 1: on/off, allowed lead in ms, safety-stop wait in s, which bridge carries the shelf sensor."""
        changed = False
        if isinstance(enabled, bool) and enabled != self.chain_sync_enabled:
            self.chain_sync_enabled = enabled
            changed = True
        if isinstance(tolerance_ms, (int, float)) and not isinstance(tolerance_ms, bool):
            tol = float(max(0.0, min(CHAIN_SYNC_MAX_TOLERANCE_MS, float(tolerance_ms))))
            if tol != self.chain_sync_tolerance_ms:
                self.chain_sync_tolerance_ms = tol
                changed = True
        if isinstance(max_wait_s, (int, float)) and not isinstance(max_wait_s, bool):
            wait = float(max(CHAIN_SYNC_MIN_WAIT_S, min(CHAIN_SYNC_MAX_WAIT_LIMIT_S, float(max_wait_s))))
            if wait != self.chain_sync_max_wait_s:
                self.chain_sync_max_wait_s = wait
                changed = True
        if shelf_side in ("a", "b") and shelf_side != self.chain_sync_shelf_side:
            self.chain_sync_shelf_side = shelf_side
            changed = True
        if changed:
            print(
                f"[agent] chain sync = {'on' if self.chain_sync_enabled else 'off'}, "
                f"tolerance {self.chain_sync_tolerance_ms:.0f} ms, safety stop after "
                f"{self.chain_sync_max_wait_s:.1f} s, shelf sensor on motor "
                f"{self.chain_sync_shelf_side.upper()}",
                flush=True,
            )
        return changed

    def _chain_sync_hw(self):
        """The hardware to pause per bridge, or None when sync is off or the drive cannot do it."""
        if not self.chain_sync_enabled:
            return None
        hw = self.hw
        can = getattr(hw, "can_chain_sync", None)
        if can is None or not can() or not hasattr(hw, "hold_one") or not hasattr(hw, "index_active"):
            return None
        return hw

    def _chain_sync_safety_stop(self, paused: int, shelf_idx: int, waited_s: float) -> None:
        """
        Cut both bridges after a chain-sync wait ran out. `paused` is the bridge
        that was held; the other one kept driving and its sensor never fired.
        The carousel is now out of level by an unknown amount and the shelf
        count on the running chain is no longer trustworthy, so the position is
        dropped and a re-home is required before the next automatic move.
        """
        self.hw.stop()
        self.status = "idle"
        self.homed = False
        self._chain_sync_last_corrected = True
        if self._abort.is_set():
            return
        running = "B" if paused == 0 else "A"
        silent = "shelf" if paused != shelf_idx else "home"
        print(f"[agent] chain sync: {silent} sensor silent for {waited_s:.1f} s, SAFETY STOP", flush=True)
        self.emit({
            "type": "fault",
            "message": (
                f"Chain sync safety stop: the {silent} sensor did not trigger within "
                f"{self.chain_sync_max_wait_s:g} s while motor {running} drove alone to catch up. "
                f"Check that the {silent} sensor is working and that motor {running}'s chain is "
                f"not stuck, then level the chains by hand (Jog) and Home before moving again."
            ),
        })
        self.emit(self.snapshot())

    # ---- motor balance auto-calibration (DC, two bridges) ----
    def _balance_frame(self, phase: str, message: str, **extra) -> dict:
        frame = {"type": "balance", "phase": phase, "message": message}
        frame.update(extra)
        return frame

    def _balance_fail(self, message: str, **extra) -> None:
        self.hw.stop()
        self.status = "idle"
        print(f"[agent] balance calibration failed: {message}", flush=True)
        self.last_balance = self._balance_frame("failed", message, **extra)
        self.emit(self.last_balance)
        self.emit(self.snapshot())

    def _do_balance_calibrate(self, turns: int, direction: Optional[str] = None) -> None:
        """
        Measure the two chains against each other and set the Motor balance.

        `direction` is the carousel travel to run in ("up"/"down"); omitted =
        the homing direction, so the calibration turns the same way homing
        does. With per-direction balance on, only that direction's trim is
        measured and replaced; otherwise the single shared trim is.

        Start condition: motor A's chain parked with the shelf flag in the shelf
        sensor and motor B's chain with the home flag in the home sensor (or the
        other way round if the shelf sensor is on motor B). Both bridges then run
        `turns` full carousel turns at Motor speed. Each sensor is timed to the
        rising edge that completes ITS chain's last turn: `turns × shelves` shelf
        flags for the shelf sensor, `turns` home flags for the home sensor. The
        chain that finishes first is held while the other catches up, so both
        end where they started. The ratio of the two times, with the trim they
        ran under, gives the trim that makes them equal.
        """
        hw = self.hw
        can = getattr(hw, "can_chain_sync", None)
        if can is None or not can() or not all(hasattr(hw, n) for n in ("hold_one", "index_active", "shelf_active")):
            self._balance_fail(
                "Motor balance calibration needs the Standard DC drive with both bridges on this agent."
            )
            return

        shelf_idx = 0 if self.chain_sync_shelf_side == "a" else 1
        home_idx = 1 - shelf_idx
        shelf_motor, home_motor = "AB"[shelf_idx], "AB"[home_idx]
        shelf_on = bool(hw.shelf_active())
        home_on = bool(hw.index_active())
        if not (shelf_on and home_on):
            missing = []
            if not shelf_on:
                missing.append(f"the shelf sensor (jog motor {shelf_motor} until shelf 1's flag lights it)")
            if not home_on:
                missing.append(f"the home sensor (jog motor {home_motor} until the home flag lights it)")
            self._balance_fail(
                "Not ready: both chains must start on their trigger point. Still dark: " + " and ".join(missing) + "."
            )
            return

        turns = max(1, min(BALANCE_CAL_MAX_TURNS, int(turns)))
        direction = direction if direction in ("up", "down") else home_travel_direction()
        per_dir = bool(getattr(hw, "dc_trim_per_dir", False))
        need = {shelf_idx: turns * self.shelves, home_idx: turns}
        counts = {0: 0, 1: 0}
        # Each sensor starts ON its flag, so the first thing it must see is the
        # flag leaving; only rising edges after that count.
        armed = {shelf_idx: False, home_idx: False}
        was_on = {shelf_idx: True, home_idx: True}
        finished_at = {0: None, 1: None}
        held: Optional[int] = None
        trim_for = getattr(hw, "trim_for_direction", None)
        prev_trim = float(trim_for(direction) if trim_for else getattr(hw, "dc_trim_pct", 0.0) or 0.0)
        duty = self.move_speed

        def sensor(idx: int) -> bool:
            return bool(hw.shelf_active()) if idx == shelf_idx else bool(hw.index_active())

        def progress(message: str) -> None:
            self.emit(self._balance_frame(
                "running", message, turns=turns, direction=direction,
                lapsA=counts[0] // (self.shelves if shelf_idx == 0 else 1),
                lapsB=counts[1] // (self.shelves if shelf_idx == 1 else 1),
                previousTrimPct=prev_trim,
            ))

        self.status = "calibrating"
        self.emit(self.snapshot())
        print(
            f"[agent] balance calibration: {turns} turn(s) {direction} at duty {duty:.2f}, "
            f"current trim {prev_trim:+.3f} % ({'per-direction' if per_dir else 'shared'}), "
            f"shelf sensor on motor {shelf_motor}",
            flush=True,
        )
        progress(f"Both motors running {turns} turn{'s' if turns != 1 else ''} {direction} at Motor speed…")

        # Soft start handled inline so no sensor edge is missed during the ramp.
        ramp = self._ramp_seconds()
        floor = min(MIN_DUTY, duty)
        t0 = time.monotonic()
        self._energise(direction, floor if ramp > 0 else duty)
        last_duty = floor if ramp > 0 else duty
        # Silence guards: a shelf flag must come at least once per shelf time,
        # a home flag once per lap. Scaled for the duty like the move's guard.
        # Both chains start ON their flag, so the home sensor's first edge is a
        # whole lap away. The homing time only has to cover the half lap homing
        # needs on average, so it is far too short here; a lap is bounded by
        # one shelf time per shelf, and the lap guard takes the longer of the two
        # with a half-lap margin on top.
        scale = MOVE_SPEED / max(0.01, duty)
        shelf_silence = self._shelf_timeout() * scale
        lap_bound = max(self._home_timeout() * scale, shelf_silence * self.shelves)
        silence = {
            shelf_idx: shelf_silence + ramp,
            home_idx: lap_bound * BALANCE_CAL_LAP_GUARD_MARGIN + ramp,
        }
        last_edge = {0: t0, 1: t0}
        catch_up_deadline: Optional[float] = None
        POLL = 0.001

        while True:
            if self._abort.is_set():
                hw.stop()
                self.status = "idle"
                self.last_balance = self._balance_frame(
                    "failed", "Balance calibration stopped.", turns=turns, direction=direction
                )
                self.emit(self.last_balance)
                self.emit(self.snapshot())
                return
            now = time.monotonic()
            if ramp > 0 and held is None and last_duty < duty:
                frac = min(1.0, (now - t0) / ramp)
                step_duty = floor + (duty - floor) * frac
                if step_duty - last_duty >= 0.005 or frac >= 1.0:
                    self._energise(direction, step_duty)
                    last_duty = step_duty

            for idx in (0, 1):
                if finished_at[idx] is not None:
                    continue
                on = sensor(idx)
                if not armed[idx]:
                    if not on:
                        armed[idx] = True
                        last_edge[idx] = now
                elif on and not was_on[idx]:
                    counts[idx] += 1
                    last_edge[idx] = now
                    per_lap = self.shelves if idx == shelf_idx else 1
                    if counts[idx] % per_lap == 0:
                        lap = counts[idx] // per_lap
                        if counts[idx] < need[idx]:
                            progress(f"Motor {'AB'[idx]}: lap {lap} of {turns}")
                    if counts[idx] >= need[idx]:
                        finished_at[idx] = now - t0
                        other = 1 - idx
                        if finished_at[other] is None:
                            hw.hold_one(idx)
                            held = idx
                            catch_up_deadline = now + max(
                                BALANCE_CAL_CATCH_UP_FLOOR_S, BALANCE_CAL_CATCH_UP_FRACTION * finished_at[idx]
                            )
                            progress(
                                f"Motor {'AB'[idx]} finished in {finished_at[idx]:.3f} s and is held; "
                                f"waiting for motor {'AB'[other]}…"
                            )
                was_on[idx] = on

            if finished_at[0] is not None and finished_at[1] is not None:
                break

            for idx in (0, 1):
                if finished_at[idx] is None and now - last_edge[idx] > silence[idx]:
                    name = "shelf" if idx == shelf_idx else "home"
                    self._balance_fail(
                        f"Safety stop: the {name} sensor did not trigger for {now - last_edge[idx]:.0f} s "
                        f"while motor {'AB'[idx]} was running. Check the sensor and that the chain is not stuck.",
                        turns=turns, direction=direction,
                    )
                    self.homed = False
                    return
            if catch_up_deadline is not None and now > catch_up_deadline:
                self._balance_fail(
                    f"Safety stop: motor {'AB'[1 - held]} needed more than "
                    f"{BALANCE_CAL_CATCH_UP_FRACTION * 100:.0f} % longer than motor {'AB'[held]} to finish. "
                    "That is more than the balance can correct; check both chains and sensors.",
                    turns=turns, direction=direction,
                )
                self.homed = False
                return
            time.sleep(POLL)

        hw.stop()
        # Both chains are back on their flags give or take the coast of the
        # second one; the shelf count during the held phase is not trustworthy,
        # so the position is dropped and the operator homes before the next move.
        self.homed = False
        t_a, t_b = finished_at[0], finished_at[1]
        scale_a = 1.0 + prev_trim / 100.0 if prev_trim < 0 else 1.0
        scale_b = 1.0 - prev_trim / 100.0 if prev_trim > 0 else 1.0
        # Speed per unit duty is inversely proportional to time taken at that duty.
        per_duty_a = 1.0 / (t_a * scale_a)
        per_duty_b = 1.0 / (t_b * scale_b)
        if per_duty_a > per_duty_b:
            ideal = -(1.0 - per_duty_b / per_duty_a) * 100.0
        else:
            ideal = (1.0 - per_duty_a / per_duty_b) * 100.0
        new_trim = max(-DC_TRIM_MAX_PCT, min(DC_TRIM_MAX_PCT, ideal))
        clamped = abs(ideal) > DC_TRIM_MAX_PCT
        new_trim = round(new_trim, 3)
        # Per-direction balance: an "up" run only touches the up trim. Shared
        # balance (or a "down" run) replaces dc_trim_pct, which serves both ways.
        store_up = per_dir and direction == "up"
        if store_up:
            self.set_servo(dc_trim_up_pct=new_trim)
        else:
            self.set_servo(dc_trim_pct=new_trim)
        if self.on_balance is not None:
            try:
                self.on_balance(new_trim, "up" if store_up else "down")
            except Exception as exc:  # pragma: no cover
                print(f"[agent] could not persist balance: {exc}", flush=True)
        self.status = "idle"
        slower = "A" if t_a > t_b else "B"
        diff_ms = abs(t_a - t_b) * 1000.0
        which = f"{direction} balance" if per_dir else "balance"
        if new_trim == 0:
            verdict = f"both chains ran equal: {which} left at 0."
        else:
            verdict = f"{which} set to {'A' if new_trim < 0 else 'B'} −{abs(new_trim):.3f} %."
        message = (
            f"Motor A {t_a:.3f} s, motor B {t_b:.3f} s over {turns} turn{'s' if turns != 1 else ''} {direction} "
            f"(motor {slower} slower by {diff_ms:.0f} ms): {verdict}"
            + (" The ideal value was beyond ±20 % and has been clamped; check the mechanics." if clamped else "")
            + " Home before the next move."
        )
        print(f"[agent] balance calibration: {message}", flush=True)
        self.last_balance = self._balance_frame(
            "done", message, turns=turns, direction=direction,
            aMs=round(t_a * 1000.0, 1), bMs=round(t_b * 1000.0, 1),
            previousTrimPct=prev_trim, trimPct=new_trim, clamped=clamped,
        )
        self.emit(self.last_balance)
        self.emit(self.snapshot())

    def _shelf_timeout(self) -> float:
        """Effective shelf-timeout base: the operator's value, else PULSE_TIMEOUT × drive scale."""
        if self.shelf_timeout_s is not None:
            return self.shelf_timeout_s
        return PULSE_TIMEOUT * self._timeout_scale()

    def set_hold_timeout(self, seconds) -> None:
        if seconds is None:
            return
        try:
            value = max(0, min(86_400, int(seconds)))
        except (TypeError, ValueError):
            return
        if value != self.hold_timeout_s:
            self.hold_timeout_s = value
            self._idle_since = time.monotonic()
            print(f"[agent] servo hold timeout = {value or 'never (hold always)'}", flush=True)

    def set_shelves(self, shelves: int) -> None:
        if shelves > 0:
            self.shelves = shelves

    @property
    def reverse_dir(self) -> bool:
        return bool(getattr(self.hw, "reverse", False))

    def set_reverse(self, value) -> bool:
        """Twin side: flip this carousel's one motor. Returns True if it changed."""
        if not isinstance(value, bool) or self.reverse_dir == value:
            return False
        if getattr(self, "status", "idle") != "idle":
            print("[agent] reverse change ignored while moving", flush=True)
            return False
        self.hw.reverse = value
        print(f"[agent] {self.side or 'carousel'} motor direction {'REVERSED' if value else 'normal'}", flush=True)
        return True

    def set_servo(
        self,
        pulses_per_rev=None,
        max_pps=None,
        mirror_b=None,
        ignore_alarm=None,
        dc_trim_pct=None,
        single_motor=None,
        dc_trim_up_pct=None,
        dc_trim_per_dir=None,
    ) -> None:
        """Forward drive tuning from the app's `config` to the live backend."""
        setter = getattr(self.hw, "set_servo_params", None)
        if setter is None:
            return
        setter(
            pulses_per_rev=pulses_per_rev,
            max_pps=max_pps,
            mirror_b=mirror_b,
            ignore_alarm=ignore_alarm,
            dc_trim_pct=dc_trim_pct,
            single_motor=single_motor,
            dc_trim_up_pct=dc_trim_up_pct,
            dc_trim_per_dir=dc_trim_per_dir,
        )
        if any(v is not None for v in (
            pulses_per_rev, max_pps, mirror_b, ignore_alarm, dc_trim_pct, single_motor, dc_trim_up_pct, dc_trim_per_dir
        )):
            print(
                f"[agent] drive set: ppr={getattr(self.hw, 'pulses_per_rev', '?')} "
                f"max_pps={getattr(self.hw, 'max_pps', '?')} mirror_b={getattr(self.hw, 'mirror_b', '?')} "
                f"ignore_alarm={getattr(self.hw, 'ignore_alarm', '?')} "
                f"dc_trim_pct={getattr(self.hw, 'dc_trim_pct', '?')} "
                f"dc_trim_up_pct={getattr(self.hw, 'dc_trim_up_pct', '?')} "
                f"per_dir={getattr(self.hw, 'dc_trim_per_dir', '?')}",
                flush=True,
            )

    def servo_snapshot(self) -> Optional[dict]:
        try:
            snap = self.hw.servo_snapshot()
        except Exception:
            return None
        if snap and snap.get("mode") == "servo":
            snap["holdTimeoutS"] = self.hold_timeout_s
        if snap:
            snap["homeTimeoutS"] = round(self._home_timeout(), 1)
            snap["shelfTimeoutS"] = round(self._shelf_timeout(), 1)
            snap["chainSyncLastLeadMs"] = (
                None if self._chain_sync_last_lead_ms is None else round(self._chain_sync_last_lead_ms)
            )
            snap["chainSyncLastCorrected"] = self._chain_sync_last_corrected
        return snap

    def set_motion(self, move_speed=None, homing_speed=None, ramp_pct=None,
                   approach_speed=None) -> None:
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
        if approach_speed is not None:
            # Same low floor as the move/homing sliders: the operator, not a
            # hardcoded stall guess, decides how slow the final crawl runs.
            self.approach_speed = max(SLIDER_MIN_DUTY, min(1.0, float(approach_speed)))
        print(
            f"[agent] motion set: move={self.move_speed:.2f} "
            f"home={self.homing_speed:.2f} ramp={self.ramp_pct}% "
            f"approach={self.approach_speed:.2f}",
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
        return {
            "type": "state",
            "status": self.status,
            "shelf": self.current_shelf,
            "homed": self.homed,
            "positionMode": self.position_mode,
            "calibrated": self.carousel_pulses is not None,
        }

    def sensor_snapshot(self) -> Optional[dict]:
        """
        Current shelf-sensor level as a `sensor` event, or None if it cannot be
        read. Sent to each browser as it connects so a freshly opened tab shows
        the true lamp state immediately, without waiting for the next change.
        """
        if not self.shelf_sensor_fitted:
            return None
        try:
            return {"type": "sensor", "on": bool(self.hw.shelf_active())}
        except Exception:
            return None

    def _watch_sensor(self) -> None:
        """
        Poll the shelf proximity sensor and emit a `sensor` event on every change
        so the app's carousel lamp mirrors the real GPIO input in real time.

        This is deliberately edge-agnostic and lock-free: it reads the same
        debounced logical level the motion code uses and reports transitions.
        Position/counting are unaffected — they remain driven by the hardware
        edge callbacks elsewhere in this file.
        """
        servo_last: Optional[tuple] = None
        while self._alive:
            # Home-sensor-only builds have nothing on the shelf input; a floating
            # pin must neither light the lamp nor un-home a released carousel.
            try:
                val: Optional[bool] = self._shelf_lamp()
            except Exception:
                val = None
            released = self.can_release() and not getattr(self.hw, "held", True)
            if val is not None and val != self._sensor_last:
                self._sensor_last = val
                try:
                    self.emit({"type": "sensor", "on": val})
                except Exception:
                    # A transport hiccup must not kill the watcher; the next
                    # change (or a reconnecting browser's snapshot) recovers it.
                    pass
                # The flag moved while the servos were free: somebody turned
                # the carousel by hand, so the remembered shelf is no longer
                # trustworthy. Force a re-home before the next automatic move.
                if released and self.homed and self.status == "idle":
                    self.homed = False
                    try:
                        self.emit(self.snapshot())
                    except Exception:
                        pass
            # Idle auto-release of the servos (hold_timeout_s == 0 → never).
            if self.status == "idle":
                now = time.monotonic()
                if self._idle_since is None:
                    self._idle_since = now
                elif (
                    self.hold_timeout_s > 0
                    and self.can_release()
                    and getattr(self.hw, "held", False)
                    and now - self._idle_since >= self.hold_timeout_s
                ):
                    self.request_release()
            else:
                self._idle_since = None
            # Servo drives report faults on their ALM line; mirror that to the
            # app the same way, and halt the pulse train so a tripped drive is
            # not asked to keep following a command it has already dropped.
            snap = self.servo_snapshot()
            key = (snap.get("alarmA"), snap.get("alarmB")) if snap else None
            if key != servo_last:
                servo_last = key
                if snap:
                    try:
                        self.emit(snap)
                        if snap.get("alarmA") or snap.get("alarmB"):
                            which = " and ".join(
                                n for n, on in (("motor A", snap.get("alarmA")), ("motor B", snap.get("alarmB"))) if on
                            )
                            self.request_stop()
                            self.status = "idle"
                            self.emit(self.snapshot())
                            self.emit({
                                "type": "fault",
                                "message": f"Servo alarm on {which}: the drive tripped (over-current, over-voltage "
                                           f"or position-following error). Check for a jammed carousel, then power-cycle the servo.",
                            })
                    except Exception:
                        pass
            time.sleep(SENSOR_POLL_SECONDS)

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
                elif cmd[0] == "calibrate":
                    self._do_calibrate()
                elif cmd[0] == "balance_calibrate":
                    self._do_balance_calibrate(cmd[1], cmd[2] if len(cmd) > 2 else None)
                elif cmd[0] == "jog":
                    self._do_jog(cmd[1], cmd[2], cmd[3], cmd[4] if len(cmd) > 4 else None)
            except Exception as exc:  # pragma: no cover - hardware faults
                self.hw.stop()
                self.status = "idle"
                self.emit({"type": "fault", "message": str(exc)})

    def _do_jog(self, motor: str, direction: str, amount: int, speed: Optional[float] = None) -> None:
        """
        Alignment nudge. Deliberately does NOT touch `current_shelf` or `homed`:
        a jog is a fraction of a shelf pitch used to level the two chains, and
        the shelf sensor's edge counting still runs underneath, so if the
        operator jogs clear across a flag the next move accounts for it the
        same way a coasting stop does.
        """
        mode = getattr(self.hw, "motor_mode", "dc")
        self.status = "moving"
        self.emit(self.snapshot())
        frame = {"type": "servo", "mode": mode, "jogging": True, "motor": motor, "direction": direction}
        frame["pulses" if mode == "servo" else "ms"] = amount
        self.emit(frame)
        try:
            self.hw.travel_direction = direction
            self.hw.jog(motor, direction, amount, speed)
        finally:
            self.hw.stop()
            self.status = "idle"
            self.emit(self.snapshot())
            snap = self.servo_snapshot()
            if snap:
                self.emit(snap)

    def _timeout_scale(self) -> float:
        """Stuck-detection allowance for the drive in use: servo gets 2x, DC 1x."""
        return SERVO_TIMEOUT_SCALE if getattr(self.hw, "motor_mode", "dc") == "servo" else 1.0

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

    def _await_stepping(self, wait_fn, timeout: float, on_tick) -> bool:
        """
        Like `_await`, but runs `on_tick` between slices so the caller can keep a
        soft start moving WHILE the sensor is being watched.

        Homing used to call the blocking `_drive` and only afterwards start
        looking for the index flag. The interrupt still captured the edge, so the
        pulse was never lost — but the motor went on accelerating for the whole
        remainder of the ramp before anyone read it, and at a long ramp that is
        over a shelf of extra travel past the flag. Since homing defines where
        "zero" is, that overshoot is inherited by every later position.
        """
        deadline = time.monotonic() + timeout
        while True:
            if self._abort.is_set():
                return False
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            on_tick()
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
        #
        # The ramp is stepped from the sensor-watching loops below rather than by
        # the blocking `_drive`, so the motor is never accelerating with nobody
        # reading the index sensor. See `_await_stepping`.
        home_direction = home_travel_direction()
        home_target = self.homing_speed
        home_ramp = self._ramp_seconds()
        # Never start ABOVE the requested duty: at a homing setting below
        # MIN_DUTY, a hardcoded floor would drive faster than asked for.
        home_floor = min(MIN_DUTY, home_target)
        self._energise(home_direction, home_floor if home_ramp > 0 else home_target)
        home_t0 = time.monotonic()

        def _home_ramp_step() -> None:
            if home_ramp <= 0:
                return
            frac = min(1.0, (time.monotonic() - home_t0) / home_ramp)
            self._energise(home_direction, home_floor + (home_target - home_floor) * frac)

        # Classic "already sitting on the switch" problem: if the carousel is
        # parked with a shelf inside the index window, the flag is active before
        # we even start. The old code asked "is index active?" and got an
        # instant yes, so homing declared success after a few microseconds of
        # motor time and the carousel never moved. Drive off the flag first —
        # the motor stays powered the whole time — and only then look for the
        # genuine inactive->active edge that actually means "home".
        if self.hw.index_active():
            self._await_stepping(self.hw.index_clear, INDEX_CLEAR_TIMEOUT, _home_ramp_step)
            self.hw.reset_pulses()  # ignore the edge produced by leaving the flag

        arm_s = self.sensor_arm_s

        def _take_index_after_arm(*args, **kwargs):
            # Safe move time: an index edge inside the window is consumed and
            # ignored, so homing can only end on a flag reached after it.
            got = self.hw.take_index_pulse(*args, **kwargs)
            return bool(got) and (arm_s <= 0 or time.monotonic() - home_t0 >= arm_s)

        found = self._await_stepping(
            _take_index_after_arm, self._home_timeout() + arm_s, _home_ramp_step
        )
        # Read the odometer BEFORE stopping: this is the datum every pulse-mode
        # position is measured from, and the index edge was taken in
        # `home_direction` — the same edge calibration measured.
        edge_pos = self._odometer()
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
        if edge_pos is not None:
            self._home_origin = edge_pos
            self._home_edge_direction = home_direction
        self.emit({"type": "homed", "shelf": 0})

    def _track_coast(self, step: int, seen_inactive: bool) -> None:
        """Motor already off: watch the shelf sensor until the carousel has
        demonstrably come to rest, counting any flag that still enters the
        window so `current_shelf` ends on the shelf the metal actually stopped
        at. Same EMPTY->OCCUPIED rule as the move loop, so a flag that was
        already in the window when the stop landed is never double-counted.

        Ends after REST_STABLE of a steady sensor level (parked), or COAST_MAX
        at the latest so a flickering sensor can't hold the stop open."""
        start = time.monotonic()
        last_change = start
        prev_active = self.hw.shelf_active()
        while True:
            now = time.monotonic()
            if now - start > COAST_MAX or now - last_change > REST_STABLE:
                return
            pulsed = self.hw.take_shelf_pulse(0.0)
            active = self.hw.shelf_active()
            if active != prev_active:
                last_change = now
                prev_active = active
            if pulsed and seen_inactive:
                triggered = True
                seen_inactive = False
            elif not active:
                seen_inactive = True
                triggered = False
            elif seen_inactive:
                triggered = True
                seen_inactive = False
            else:
                triggered = False
            if triggered:
                self.current_shelf = (self.current_shelf + step) % self.shelves
                self.emit({"type": "pos", "shelf": self.current_shelf})
            # Same 1 ms cadence as the move loop, so a fast flag can't slip
            # between two samples while the carousel is still at speed.
            time.sleep(0.001)

    # ======================================================================
    # Pulse positioning (servo drive)
    # ======================================================================
    def _calibration_failed(self, message: str) -> None:
        self.hw.stop()
        self.status = "idle"
        self.emit(self.snapshot())
        aborted = self._abort.is_set()
        if not aborted:
            self.emit({"type": "fault", "message": message})
        self.emit({"type": "calibration", "ok": False,
                   "message": "Calibration stopped." if aborted else message})

    def _do_calibrate(self) -> None:
        """
        Measure the carousel in pulses, in ONE continuous run at homing speed:

          1. find the index rising edge — that is home, zero the odometer there
             (the carousel does not stop; stopping and restarting would add the
             start-up slack to the measurement);
          2. keep going: note where the index flag LEAVES the window (its width
             in pulses, needed to re-sync when passing home the other way) and
             every shelf-flag edge seen on the way round;
          3. the next index rising edge closes the revolution: pulses per
             revolution. Stop there — we are at home, so the run ends homed.

        Both index edges are taken at the same speed in the same direction, so
        sensor latency cancels out of the difference.
        """
        if self._odometer() is None:
            self.emit({"type": "calibration", "ok": False,
                       "message": "Calibration needs the servo drive: the DC bridges have no pulse counter."})
            return
        self.status = "calibrating"
        self.emit(self.snapshot())
        self.hw.reset_pulses()

        direction = "up" if HOMING_DIRECTION == "down" else "down"
        sign = 1 if direction == "down" else -1
        target = self.homing_speed
        ramp = self._ramp_seconds()
        floor = min(MIN_DUTY, target)
        self._energise(direction, floor if ramp > 0 else target)
        t0 = time.monotonic()

        def ramp_step() -> None:
            if ramp <= 0:
                return
            frac = min(1.0, (time.monotonic() - t0) / ramp)
            self._energise(direction, floor + (target - floor) * frac)

        home_timeout = self._home_timeout()
        if self.hw.index_active():
            self._await_stepping(self.hw.index_clear, INDEX_CLEAR_TIMEOUT, ramp_step)
            self.hw.reset_pulses()
        if not self._await_stepping(self.hw.take_index_pulse, home_timeout, ramp_step):
            self._calibration_failed("Calibration: index sensor not found on the first pass.")
            return

        origin = self._odometer()
        self._home_origin = origin
        self._home_edge_direction = direction
        self.current_shelf = 0
        self.homed = True
        self.emit({"type": "homed", "shelf": 0})
        self.hw.reset_pulses()

        shelf_edges: list[float] = []
        index_window: Optional[float] = None
        index_was_active = True
        seen_inactive = not self.hw.shelf_active()
        deadline = time.monotonic() + home_timeout * CALIBRATE_TIMEOUT_SCALE
        rev_raw: Optional[float] = None

        while True:
            if self._abort.is_set():
                self._calibration_failed("Calibration stopped.")
                return
            if time.monotonic() > deadline:
                self._calibration_failed(
                    "Calibration timed out: the index sensor was not seen again after a full revolution.")
                return
            ramp_step()
            pos = self._odometer()
            travelled = (pos - origin) * sign

            idx_active = self.hw.index_active()
            if index_was_active and not idx_active and index_window is None:
                index_window = travelled
            index_was_active = idx_active

            pulsed = self.hw.take_shelf_pulse(0.0)
            active = self.hw.shelf_active()
            if seen_inactive and (pulsed or active):
                seen_inactive = False
                shelf_edges.append(travelled)
            elif not active:
                seen_inactive = True

            if self.hw.take_index_pulse(0.0):
                # Only a rising edge that follows the window being cleared, and
                # is far beyond the window's own width, closes the revolution;
                # anything else is the home flag bouncing at the sensor.
                if index_window is not None and travelled > max(100.0, 20.0 * index_window):
                    rev_raw = travelled
                    break
            time.sleep(0.001)

        self.hw.stop()
        rev = int(round(abs(rev_raw)))
        if rev <= 0:
            self._calibration_failed("Calibration measured zero travel; is the servo drive pulsing?")
            return
        window = int(round(abs(index_window))) if index_window else None
        pitch = rev / max(1, self.shelves)

        # Merge shelf edges that sit within a quarter pitch of each other (the
        # same flag seen twice by a bouncing chain), wrapping round the loop.
        merged: list[float] = []
        for e in sorted(x % rev for x in shelf_edges):
            if merged and (e - merged[-1]) < 0.25 * pitch:
                continue
            merged.append(e)
        if len(merged) > 1 and (merged[0] + rev - merged[-1]) < 0.25 * pitch:
            merged.pop()
        flags_seen: Optional[int] = len(merged) if self.shelf_sensor_fitted else None

        message = (f"Calibrated: {rev} pulses per revolution, {round(pitch)} per shelf "
                   f"({self.shelves} shelves).")
        if flags_seen is None:
            message += " Home sensor only: shelves are spaced evenly from home."
        else:
            message += f" Saw {flags_seen} shelf flag{'s' if flags_seen != 1 else ''}."
        if flags_seen is not None and flags_seen != self.shelves:
            message += (f" Expected {self.shelves}: check the shelf count in the app, "
                        f"or a shelf flag the sensor misses / sees twice.")

        self.carousel_pulses = rev
        self.index_window_pulses = window
        # Home again: the datum is the edge just taken, not the stop a
        # millisecond later.
        self._home_origin = origin + sign * rev_raw
        self.current_shelf = 0
        self.homed = True
        self.status = "idle"
        self.calibration_info = {
            "type": "calibration",
            "ok": True,
            "pulsesPerRev": rev,
            "indexWindowPulses": window,
            "shelfFlagsSeen": flags_seen,
            "shelves": self.shelves,
            "message": message,
        }
        print(f"[agent] {message} index window {window} pulses", flush=True)
        if self.on_calibration is not None:
            try:
                self.on_calibration(self.calibration_info)
            except Exception as exc:
                print(f"[agent] could not persist calibration: {exc}", flush=True)
        self.emit(self.calibration_frame())
        self.emit({"type": "homed", "shelf": 0})
        self.emit(self.snapshot())

    def _do_goto_pulses(self, target: int) -> None:
        """
        Drive a calibrated DISTANCE to the target instead of counting shelf
        flags. Position comes from the pulse odometer referenced to the home
        datum; the shelf sensor plays no part in the stop.

        The index flag is still watched. Every time it passes the sensor the
        odometer is corrected to the datum ON THE FLY ��� the move keeps going and
        simply re-aims at the target on the corrected grid — so an odometer that
        is off by a fraction of a percent, or a calibration that is a few pulses
        short, can never accumulate into a shelf of error. The correction is
        reported as a `sync` event so the drift can be watched from the app.
        """
        rev = float(self.carousel_pulses)
        pitch = rev / self.shelves
        up_steps = (self.current_shelf - target) % self.shelves
        down_steps = (target - self.current_shelf) % self.shelves
        if up_steps <= down_steps:
            direction, steps = "up", up_steps
        else:
            direction, steps = "down", down_steps
        step = -1 if direction == "up" else 1
        sign = 1 if direction == "down" else -1  # odometer counts up on forward() = "down"
        start_shelf = self.current_shelf

        self.status = "moving"
        self.emit(self.snapshot())
        self.hw.reset_pulses()
        start = self._odometer()
        absolute = self.homed and self._home_origin is not None

        def grid_remaining(pos: float) -> float:
            """Pulses still to go to the target on the home-referenced grid."""
            pos_abs = pos - self._home_origin
            left = ((target * pitch - pos_abs) * sign) % rev
            # Parked a hair PAST the target (drift, or a previous stop that ran
            # a few pulses long) must not send the carousel the long way round.
            return left - rev if left > rev - 0.25 * pitch else left

        if absolute:
            distance = grid_remaining(start)
        else:
            # Unhomed: a relative move of whole pitches; no datum to re-sync to.
            distance = steps * pitch

        if distance <= 0:
            self.status = "idle"
            self.current_shelf = target
            self.emit({"type": "arrived", "shelf": target,
                       "onSensor": self._shelf_lamp(), "positionMode": self.position_mode})
            return

        cruise = self.move_speed
        approach = min(self.approach_speed, cruise)
        decel_pulses = min(PULSE_DECEL_PITCH_FRACTION * pitch, distance / 2)
        ramp_seconds = self._ramp_seconds()
        floor = min(MIN_DUTY, cruise)
        duty = cruise if ramp_seconds <= 0 else floor
        budget = (3.0 * distance / self._pulse_rate(cruise)
                  + decel_pulses / self._pulse_rate(approach)
                  + ramp_seconds + 3.0)

        self._energise(direction, duty)
        t0 = time.monotonic()
        last_duty_update = t0
        last_index_pos: Optional[float] = None
        shown_shelf = self.current_shelf
        POLL = 0.001

        while True:
            now = time.monotonic()
            pos = self._odometer()
            travelled = (pos - start) * sign

            if self._abort.is_set():
                self.hw.stop()
                if absolute:
                    self.current_shelf = int(round((pos - self._home_origin) / pitch)) % self.shelves
                else:
                    self.current_shelf = (start_shelf + int(round(travelled / pitch)) * step) % self.shelves
                self.status = "idle"
                self.emit(self.snapshot())
                return

            # Stop within one poll's worth of pulses of the target.
            if distance - travelled <= self._pulse_rate(duty) * 1.5 * POLL:
                self.hw.stop()
                break

            # HOME PASS: re-synchronise without stopping.
            if self.hw.take_index_pulse(0.0):
                if last_index_pos is None or abs(pos - last_index_pos) > START_REENTRY_PITCH_FRACTION * pitch:
                    last_index_pos = pos
                    if absolute:
                        # Calibration measured the rising edge travelling in the
                        # homing direction; coming the other way the edge is the
                        # far side of the window, one window-width along.
                        if direction == self._home_edge_direction or not self.index_window_pulses:
                            expected = 0.0
                        else:
                            home_sign = 1 if self._home_edge_direction == "down" else -1
                            expected = home_sign * float(self.index_window_pulses)
                        measured = (pos - self._home_origin) % rev
                        drift = (measured - expected) % rev
                        if drift > rev / 2:
                            drift -= rev
                        self._home_origin += drift
                        distance = travelled + grid_remaining(pos)
                        self.last_sync_drift = int(round(drift))
                        print(f"[agent] home pass: odometer drift {drift:+.0f} pulses, corrected", flush=True)
                        self.emit({"type": "sync", "driftPulses": self.last_sync_drift,
                                   "pulsesPerShelf": round(pitch)})
                        if abs(drift) > 0.5 * pitch:
                            self.emit({"type": "fault",
                                       "message": f"Position drifted {drift:+.0f} pulses (more than half a shelf) "
                                                  f"since the last home pass — corrected, but check for chain slip "
                                                  f"or re-run calibration."})

            # DUTY PROFILE: soft start by time, then a straight-line slowdown over
            # the last fraction of a pitch, ending at the arrival duty. A servo
            # holds where the pulses stop, so there is no coast to allow for.
            if now - last_duty_update >= PULSE_DUTY_UPDATE_S:
                if ramp_seconds > 0:
                    frac = min(1.0, (now - t0) / ramp_seconds)
                    up = floor + (cruise - floor) * frac
                else:
                    up = cruise
                left = distance - travelled
                if decel_pulses > 0 and left < decel_pulses:
                    down = approach + (cruise - approach) * max(0.0, left / decel_pulses)
                else:
                    down = cruise
                want = max(SLIDER_MIN_DUTY, min(up, down))
                if abs(want - duty) >= 0.005:
                    duty = want
                    self._energise(direction, duty)
                last_duty_update = now

            if absolute:
                cur = int(round((pos - self._home_origin) / pitch)) % self.shelves
            else:
                cur = (start_shelf + int(round(travelled / pitch)) * step) % self.shelves
            if cur != shown_shelf:
                shown_shelf = cur
                self.current_shelf = cur
                self.emit({"type": "pos", "shelf": cur})

            if now - t0 > budget:
                self.hw.stop()
                self.status = "idle"
                self.emit({"type": "fault",
                           "message": "Pulse move overran its time budget: the servos are not following the "
                                      "pulse train (alarm, released, or stalled)."})
                self.emit(self.snapshot())
                return
            time.sleep(POLL)

        self.status = "idle"
        self.current_shelf = target
        self.emit({"type": "arrived", "shelf": target,
                   "onSensor": self._shelf_lamp(),
                   "positionMode": self.position_mode})

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

        if self.position_mode in ("pulses", "index"):
            blocker = self._pulse_mode_blocker()
            if blocker is None:
                self._do_goto_pulses(target)
                return
            if self.position_mode == "index":
                # No shelf sensor is wired, so there is nothing to fall back to:
                # counting edges on a dead input would just run to the timeout.
                self.emit({"type": "fault",
                           "message": f"Cannot move to a shelf: {blocker}. Only the home sensor is fitted, "
                                      f"so the carousel positions by pulses alone. Jog and Home still work."})
                self.emit(self.snapshot())
                return
            # Falling back to the shelf sensor is a safe, fully positioned move,
            # not a lost position. A `fault` here made the app show "Carousel
            # stopped - position lost" and abandon the goto that then completed.
            print(f"[agent] pulse positioning unavailable ({blocker}); using the shelf sensor for this move",
                  flush=True)

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

        # THE ALREADY-ACTIVE SENSOR AT THE START OF A MOVE.
        #
        # The carousel is parked ON a shelf, so the sensor is active before the
        # motor even turns — and it must be. If the counting loop treats that
        # standing signal as a shelf it has passed, a move of N shelves finishes
        # after only N-1 shelves of travel: ask for 2 and it moves 1, ask for 3
        # and it moves 2. That is the reported fault exactly.
        #
        # The correction belongs in the counting loop, which discards the standing
        # signal (`seen_inactive = not parked_on_flag`), NOT in `steps`. Adding a
        # shelf here as well double-corrects and overshoots by one — measured:
        # 2->5 travelled 4 shelves.

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
        # The operator-tunable arrival duty (the "slow speed" slider). It defaults
        # to MIN_DUTY — the slowest duty that still reliably TURNS the motor, as
        # gentle as the hardware allows — but can be raised for a quicker approach
        # or lowered for a heavy carousel that coasts.
        #
        # It is deliberately NOT derived from `speed`: writing it as
        # `min(MIN_DUTY, speed)` produced a sub-stall approach at low slider
        # settings (speed 0.01 -> 0.01) and the carousel simply stopped short of
        # the target. `self.approach_speed` is clamped in `set_motion` instead.
        approach = self.approach_speed

        # A ONE-SHELF HOP IS ENTIRELY A FINAL APPROACH, so it runs at the arrival
        # duty from the start — there is no intermediate shelf at which to slow
        # down, because the very first trigger is the target.
        #
        # This was written as `max(approach, min(speed, 1.0))` to keep the speed
        # slider effective on short moves. That inverted the priority: it forced
        # cruise up to the full requested duty, which made `approach == speed`, so
        # the changeover in the loop found nothing to change and the single most
        # common move on the machine �� step to the next shelf — took its target
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

        # NO TIMING LOCKOUT ARMED AT THE START, deliberately.
        #
        # The parked flag used to be dealt with here, by arming the hardware bounce
        # lockout so its re-entry looked like a post-count bounce. That was a
        # timing guess layered on top of the real problem, and it could suppress a
        # GENUINE first shelf whenever that shelf arrived inside the lockout.
        #
        # It is no longer needed. The counting loop now requires the sensor window
        # to have been seen EMPTY before it will count anything, so the flag the
        # carousel is parked on is rejected on physical evidence rather than on a
        # clock — whether it is reported by the poll or by the interrupt.

        # Non-blocking ramp state, stepped inside the loop.
        ramp_floor = min(MIN_DUTY, cruise)
        ramp_seconds = 0.0 if steps <= 1 else self._ramp_seconds()
        ramp_started = time.monotonic()

        # SAFE MOVE TIME must be shorter than one shelf pitch, or the flags that
        # pass while the sensor is blind are simply never counted and the move
        # overshoots by that many shelves (a 10 s window left over from a
        # geared servo setup made a DC carousel go 3 shelves for a 1-shelf goto).
        # Once a pitch time has been learned, cap the window at half of it.
        arm_s = max(0.0, self.sensor_arm_s)
        if self._learned_pitch_s and arm_s > 0.5 * self._learned_pitch_s:
            capped = round(0.5 * self._learned_pitch_s, 1)
            print(f"[agent] safe move time {arm_s:.1f}s exceeds half a shelf pitch "
                  f"({self._learned_pitch_s:.1f}s); using {capped:.1f}s for this move", flush=True)
            arm_s = capped

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

        # SMOOTH DECELERATION STATE for the final approach leg. `decel_started` is
        # None until the penultimate shelf is counted; from then the loop eases the
        # duty down from `decel_from` (the cruise it was travelling at) to
        # `approach` over `decel_seconds`, instead of dropping to it in one step.
        decel_started = None
        decel_from = cruise
        decel_seconds = 0.0
        # From the state sampled at step 0, not re-read here: by now the flag may
        # already have moved back into the window.
        seen_inactive = not parked_on_flag

        # CHAIN SYNC at shelf 1. `home_leg` is True while the shelf about to be
        # counted is shelf 0 (the one carrying the home flag). That leg is driven
        # at Approach speed and the two sensors are timed against each other:
        # whichever fires first starts a lead clock; past the tolerance its
        # bridge is held until the other sensor fires. `sync_paused` is the held
        # bridge index while a correction is in progress.
        sync_hw = self._chain_sync_hw()
        shelf_idx = 0 if self.chain_sync_shelf_side == "a" else 1
        home_idx = 1 - shelf_idx
        home_leg = sync_hw is not None and (self.current_shelf + step) % self.shelves == 0
        sync_shelf_t: Optional[float] = None
        sync_home_t: Optional[float] = None
        sync_paused: Optional[int] = None
        sync_pause_started = 0.0
        sync_recorded = False
        # The watch outlives the count: once the shelf sensor has fired, shelf 1
        # is counted and the leg moves on, but the home sensor may still be a
        # few hundred ms away. `sync_active` keeps the watch (and the Approach
        # speed) going until both sensors have fired or the wait is given up.
        sync_active = home_leg
        sync_blind_until = ramp_started + arm_s
        home_was_active = bool(sync_hw.index_active()) if sync_hw is not None else False
        leg_target = approach if home_leg else cruise
        if home_leg and speed > approach:
            self._energise(direction, approach)
            speed = approach

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
        silence_limit = (
            self._shelf_timeout() * (MOVE_SPEED / max(0.01, cruise)) + self._ramp_seconds()
        )
        # SAFE MOVE TIME blinds the sensor for its whole duration: every edge is
        # discarded below and `last_activity` is never refreshed. Homing already
        # adds the arm time to its timeout; the move did not, so with a Safe move
        # time longer than this limit (10 s vs ~4 s at full duty) the guard
        # tripped "Jam? No shelf pulse" a few seconds into every goto while the
        # sensors were still, by design, switched off. The silence clock only
        # has meaning once the sensor is allowed to speak, so start it then.
        silence_limit += arm_s
        last_trigger = time.monotonic()
        # The runaway guard is reset by ANY sensor activity, including edges the
        # distance filter rejects — a bouncing sensor is a live sensor.
        last_activity = last_trigger
        # Distance filter state: odometer at the move start / last counted edge
        # (servo), and the pitch interval last measured in this move (DC).
        last_odo = self._odometer()
        last_pitch_time: Optional[float] = None
        rejected_edges = 0

        while True:
            if self._abort.is_set():
                self.hw.stop()
                # Keep COUNTING while the carousel coasts to rest. Returning the
                # instant the stop landed lost every flag that still slid past the
                # sensor during coast-down, so after an emergency stop
                # `current_shelf` was quietly one shelf behind the metal. Every
                # later `goto` then counted from the wrong start and parked one
                # shelf off — and the app, told "arrived at N", filed each spool
                # of the remaining queue into the slot of shelf N while the
                # operator was physically loading shelf N+1. The queue itself was
                # fine; the machine had lost its place.
                self._track_coast(step, seen_inactive)
                self.status = "idle"
                self.emit(self.snapshot())
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
            if ramp_seconds > 0 and speed < leg_target and not on_final_approach and not home_leg:
                frac = (time.monotonic() - ramp_started) / ramp_seconds
                target_duty = leg_target if frac >= 1.0 else ramp_floor + (leg_target - ramp_floor) * frac
                if target_duty > speed:
                    self._energise(direction, target_duty)
                    speed = target_duty

            # SMOOTH STOP, the mirror of the soft start above and the answer to
            # "it brakes too aggressively near the target". Once the penultimate
            # shelf is counted (`decel_started` set below) this eases the duty from
            # the cruise it was running at down to the gentle arrival duty over the
            # space of the final leg, instead of the old single-step drop that made
            # the carousel lurch.
            #
            # It is a pure ramp DOWN — `target_duty < speed` — so it never fights
            # the soft start, and it is time-based over `decel_seconds`, which was
            # sized from the measured pitch so the arrival duty is reached before
            # the target flag triggers. The stop itself is still instant on that
            # trigger; only the run-up to it is softened, which is why this adds no
            # overshoot.
            if (on_final_approach or home_leg) and decel_started is not None and speed > approach:
                if decel_seconds <= 0:
                    target_duty = approach
                else:
                    frac = (time.monotonic() - decel_started) / decel_seconds
                    target_duty = approach if frac >= 1.0 else (
                        decel_from - (decel_from - approach) * frac)
                if target_duty < speed:
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
            # SAFE MOVE TIME (operator setting, 0 = off). For this long after the
            # motor starts the shelf sensor cannot count or stop anything: edges
            # are discarded and the window is treated as occupied, so a flag in
            # front of the sensor when the time runs out must still leave and the
            # NEXT one enter before it counts.
            if arm_s > 0 and time.monotonic() - ramp_started < arm_s:
                pulsed = False
                active = True
                seen_inactive = False

            # ONE RULE FOR BOTH OBSERVERS: a shelf is an EMPTY->OCCUPIED
            # transition of the sensor window, and the window must have been seen
            # empty since the last count before anything can be counted again.
            #
            # `seen_inactive` is that memory, and it starts FALSE when the move
            # begins parked on a flag — which is the normal case, because a parked
            # carousel always has a flag in front of the sensor. So the standing
            # signal the move starts with can never be counted: the flag has to
            # leave the window (clearing the gap) and the NEXT flag has to enter it.
            #
            # THE INTERRUPT IS GATED THE SAME WAY, and that is the fix. A queued
            # pulse used to be trusted unconditionally, bypassing this memory
            # entirely, so any rising edge counted regardless of whether the window
            # had ever been empty — the parked flag's own re-entry included. That
            # is how a move of N shelves reached its count after N-1 shelves of
            # real travel.
            #
            # Gating it costs nothing that the interrupt was there for. Its purpose
            # is a flag whose whole crossing falls between two 1 ms polls; in that
            # case the window HAS been empty beforehand, `seen_inactive` is true,
            # and the pulse still counts. Only edges with no preceding gap are
            # rejected, and those are never new shelves.
            if pulsed and seen_inactive:
                # A CAPTURED rising edge that followed a real gap. Checked first
                # and without confirming the level, because the flag may already
                # have crossed completely between two polls — that is the one case
                # the interrupt exists for, and the live level cannot see it.
                triggered = True
                seen_inactive = False
            elif not active:
                # Window empty: the gap between flags. This is the only thing that
                # re-arms counting.
                seen_inactive = True
                triggered = False
            elif seen_inactive:
                # Window occupied again after a real gap, seen by the poll.
                triggered = True
                seen_inactive = False
            else:
                # Still the same flag in the window — the one we are parked on at
                # the start of a move, or the one just counted. Any pulse queued in
                # this state had no preceding gap, so it is a re-entry, not a shelf.
                triggered = False

            if triggered:
                # DISTANCE FILTER. The EMPTY->OCCUPIED rule above proves the window
                # was empty in between, but a chain that bounces empties the
                # window and refills it with the SAME shelf, and a stop that landed
                # exactly on the flag's edge leaves that shelf a hair outside the
                # window ready to be dragged straight back in by the next move.
                # Both look like a perfectly formed new edge. What gives them away
                # is distance: a real shelf is a whole pitch away, a bounce or a
                # re-entry is a few millimetres. Servo: measured in pulses by the
                # odometer, so ramps and speed do not matter. DC: fraction of the
                # pitch time measured earlier in this same move.
                now_t = time.monotonic()
                odo_now = self._odometer()
                pitch_pulses = self._pitch_pulses()
                reject = None
                if odo_now is not None and pitch_pulses and last_odo is not None:
                    travelled = abs(odo_now - last_odo)
                    frac = START_REENTRY_PITCH_FRACTION if counted == 0 else BOUNCE_PITCH_FRACTION
                    if travelled < frac * pitch_pulses:
                        reject = f"{travelled:.0f} of {pitch_pulses:.0f} pulses since the last count"
                elif counted > 0 and last_pitch_time is not None:
                    since = now_t - last_trigger
                    if since < BOUNCE_TIME_FRACTION * last_pitch_time:
                        reject = f"{since:.2f}s after the last count (pitch {last_pitch_time:.2f}s)"
                if reject is not None:
                    triggered = False
                    # The flag is in the window now; it has to leave again before
                    # anything can count.
                    seen_inactive = False
                    last_activity = now_t
                    rejected_edges += 1
                    print(f"[agent] shelf edge ignored as bounce/re-entry: {reject}", flush=True)

            if triggered and ignore_parked_flag:
                # The flag we set off from, sliding back into the window. Not a
                # shelf gained. Reset the runaway guard, since the sensor is
                # plainly alive and reporting.
                ignore_parked_flag = False
                last_trigger = time.monotonic()
                last_activity = last_trigger
                time.sleep(POLL)
                continue

            if sync_active and sync_hw is not None and time.monotonic() >= sync_blind_until:
                now_s = time.monotonic()
                home_now = bool(sync_hw.index_active())
                if home_now and not home_was_active and sync_home_t is None:
                    sync_home_t = now_s
                home_was_active = home_now
                if triggered and sync_shelf_t is None:
                    sync_shelf_t = now_s

                if sync_paused is None:
                    lead_s, leader = None, None
                    if sync_shelf_t is not None and sync_home_t is None:
                        lead_s, leader = now_s - sync_shelf_t, shelf_idx
                    elif sync_home_t is not None and sync_shelf_t is None:
                        lead_s, leader = now_s - sync_home_t, home_idx
                    if lead_s is not None and lead_s * 1000.0 >= self.chain_sync_tolerance_ms:
                        sync_paused = leader
                        sync_pause_started = now_s
                        sync_hw.hold_one(leader)
                        self._chain_sync_last_corrected = True
                        print(
                            f"[agent] chain sync: {'shelf' if leader == shelf_idx else 'home'} sensor leads by "
                            f"{lead_s * 1000:.0f} ms, holding motor {'A' if leader == 0 else 'B'}",
                            flush=True,
                        )
                else:
                    other_fired = (sync_home_t is not None) if sync_paused == shelf_idx else (sync_shelf_t is not None)
                    waited = now_s - sync_pause_started
                    if other_fired:
                        sync_hw.release_one(sync_paused, direction != "up", speed)
                        sync_paused = None
                        last_activity = now_s
                    elif waited > self.chain_sync_max_wait_s:
                        # Safety stop. One chain has been driving alone and the
                        # lagging sensor never fired: either it is dead or that
                        # chain is stuck. Running on would wind the carousel out
                        # of level, so cut both bridges and report it.
                        self._chain_sync_safety_stop(
                            paused=sync_paused, shelf_idx=shelf_idx, waited_s=waited
                        )
                        return

                if not sync_recorded and sync_shelf_t is not None and sync_home_t is not None:
                    sync_recorded = True
                    sync_active = False
                    self._chain_sync_last_lead_ms = (sync_home_t - sync_shelf_t) * 1000.0
                    print(
                        f"[agent] chain sync: shelf 1 passed, lead {self._chain_sync_last_lead_ms:+.0f} ms "
                        f"({'corrected' if self._chain_sync_last_corrected else 'within tolerance'})",
                        flush=True,
                    )

                if not sync_active and not home_leg and not on_final_approach and speed < cruise:
                    # Shelf 1 was counted earlier while the sync was still
                    # pending; now that it is settled, ramp back up to cruise.
                    leg_target = cruise
                    decel_started = None
                    ramp_floor = speed
                    ramp_started = now_s
                    if ramp_seconds <= 0:
                        self._energise(direction, cruise)
                        speed = cruise

            if triggered:
                now = time.monotonic()
                # Time to cross the pitch just travelled — the interval since the
                # previous shelf (or the move start for the first count). Used to
                # size the deceleration so it fits inside the final leg.
                pitch_time = now - last_trigger
                odo_now = self._odometer()
                if counted > 0:
                    # Shelf-to-shelf: a real pitch, in time and (servo) in pulses.
                    last_pitch_time = pitch_time
                    if odo_now is not None and last_odo is not None and not self.carousel_pulses:
                        self._learned_pitch_pulses = abs(odo_now - last_odo)
                    # Only shelf-to-shelf intervals teach the pitch time; the
                    # first count is measured from standstill through the ramp
                    # and the blind window, so it says nothing about cruise.
                    # A slowed shelf-1 leg (or the re-acceleration after it) is
                    # not a cruise pitch; keep it out of the learned average.
                    if 0.2 < pitch_time < 120 and speed >= cruise:
                        prev = self._learned_pitch_s
                        self._learned_pitch_s = pitch_time if prev is None else 0.7 * prev + 0.3 * pitch_time
                last_odo = odo_now
                counted += 1
                last_trigger = now
                last_activity = now

                if counted >= steps:
                    if home_leg and sync_hw is not None and sync_home_t is None:
                        # Parking on shelf 1 with the shelf sensor first: the
                        # shelf side is where it should be, so hold it and let
                        # the home side catch up until its flag arrives.
                        sync_hw.hold_one(shelf_idx)
                        if sync_paused == home_idx:
                            sync_hw.release_one(home_idx, direction != "up", speed)
                        wait_started = time.monotonic()
                        while not self._abort.is_set():
                            home_now = bool(sync_hw.index_active())
                            if home_now and not home_was_active:
                                sync_home_t = time.monotonic()
                                break
                            home_was_active = home_now
                            waited = time.monotonic() - wait_started
                            if waited > self.chain_sync_max_wait_s:
                                # The home chain ran on alone and its flag never
                                # came. Do not report "arrived": the shelf side
                                # is parked but the other side is somewhere else.
                                self._chain_sync_safety_stop(
                                    paused=shelf_idx, shelf_idx=shelf_idx, waited_s=waited
                                )
                                return
                            time.sleep(POLL)
                        if sync_home_t is not None and sync_shelf_t is not None:
                            self._chain_sync_last_lead_ms = (sync_home_t - sync_shelf_t) * 1000.0
                            self._chain_sync_last_corrected = (
                                self._chain_sync_last_corrected
                                or self._chain_sync_last_lead_ms >= self.chain_sync_tolerance_ms
                            )
                    # THIS IS THE TARGET. Cut power immediately, before any
                    # bookkeeping, while the flag is still in the window.
                    self.hw.stop()
                    self.current_shelf = target
                    self.emit({"type": "pos", "shelf": self.current_shelf})
                    break

                if counted == steps - 1:
                    # THE NEXT TRIGGER IS THE TARGET. Begin easing down to the
                    # arrival duty across this final leg, instead of dropping to it
                    # in one step (the old aggressive brake).
                    on_final_approach = True

                    if approach < speed:
                        # Ramp down. Duration is the operator's ramp-gentleness
                        # (the same slider that shapes the soft start), but capped
                        # to a fraction of the pitch just measured so the arrival
                        # duty is always reached before the target flag arrives.
                        decel_from = speed
                        decel_started = now
                        decel_seconds = min(self._ramp_seconds(),
                                            DECEL_LEG_FRACTION * pitch_time)
                        if decel_seconds <= 0:
                            # No ramp requested (ramp_pct = 0): keep the original
                            # immediate drop so behaviour is unchanged at 0%.
                            self._energise(direction, approach)
                            speed = approach
                    elif approach != speed:
                        # A long soft start may still be BELOW the approach duty
                        # here; nudge it up in one step, there is nothing to ease.
                        self._energise(direction, approach)
                        speed = approach

                self.current_shelf = (self.current_shelf + step) % self.shelves
                self.emit({"type": "pos", "shelf": self.current_shelf})

                if sync_hw is not None:
                    if sync_paused is not None:
                        # Never carry a held bridge into the next leg.
                        sync_hw.release_one(sync_paused, direction != "up", speed)
                        sync_paused = None
                    next_is_home = (self.current_shelf + step) % self.shelves == 0
                    if home_leg and not next_is_home:
                        # Shelf 1 is counted. Ramp back up to cruise now if both
                        # sensors have fired; otherwise the watch above does it
                        # once the home sensor has caught up.
                        home_leg = False
                        if not sync_active:
                            leg_target = cruise
                            if not on_final_approach:
                                decel_started = None
                                ramp_floor = speed
                                ramp_started = now
                                if ramp_seconds <= 0 and speed < cruise:
                                    self._energise(direction, cruise)
                                    speed = cruise
                    elif next_is_home and not home_leg:
                        # Shelf 1 is next: ease down to Approach and start timing.
                        home_leg = True
                        sync_active = True
                        leg_target = approach
                        self._chain_sync_last_corrected = False
                        if not on_final_approach and approach < speed:
                            decel_from = speed
                            decel_started = now
                            decel_seconds = min(self._ramp_seconds(), DECEL_LEG_FRACTION * pitch_time)
                            if decel_seconds <= 0:
                                self._energise(direction, approach)
                                speed = approach
                    if home_leg and next_is_home:
                        sync_shelf_t = None
                        sync_home_t = None
                        sync_recorded = False
                        home_was_active = bool(sync_hw.index_active())

            # Checked on EVERY pass, deliberately outside the if/elif above.
            # As an `elif` it was unreachable in the one case it exists for: a
            # dead sensor reads inactive forever, so the first branch always won
            # and the guard never ran.
            if time.monotonic() - last_activity > silence_limit:
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
                   "onSensor": bool(self.hw.shelf_active()),
                   "positionMode": "sensor",
                   "rejectedEdges": rejected_edges})


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

    # Which drive the app selected for this unit. Precedence: --motor on the
    # command line (an operator override) > the mode persisted from the app's
    # last `config` > DC. The app re-sends its choice on every connect, so a
    # fresh install converges on the configured mode after the first handshake.
    motor_conf = load_motor_conf()
    motor_mode = args.motor or motor_conf.get("mode") or "dc"
    servo_params = {
        "pulses_per_rev": motor_conf.get("pulsesPerRev", SERVO_PULSES_PER_REV),
        "max_pps": motor_conf.get("maxPps", SERVO_MAX_PPS),
        "mirror_b": motor_conf.get("mirrorB", SERVO_MIRROR_B),
        "ignore_alarm": bool(motor_conf.get("ignoreAlarm", False)),
        "dc_trim_pct": float(motor_conf.get("dcTrimPct", 0.0) or 0.0),
        "dc_trim_up_pct": float(motor_conf.get("dcTrimUpPct", 0.0) or 0.0),
        "dc_trim_per_dir": bool(motor_conf.get("dcTrimPerDirection", False)),
        "single_motor": bool(motor_conf.get("singleMotor", False)),
    }
    DC_ONLY_PARAMS = ("dc_trim_pct", "dc_trim_up_pct", "dc_trim_per_dir")
    # Per-carousel state (hold timeout, positioning, calibration). A normal Pi
    # has one carousel stored at the top level; twin mode (hardware only) keeps
    # one entry per side so each carousel keeps its own calibration.
    single_saved = {
        "holdTimeoutS": motor_conf.get("holdTimeoutS", SERVO_HOLD_TIMEOUT_S),
        "sensorArmS": motor_conf.get("sensorArmS", 0),
        "homeTimeoutS": motor_conf.get("homeTimeoutS"),
        "shelfTimeoutS": motor_conf.get("shelfTimeoutS"),
        "chainSyncEnabled": motor_conf.get("chainSyncEnabled"),
        "chainSyncToleranceMs": motor_conf.get("chainSyncToleranceMs"),
        "chainSyncMaxWaitS": motor_conf.get("chainSyncMaxWaitS"),
        "chainSyncShelfSide": motor_conf.get("chainSyncShelfSide"),
        "positionMode": motor_conf.get("positionMode"),
        "calibration": motor_conf.get("calibration"),
    }
    sides_saved: dict = dict(motor_conf.get("sides") or {}) if isinstance(motor_conf.get("sides"), dict) else {}

    def build_hardware(mode: str, side: str = ""):
        """Return (hw, sim_reason) for the requested drive mode and twin side."""
        twin_kw: dict = {}
        label = ""
        if side:
            idx = TWIN_SIDES.index(side)
            twin_kw = {
                "motor_index": idx,
                "shelf_pin": PIN_SHELF_SENSOR if idx == 0 else PIN_SHELF_SENSOR_R,
                "index_pin": PIN_INDEX_SENSOR if idx == 0 else PIN_INDEX_SENSOR_R,
            }
            label = f" [{side} carousel: motor {'AB'[idx]}, shelf sensor GPIO {twin_kw['shelf_pin']}, home sensor GPIO {twin_kw['index_pin']}]"
        if args.simulate:
            print(f"[agent] running in SIMULATION mode ({shelves} shelves, {mode} drive){label}", flush=True)
            return SimHardware(shelves, motor_mode=mode), "started with --simulate"
        try:
            if mode == "servo":
                params = {k: v for k, v in servo_params.items() if k not in DC_ONLY_PARAMS}
                if side:
                    params["single_motor"] = False
                built = ServoHardware(**params, **twin_kw)
                what = (
                    "one iSV57T servo" if side
                    else ("ONE iSV57T servo (motor A only)" if servo_params["single_motor"] else "two iSV57T servos")
                )
                print(
                    f"[agent] GPIO ready: driving {what} on PUL/DIR "
                    f"(PUL {PIN_SERVO_PUL_A}/{PIN_SERVO_PUL_B}, DIR {PIN_SERVO_DIR_A}/{PIN_SERVO_DIR_B}, "
                    f"ALM {PIN_SERVO_ALM_A}/{PIN_SERVO_ALM_B}){label}",
                    flush=True,
                )
            else:
                built = RealHardware(mirror_b=servo_params["mirror_b"], **twin_kw)
                built.dc_trim_pct = servo_params["dc_trim_pct"]
                built.dc_trim_up_pct = servo_params["dc_trim_up_pct"]
                built.dc_trim_per_dir = servo_params["dc_trim_per_dir"]
                # flush=True matters under systemd: stdout is a pipe, not a TTY, so
                # Python block-buffers it and this line can sit unflushed indefinitely.
                print(
                    f"[agent] GPIO ready: driving {'one DC motor' if side else 'two DC motors'} on BTS7960 bridges "
                    f"(A: RPWM {PIN_MOTOR_A_RPWM} LPWM {PIN_MOTOR_A_LPWM} EN {PIN_MOTOR_A_EN}; "
                    f"B: RPWM {PIN_MOTOR_B_RPWM} LPWM {PIN_MOTOR_B_LPWM} EN {PIN_MOTOR_B_EN}; "
                    f"mirror B={servo_params['mirror_b']}){label}",
                    flush=True,
                )
            return built, None
        except Exception as exc:
            if args.strict_gpio:
                print(
                    f"[agent] FATAL: GPIO unavailable ({exc}); --strict-gpio set, refusing to simulate",
                    flush=True,
                )
                raise SystemExit(1)
            print("=" * 72, flush=True)
            print("[agent] WARNING: GPIO IS UNAVAILABLE — RUNNING IN SIMULATION", flush=True)
            print(f"[agent] reason: {exc}", flush=True)
            print("[agent] The motor will NOT move. Commands will look like they", flush=True)
            print("[agent] succeed because motion is faked in software.", flush=True)
            print("[agent] On a Pi 5, gpiozero needs the lgpio pin factory:", flush=True)
            print("[agent]     sudo apt install -y python3-lgpio", flush=True)
            print("[agent]     GPIOZERO_PIN_FACTORY=lgpio", flush=True)
            print("=" * 72, flush=True)
            return SimHardware(shelves, motor_mode=mode), f"GPIO unavailable: {exc}"

    # Mutable so the WebSocket handler (a closure) can rebind them live.
    rt = {"mode": motor_mode, "sim_reason": None, "twin": bool(motor_conf.get("twin", False))}
    loop = asyncio.get_running_loop()
    clients: "set[object]" = set()

    def broadcast(event: Optional[dict]) -> None:
        """Called from the Carousel worker thread → hop back onto the loop."""
        if event is None:
            return
        data = json.dumps(event)
        for ws in list(clients):
            asyncio.run_coroutine_threadsafe(_safe_send(ws, data), loop)

    async def _safe_send(ws, data: str) -> None:
        try:
            await ws.send(data)
        except Exception:
            pass

    # One Carousel per physical carousel. Key "" = the normal single carousel;
    # "left"/"right" = twin carousels sharing this Pi. Every event a twin side
    # emits is tagged with its `side` so the app routes it to the right unit.
    units: "dict[str, Carousel]" = {}

    def tag(side: str, frame: Optional[dict]) -> Optional[dict]:
        if frame is None:
            return None
        return {**frame, "side": side} if side else frame

    def side_saved(side: str) -> dict:
        if not side:
            return single_saved
        got = sides_saved.get(side)
        return got if isinstance(got, dict) else {}

    def make_unit(side: str) -> "Carousel":
        saved = side_saved(side)
        hw, reason = build_hardware(rt["mode"], side)
        if reason and not rt["sim_reason"]:
            rt["sim_reason"] = reason
        c = Carousel(hw, shelves, lambda ev, s=side: broadcast(tag(s, ev)))
        c.side = side
        c.set_hold_timeout(saved.get("holdTimeoutS", SERVO_HOLD_TIMEOUT_S))
        c.set_sensor_arm(saved.get("sensorArmS", 0))
        c.set_home_timeout(saved.get("homeTimeoutS"))
        c.set_shelf_timeout(saved.get("shelfTimeoutS"))
        c.set_chain_sync(
            enabled=saved.get("chainSyncEnabled"),
            tolerance_ms=saved.get("chainSyncToleranceMs"),
            max_wait_s=saved.get("chainSyncMaxWaitS"),
            shelf_side=saved.get("chainSyncShelfSide"),
        )
        c.set_position_mode(saved.get("positionMode"))
        c.restore_calibration(saved.get("calibration"))
        if side:
            c.set_reverse(bool(saved.get("reverseDir", False)))
        c.on_calibration = lambda _info: persist_motor_conf()

        def adopt_balance(pct: float, direction: str = "down") -> None:
            servo_params["dc_trim_up_pct" if direction == "up" else "dc_trim_pct"] = float(pct)
            persist_motor_conf()

        c.on_balance = adopt_balance
        return c

    def build_units() -> None:
        rt["sim_reason"] = None
        for s in (TWIN_SIDES if rt["twin"] else ("",)):
            units[s] = make_unit(s)

    def teardown_units() -> None:
        for c in list(units.values()):
            c.shutdown()
            for fn in (c.hw.stop, c.hw.cleanup):
                try:
                    fn()
                except Exception:
                    pass
        units.clear()
        time.sleep(0.15)  # let the worker threads notice shutdown

    def unit_snapshot(c: "Carousel") -> dict:
        return {
            "holdTimeoutS": c.hold_timeout_s,
            "sensorArmS": c.sensor_arm_s,
            "shelfPitchS": c._learned_pitch_s,
            "homeTimeoutS": c.home_timeout_s,
            "shelfTimeoutS": c.shelf_timeout_s,
            "chainSyncEnabled": c.chain_sync_enabled,
            "chainSyncToleranceMs": c.chain_sync_tolerance_ms,
            "chainSyncMaxWaitS": c.chain_sync_max_wait_s,
            "chainSyncShelfSide": c.chain_sync_shelf_side,
            "positionMode": c.position_mode,
            "calibration": c.calibration_info,
            "reverseDir": c.reverse_dir,
        }

    def persist_motor_conf(mode: Optional[str] = None) -> None:
        """Write everything the agent must know before the app reconnects."""
        if "" in units:
            single_saved.update(unit_snapshot(units[""]))
        for s in TWIN_SIDES:
            if s in units:
                sides_saved[s] = unit_snapshot(units[s])
        save_motor_conf({
            "mode": mode if mode in ("dc", "servo") else rt["mode"],
            "pulsesPerRev": servo_params["pulses_per_rev"],
            "maxPps": servo_params["max_pps"],
            "mirrorB": servo_params["mirror_b"],
            "ignoreAlarm": bool(servo_params["ignore_alarm"]),
            "dcTrimPct": servo_params["dc_trim_pct"],
            "dcTrimUpPct": servo_params["dc_trim_up_pct"],
            "dcTrimPerDirection": bool(servo_params["dc_trim_per_dir"]),
            "singleMotor": bool(servo_params["single_motor"]),
            "twin": rt["twin"],
            **single_saved,
            "sides": sides_saved,
        })

    build_units()

    def hello_frame() -> dict:
        first = next(iter(units.values()))
        return {
            "type": "hello",
            "name": args.name,
            "shelves": first.shelves,
            "firmware": "pax-agent-1.8",
            "role": args.role,
            "simulated": rt["sim_reason"] is not None,
            "simReason": rt["sim_reason"],
            "motorMode": rt["mode"],
            "twin": rt["twin"],
            "sides": list(TWIN_SIDES) if rt["twin"] else [],
        }

    def state_frames() -> list:
        """Everything a freshly connected app needs, per carousel."""
        out: list = []
        for side, c in units.items():
            for f in (c.snapshot(), c.sensor_snapshot(), c.servo_snapshot(), c.calibration_frame()):
                if f is not None:
                    out.append(tag(side, f))
        return out

    def any_busy() -> bool:
        return any(c.status != "idle" for c in units.values())

    def switch_motor_mode(mode: str) -> bool:
        """Rebuild every carousel's backend for `mode`, idle only."""
        if any_busy():
            broadcast({"type": "fault", "message": f"Motor drive change to '{mode}' ignored while a carousel is moving. Stop it first."})
            return False
        rt["mode"] = mode
        rt["sim_reason"] = None
        for side, c in units.items():
            for fn in (c.hw.stop, c.hw.cleanup):
                try:
                    fn()
                except Exception:
                    pass
            new_hw, reason = build_hardware(mode, side)
            if reason and not rt["sim_reason"]:
                rt["sim_reason"] = reason
            c.hw = new_hw
        print(f"[agent] motor drive switched to {mode}", flush=True)
        broadcast(hello_frame())
        for side, c in units.items():
            broadcast(tag(side, c.servo_snapshot()))
        return True

    def set_twin(on: bool) -> bool:
        """Split this Pi into Left/Right carousels (or merge back), idle only."""
        if any_busy():
            broadcast({"type": "fault", "message": "Twin carousel change ignored while a carousel is moving. Stop it first."})
            return False
        teardown_units()
        rt["twin"] = bool(on)
        build_units()
        persist_motor_conf()
        print(f"[agent] twin carousels {'ON (left = motor A, right = motor B)' if on else 'OFF'}", flush=True)
        broadcast(hello_frame())
        for f in state_frames():
            broadcast(f)
        return True

    def unit_for(msg: dict) -> "Carousel":
        if rt["twin"]:
            s = msg.get("side")
            return units[s if s in TWIN_SIDES else "left"]
        return units[""]

    # ------------------------------------------------------------------
    # Networking (paxnet): fallback watchdog + net.* command family
    # ------------------------------------------------------------------
    net = NetService(args, broadcast, loop)
    net.start()

    async def handler(ws) -> None:
        clients.add(ws)
        try:
            # Greet + send current state immediately. These MUST stay inside the
            # try: the app may close the socket mid-greeting, and an unguarded
            # send would skip the `finally` and leak the dead socket.
            await ws.send(json.dumps(hello_frame()))
            for f in state_frames():
                await ws.send(json.dumps(f))
            _net = net.cached_status()
            if _net is not None:
                await ws.send(json.dumps(_net))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                t = msg.get("type")
                if t == "stop":
                    # Twin: a stop without a side is the emergency stop and
                    # halts BOTH carousels.
                    targets = [unit_for(msg)] if (rt["twin"] and msg.get("side") in TWIN_SIDES) else list(units.values())
                    for c in targets:
                        c.request_stop()
                        c.status = "idle"
                        broadcast(tag(c.side, c.snapshot()))
                    continue
                if t == "config":
                    want_twin = msg.get("twin")
                    if isinstance(want_twin, bool) and want_twin != rt["twin"]:
                        set_twin(want_twin)
                carousel = unit_for(msg)
                side = carousel.side
                if t == "home":
                    carousel.request_home()
                elif t == "goto":
                    carousel.request_goto(int(msg.get("shelf", 0)))
                elif t == "config":
                    carousel.set_shelves(int(msg.get("shelves", carousel.shelves)))
                    carousel.set_motion(
                        move_speed=msg.get("moveSpeed"),
                        homing_speed=msg.get("homingSpeed"),
                        ramp_pct=msg.get("rampPct"),
                        approach_speed=msg.get("approachSpeed"),
                    )
                    # Drive selection + tuning are shared by every carousel on
                    # this Pi (one wiring, one installer choice).
                    want = msg.get("motorMode")
                    servo_fields = {
                        "pulses_per_rev": msg.get("servoPulsesPerRev"),
                        "max_pps": msg.get("servoMaxPps"),
                        "mirror_b": msg.get("servoMirrorB"),
                        "ignore_alarm": msg.get("servoIgnoreAlarm"),
                        "dc_trim_pct": (
                            msg.get("dcTrimPct") if isinstance(msg.get("dcTrimPct"), (int, float)) else None
                        ),
                        "dc_trim_up_pct": (
                            msg.get("dcTrimUpPct") if isinstance(msg.get("dcTrimUpPct"), (int, float)) else None
                        ),
                        "dc_trim_per_dir": (
                            msg.get("dcTrimPerDirection") if isinstance(msg.get("dcTrimPerDirection"), bool) else None
                        ),
                        "single_motor": (
                            msg.get("servoSingleMotor") if isinstance(msg.get("servoSingleMotor"), bool) else None
                        ),
                    }
                    if rt["twin"]:
                        # Each twin side already owns exactly one motor.
                        servo_fields["single_motor"] = None
                        for k in DC_ONLY_PARAMS:
                            servo_fields[k] = None
                    for k, v in servo_fields.items():
                        if v is not None:
                            servo_params[k] = v
                    hold = msg.get("servoHoldTimeoutS")
                    if isinstance(hold, (int, float)):
                        carousel.set_hold_timeout(hold)
                    arm = msg.get("sensorArmS")
                    arm_changed = isinstance(arm, (int, float)) and not isinstance(arm, bool) and carousel.set_sensor_arm(arm)
                    home_t = msg.get("homeTimeoutS")
                    home_changed = (isinstance(home_t, (int, float)) and not isinstance(home_t, bool)
                                    and carousel.set_home_timeout(home_t))
                    shelf_t = msg.get("shelfTimeoutS")
                    shelf_changed = (isinstance(shelf_t, (int, float)) and not isinstance(shelf_t, bool)
                                     and carousel.set_shelf_timeout(shelf_t))
                    sync_changed = carousel.set_chain_sync(
                        enabled=msg.get("chainSyncEnabled"),
                        tolerance_ms=msg.get("chainSyncToleranceMs"),
                        max_wait_s=msg.get("chainSyncMaxWaitS"),
                        shelf_side=msg.get("chainSyncShelfSide"),
                    )
                    home_changed = home_changed or shelf_changed or sync_changed
                    reverse_changed = bool(side) and carousel.set_reverse(msg.get("reverseDir"))
                    mode_changed = (carousel.set_position_mode(msg.get("positionMode")) or reverse_changed
                                    or arm_changed or home_changed)
                    cal_restored = carousel.restore_calibration({
                        "pulsesPerRev": msg.get("servoCarouselPulses"),
                        "indexWindowPulses": msg.get("servoIndexWindowPulses"),
                    })
                    if (want in ("dc", "servo") or hold is not None or mode_changed or cal_restored
                            or any(v is not None for v in servo_fields.values())):
                        persist_motor_conf(want)
                    if want in ("dc", "servo") and want != rt["mode"]:
                        switch_motor_mode(want)
                    for c in units.values():
                        c.set_servo(**servo_fields)
                    if (hold is not None or servo_fields["ignore_alarm"] is not None
                            or servo_fields["single_motor"] is not None):
                        for c in units.values():
                            broadcast(tag(c.side, c.servo_snapshot()))
                    if mode_changed:
                        broadcast(tag(side, carousel.snapshot()))
                    if cal_restored:
                        broadcast(tag(side, carousel.calibration_frame()))
                elif t == "calibrate":
                    carousel.request_calibrate()
                elif t == "balance_calibrate":
                    carousel.request_balance_calibrate(msg.get("turns"), msg.get("direction"))
                elif t == "release":
                    carousel.request_release()
                elif t == "hold":
                    carousel.request_hold()
                elif t == "jog":
                    if rt["mode"] == "servo":
                        amount = msg.get("pulses")
                        unit = "pulses"
                    else:
                        amount = msg.get("ms")
                        unit = "ms"
                    if not isinstance(amount, (int, float)) or amount <= 0:
                        broadcast({"type": "fault", "message": f"Jog ignored: the {rt['mode']} drive expects a '{unit}' amount."})
                    else:
                        speed = msg.get("speed")
                        carousel.request_jog(
                            str(msg.get("motor", "both")),
                            str(msg.get("direction", "down")),
                            int(amount),
                            float(speed) if isinstance(speed, (int, float)) else None,
                        )
                elif t == "hello":
                    await ws.send(json.dumps(hello_frame()))
                elif t == "net.ack":
                    # A slave confirming it stored the pushed credentials.
                    net.note_ack(msg)
                elif isinstance(t, str) and t.startswith("net."):
                    # nmcli calls block for seconds; keep the motor loop and
                    # other sockets responsive by running them off-loop.
                    asyncio.ensure_future(net.handle(ws, msg))
        except ConnectionClosed:
            # Routine, not an error: the app drops the socket when its last
            # viewer leaves, and a dev-server restart drops it abruptly (which
            # surfaces as ConnectionClosedError "no close frame received or
            # sent"). Either way the app reconnects on its own, so stay quiet and
            # keep serving ��� the motor state lives in `carousel`, not the socket.
            pass
        finally:
            clients.discard(ws)
            net.forget_socket(ws)

    print(f"[agent] '{args.name}' listening on ws://0.0.0.0:{args.port}/", flush=True)
    async with websockets.serve(handler, "0.0.0.0", args.port):
        try:
            await asyncio.Future()  # run forever
        finally:
            net.stop()
            for c in units.values():
                c.shutdown()
                c.hw.cleanup()  # the live backend, which may have been swapped


# ==========================================================================
# Networking service: wraps paxnet for the agent
# ==========================================================================
class NetService:
    """
    Glue between the WebSocket protocol and paxnet.

    Master
      * runs the fallback Watchdog (router → standalone AP after 45 s)
      * answers net.status / net.scan / net.join / net.mode / net.forget
      * keeps a registry of slaves that have connected to it and pushes new
        router credentials to all of them BEFORE switching itself
        (net.provision-slaves, and implicitly on every net.join)

    Slave
      * runs the Watchdog too (router → master's hotspot)
      * answers net.status / net.join (creds pushed by the master)
      * keeps an OUTBOUND client to ws://<master>:8765 registering itself
        (`net.register`) so the master knows it exists — this is how a
        slave that only knows the master's hotspot gets adopted at a new
        location without anyone typing on it.

    All nmcli work runs in a worker thread via run_in_executor; results are
    broadcast as `net.result {op, ok, error?}` plus a fresh `net.status`.
    """

    def __init__(self, args, broadcast: Callable[[dict], None], loop) -> None:
        self.args = args
        self.broadcast = broadcast
        self.loop = loop
        self.cfg = None
        self.watchdog = None
        self._last_status: Optional[dict] = None
        # hostname -> {"ws": websocket, "mac": str, "hostname": str, "seen": float}
        self.slaves: dict[str, dict] = {}
        self._slave_client_task = None
        self._disabled_reason: Optional[str] = None
        if paxnet is None:
            self._disabled_reason = f"paxnet unavailable: {_PAXNET_IMPORT_ERROR}"
        elif getattr(args, "no_net", False):
            self._disabled_reason = "started with --no-net"

    # ------------------------------------------------------------ lifecycle
    def start(self) -> None:
        if self._disabled_reason:
            print(f"[agent] networking disabled ({self._disabled_reason})", flush=True)
            return
        try:
            self.cfg = paxnet.Config()
            self.cfg.role = self.args.role or self.cfg.role
        except Exception as exc:
            self._disabled_reason = f"paxnet config: {exc!r}"
            print(f"[agent] networking disabled ({self._disabled_reason})", flush=True)
            return
        self.watchdog = paxnet.Watchdog(self.cfg, on_change=self._on_status_change)
        self.watchdog.start()
        if self.cfg.role == "slave":
            self._slave_client_task = asyncio.ensure_future(self._slave_client())
        print(f"[agent] networking: role={self.cfg.role} hotspot={self.cfg.ap_ssid}", flush=True)

    def stop(self) -> None:
        if self.watchdog:
            self.watchdog.stop()
        if self._slave_client_task:
            self._slave_client_task.cancel()

    def cached_status(self) -> Optional[dict]:
        return self._last_status

    def _on_status_change(self, st: dict) -> None:
        self._last_status = st
        self.broadcast(st)

    # ------------------------------------------------------------ helpers
    async def _run(self, fn, *a):
        return await self.loop.run_in_executor(None, fn, *a)

    async def _send(self, ws, payload: dict) -> None:
        try:
            await ws.send(json.dumps(payload))
        except Exception:
            pass

    async def _result(self, ws, op: str, ok: bool, error: Optional[str] = None, **extra) -> None:
        payload = {"type": "net.result", "op": op, "ok": ok, **extra}
        if error:
            payload["error"] = error
        # Results go to everyone: another tab that is watching the panel
        # should see the connect finish too.
        self.broadcast(payload)
        await self._push_status()

    async def _push_status(self) -> None:
        try:
            st = await self._run(paxnet.status, self.cfg)
        except Exception as exc:
            st = {"type": "net.status", "role": self.cfg.role if self.cfg else "master", "mode": "unknown",
                  "error": str(exc), "at": int(time.time() * 1000)}
        self._last_status = st
        self.broadcast(st)

    def _slaves_payload(self) -> dict:
        now = time.time()
        return {
            "type": "net.slaves",
            "slaves": [
                {
                    "hostname": s["hostname"],
                    "mac": s.get("mac"),
                    "online": (now - s["seen"]) < 90 and s.get("ws") is not None,
                    "mode": s.get("mode"),
                    "ssid": s.get("ssid"),
                    "ip": s.get("ip"),
                }
                for s in self.slaves.values()
            ],
        }

    # ------------------------------------------------------------ commands
    async def handle(self, ws, msg: dict) -> None:
        t = msg.get("type", "")
        op = t[4:]  # strip "net."
        if self._disabled_reason:
            await self._send(ws, {"type": "net.result", "op": op, "ok": False, "error": self._disabled_reason})
            return
        cfg = self.cfg
        try:
            if op == "status":
                await self._push_status()
                if cfg.role == "master":
                    self.broadcast(self._slaves_payload())

            elif op == "scan":
                nets = await self._run(paxnet.scan, cfg.iface)
                await self._send(ws, {"type": "net.scan", "networks": nets})

            elif op == "join":
                ssid = str(msg.get("ssid", ""))
                psk = str(msg.get("psk", "") or "")
                paxnet.validate_creds(ssid, psk)
                # A master with the pin on "ap" would be yanked straight back to
                # the hotspot by the watchdog: joining implies auto.
                if cfg.mode == "ap":
                    cfg.mode = "auto"
                    await self._run(cfg.save)
                if cfg.role == "master":
                    # Slaves first. Once *we* leave the hotspot they can no
                    # longer hear us, so the order is not negotiable.
                    pushed = await self._provision_slaves(ssid, psk)
                    self.broadcast({"type": "net.result", "op": "provision-slaves", "ok": True, **pushed})
                    # Anyone on the hotspot right now is about to lose us.
                    self.broadcast({"type": "net.result", "op": "join-starting", "ok": True, "ssid": ssid})
                    await asyncio.sleep(0.5)  # let the frames flush
                elif msg.get("fromMaster"):
                    # Master pushed creds. Also refresh our copy of its hotspot
                    # so a master reinstall with a new psk does not orphan us.
                    ap_ssid, ap_psk = msg.get("apSsid"), msg.get("apPsk")
                    if ap_ssid and ap_psk:
                        cfg.ap_ssid, cfg.ap_psk = str(ap_ssid), str(ap_psk)
                        await self._run(cfg.save)
                        await self._run(paxnet.ensure_master_ap_profile, cfg)
                    # Only SAVE; the master switches first, we follow when its
                    # hotspot vanishes (NM autoconnect picks pax-router by
                    # priority). Switching now would drop the very socket the
                    # master is waiting on for our ack.
                    await self._run(paxnet.save_router_profile, ssid, psk, cfg.iface)
                    await self._send(ws, {"type": "net.ack", "op": "join", "ok": True, "hostname": paxnet.hostname()})
                    if self.watchdog:
                        self.watchdog.kick()
                    return
                await self._run(paxnet.join, ssid, psk, cfg.iface)
                if self.watchdog:
                    self.watchdog.in_fallback = False
                    self.watchdog.kick()
                await self._result(ws, "join", True, ssid=ssid)

            elif op == "mode":
                mode = str(msg.get("mode", "auto"))
                if mode not in paxnet.VALID_MODES:
                    raise paxnet.NetError(f"mode must be one of {paxnet.VALID_MODES}")
                if cfg.role != "master" and mode == "ap":
                    raise paxnet.NetError("only the master can run a hotspot")
                cfg.mode = mode
                await self._run(cfg.save)
                if mode == "ap":
                    self.broadcast({"type": "net.result", "op": "ap-starting", "ok": True, "apSsid": cfg.ap_ssid})
                    await asyncio.sleep(0.5)
                    await self._run(paxnet.ap_up, cfg)
                elif mode == "router":
                    if cfg.role == "master":
                        await self._run(paxnet.ap_down, cfg)
                    await self._run(paxnet.router_up, cfg.iface)
                if self.watchdog:
                    self.watchdog.kick()
                await self._result(ws, "mode", True, mode=mode)

            elif op == "forget":
                await self._run(paxnet.forget_router)
                if self.watchdog:
                    self.watchdog.kick()
                await self._result(ws, "forget", True)

            elif op == "provision-slaves":
                if cfg.role != "master":
                    raise paxnet.NetError("only the master provisions slaves")
                ssid = await self._run(paxnet.saved_router_ssid)
                psk = await self._run(paxnet.saved_router_psk)
                if not ssid:
                    raise paxnet.NetError("no router saved on the master yet")
                pushed = await self._provision_slaves(ssid, psk or "")
                await self._result(ws, "provision-slaves", True, **pushed)
                self.broadcast(self._slaves_payload())

            elif op == "set-ap-psk":
                psk = str(msg.get("psk", "") or "")
                if not (8 <= len(psk) <= 63):
                    raise paxnet.NetError("hotspot password must be 8–63 characters")
                if msg.get("fromMaster"):
                    # Slave: the master rotated its hotspot key. Update our
                    # fallback profile and config, then ack on this socket.
                    if cfg.role != "slave":
                        raise paxnet.NetError("fromMaster push received on a master")
                    ap_ssid = str(msg.get("apSsid") or cfg.ap_ssid)
                    cfg.ap_ssid, cfg.ap_psk = ap_ssid, psk
                    await self._run(cfg.save)
                    await self._run(paxnet.ensure_master_ap_profile, cfg)
                    await self._send(ws, {"type": "net.ack", "op": "set-ap-psk", "ok": True, "hostname": paxnet.hostname()})
                    return
                if cfg.role != "master":
                    raise paxnet.NetError("only the master has a hotspot")
                # Slaves first, while they can still hear us on the OLD key.
                pushed = await self._push_ap_psk(psk)
                cfg.ap_psk = psk
                await self._run(cfg.save)
                await self._run(paxnet.ensure_ap_profile, cfg)
                if await self._run(paxnet.ap_active, cfg):
                    # nmcli con modify does not touch a live AP; bounce it so
                    # phones must use the new key right away.
                    self.broadcast({"type": "net.result", "op": "ap-starting", "ok": True, "apSsid": cfg.ap_ssid})
                    await asyncio.sleep(0.5)
                    await self._run(paxnet.ap_up, cfg)
                await self._result(ws, "set-ap-psk", True, **pushed)
                self.broadcast(self._slaves_payload())

            elif op == "register":
                # A slave introducing itself over its outbound client socket.
                host = str(msg.get("hostname") or "slave")
                self.slaves[host] = {
                    "ws": ws, "hostname": host, "mac": msg.get("mac"), "seen": time.time(),
                    "mode": msg.get("mode"), "ssid": msg.get("ssid"), "ip": msg.get("ip"),
                }
                await self._send(ws, {"type": "net.registered", "master": paxnet.hostname(),
                                      "apSsid": cfg.ap_ssid, "apPsk": cfg.ap_psk})
                self.broadcast(self._slaves_payload())

            elif op == "slaves":
                self.broadcast(self._slaves_payload())

            else:
                await self._send(ws, {"type": "net.result", "op": op, "ok": False, "error": f"unknown net op '{op}'"})
        except Exception as exc:
            err = str(exc) if isinstance(exc, paxnet.NetError) else repr(exc)
            print(f"[agent] net.{op} failed: {err}", flush=True)
            await self._result(ws, op, False, err)

    # ------------------------------------------------------------ master → slaves
    async def _provision_slaves(self, ssid: str, psk: str) -> dict:
        """Push router creds (+ our hotspot creds) to every registered slave and
        wait up to 5 s for each ack. Returns counts for the UI."""
        cfg = self.cfg
        return await self._push_to_slaves({
            "type": "net.join", "fromMaster": True, "ssid": ssid, "psk": psk,
            "apSsid": cfg.ap_ssid, "apPsk": cfg.ap_psk,
        })

    async def _push_ap_psk(self, new_psk: str) -> dict:
        """Tell every registered slave the hotspot key is changing."""
        return await self._push_to_slaves({
            "type": "net.set-ap-psk", "fromMaster": True, "psk": new_psk, "apSsid": self.cfg.ap_ssid,
        })

    async def _push_to_slaves(self, message: dict) -> dict:
        payload = json.dumps(message)
        acked, failed = [], []

        async def one(host: str, entry: dict) -> None:
            ws = entry.get("ws")
            if ws is None:
                failed.append(host)
                return
            try:
                await ws.send(payload)
                # Wait for the ack on the same socket; the recv loop for slave
                # sockets lives in handler(), so listen via a future the loop
                # resolves in _note_ack.
                fut = self.loop.create_future()
                entry["ack"] = fut
                await asyncio.wait_for(fut, timeout=5)
                acked.append(host)
            except Exception:
                failed.append(host)
            finally:
                entry.pop("ack", None)

        await asyncio.gather(*(one(h, e) for h, e in list(self.slaves.items())))
        print(f"[agent] pushed {message.get('type')} to slaves: ok={acked} failed={failed}", flush=True)
        return {"acked": acked, "failed": failed}

    def forget_socket(self, ws) -> None:
        """A registered slave's socket closed: mark it offline (keep the row so
        the UI still lists it — it will re-register on reconnect)."""
        changed = False
        for entry in self.slaves.values():
            if entry.get("ws") is ws:
                entry["ws"] = None
                changed = True
        if changed:
            self.broadcast(self._slaves_payload())

    def note_ack(self, msg: dict) -> None:
        host = msg.get("hostname")
        entry = self.slaves.get(host) if host else None
        if entry and (fut := entry.get("ack")) and not fut.done():
            fut.set_result(True)
        if entry:
            entry["seen"] = time.time()

    # ------------------------------------------------------------ slave → master
    async def _slave_client(self) -> None:
        """Keep an outbound socket to the master open and re-register on every
        (re)connect. Hostname resolution goes through mDNS, so this works on
        the router *and* on the master's hotspot without config changes."""
        import websockets
        cfg = self.cfg
        url = f"ws://{cfg.master_host}:{self.args.port}/"
        backoff = 3
        while True:
            try:
                async with websockets.connect(url, open_timeout=10, ping_interval=20) as ws:
                    backoff = 3
                    st = await self._run(paxnet.status, cfg)
                    await ws.send(json.dumps({
                        "type": "net.register", "hostname": paxnet.hostname(),
                        "mac": _wifi_mac(cfg.iface), "mode": st.get("mode"),
                        "ssid": st.get("ssid"), "ip": st.get("ip"),
                    }))
                    print(f"[agent] registered with master at {url}", flush=True)
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except Exception:
                            continue
                        t = msg.get("type", "")
                        if t == "net.registered":
                            # Adopt the master's hotspot creds if we lack them.
                            ap_ssid, ap_psk = msg.get("apSsid"), msg.get("apPsk")
                            if ap_ssid and ap_psk and (cfg.ap_ssid != ap_ssid or cfg.ap_psk != ap_psk):
                                cfg.ap_ssid, cfg.ap_psk = ap_ssid, ap_psk
                                await self._run(cfg.save)
                                try:
                                    await self._run(paxnet.ensure_master_ap_profile, cfg)
                                except Exception as exc:
                                    print(f"[agent] master-ap profile: {exc}", flush=True)
                        elif isinstance(t, str) and t.startswith("net."):
                            await self.handle(ws, msg)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                print(f"[agent] master link down ({exc.__class__.__name__}); retry in {backoff}s", flush=True)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)


def _wifi_mac(iface: str) -> Optional[str]:
    try:
        return open(f"/sys/class/net/{iface}/address").read().strip()
    except Exception:
        return None


def main() -> None:
    p = argparse.ArgumentParser(description="PAX paternoster Raspberry Pi agent")
    p.add_argument("--name", default="Paternoster", help="Human-readable unit name")
    p.add_argument("--port", type=int, default=8765, help="WebSocket port (match the app)")
    p.add_argument("--shelves", type=int, default=9, help="Number of shelves on this carousel")
    p.add_argument(
        "--role",
        choices=("master", "slave"),
        default=None,
        help="master: runs the fallback hotspot and provisions slaves; slave: follows the master (default: from /etc/paxnet.conf)",
    )
    p.add_argument("--no-net", action="store_true", help="Disable Wi-Fi/hotspot management entirely")
    p.add_argument(
        "--motor",
        choices=("dc", "servo"),
        default=None,
        help="Force the motor drive: dc = two DC motors on two BTS7960 bridges, servo = two iSV57T on PUL/DIR "
             "(default: whatever the app last configured, else dc)",
    )
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
