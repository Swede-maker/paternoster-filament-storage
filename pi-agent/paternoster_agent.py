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

# Motion tuning.
HOMING_SPEED = 0.45   # 0..1 PWM duty during homing
MOVE_SPEED = 0.7      # 0..1 PWM duty during normal moves
PULSE_TIMEOUT = 8.0   # seconds to wait for the next shelf pulse before faulting
HOME_TIMEOUT = 30.0   # seconds to find the index sensor before faulting
SENSOR_BOUNCE = 0.01  # debounce (s) for the inductive sensors

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

    def wait_shelf_edge(self, timeout: float) -> bool:
        # Rising edge = a shelf entered the window.
        self.shelf.wait_for_inactive(timeout=0.001)
        return bool(self.shelf.wait_for_active(timeout=timeout))

    def wait_index_edge(self, timeout: float) -> bool:
        return bool(self.index.wait_for_active(timeout=timeout))

    def index_active(self) -> bool:
        return bool(self.index.is_active)

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
        self._shelf_edge = threading.Event()
        self._index_edge = threading.Event()
        self._running = True
        self._t = threading.Thread(target=self._loop, daemon=True)
        self._t.start()

    def _loop(self) -> None:
        last = time.monotonic()
        while self._running:
            now = time.monotonic()
            dt = now - last
            last = now
            with self._lock:
                if self._dir != 0 and self._speed > 0:
                    before = self._pos
                    # ~1 shelf every (0.4 / speed) seconds.
                    self._pos += self._dir * dt * (self._speed / 0.4)
                    if int(before) != int(self._pos):
                        self._shelf_edge.set()
                    if int(before) != int(self._pos) and int(round(self._pos)) % self.shelves == 0:
                        self._index_edge.set()
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

    def wait_shelf_edge(self, timeout: float) -> bool:
        self._shelf_edge.clear()
        return self._shelf_edge.wait(timeout)

    def wait_index_edge(self, timeout: float) -> bool:
        self._index_edge.clear()
        return self._index_edge.wait(timeout)

    def index_active(self) -> bool:
        with self._lock:
            return int(round(self._pos)) % self.shelves == 0

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
        if HOMING_DIRECTION == "down":
            self.hw.backward(HOMING_SPEED)
        else:
            self.hw.forward(HOMING_SPEED)
        found = self.hw.wait_index_edge(HOME_TIMEOUT)
        self.hw.stop()
        if self._abort.is_set():
            self.status = "idle"
            return
        if not found:
            self.status = "idle"
            self.emit({"type": "fault", "message": "Homing timed out: index sensor not found"})
            return
        self.current_shelf = 0
        self.homed = True
        self.status = "idle"
        self.emit({"type": "homed", "shelf": 0})

    def _do_goto(self, target: int) -> None:
        if not self.homed:
            self.emit({"type": "fault", "message": "Cannot move before homing"})
            return
        if target == self.current_shelf:
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

        if direction == "up":
            self.hw.backward(MOVE_SPEED)
            step = -1
        else:
            self.hw.forward(MOVE_SPEED)
            step = +1

        for _ in range(steps):
            if self._abort.is_set():
                self.hw.stop()
                self.status = "idle"
                return
            if not self.hw.wait_shelf_edge(PULSE_TIMEOUT):
                self.hw.stop()
                self.status = "idle"
                self.emit({"type": "fault", "message": "Jam? No shelf pulse within timeout"})
                return
            self.current_shelf = (self.current_shelf + step) % self.shelves
            # Drift correction: if we passed the index while moving, trust it.
            if self.current_shelf != 0 and self.hw.index_active():
                self.current_shelf = 0
            self.emit({"type": "pos", "shelf": self.current_shelf})

        self.hw.stop()
        self.status = "idle"
        self.current_shelf = target
        self.emit({"type": "arrived", "shelf": target})


# ==========================================================================
# WebSocket server
# ==========================================================================
async def serve(args) -> None:
    import websockets

    shelves = max(1, args.shelves)

    if args.simulate:
        hw = SimHardware(shelves)
        print(f"[agent] running in SIMULATION mode ({shelves} shelves)")
    else:
        try:
            hw = RealHardware()
        except Exception as exc:
            print(f"[agent] gpiozero unavailable ({exc}); falling back to --simulate")
            hw = SimHardware(shelves)
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
        # Greet + send current state immediately.
        await ws.send(json.dumps({"type": "hello", "name": args.name, "shelves": carousel.shelves, "firmware": "pax-agent-1.0"}))
        await ws.send(json.dumps(carousel.snapshot()))
        try:
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
                elif t == "hello":
                    await ws.send(json.dumps({"type": "hello", "name": args.name, "shelves": carousel.shelves}))
        finally:
            clients.discard(ws)

    print(f"[agent] '{args.name}' listening on ws://0.0.0.0:{args.port}/")
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
    args = p.parse_args()
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        print("\n[agent] stopped")


if __name__ == "__main__":
    main()
