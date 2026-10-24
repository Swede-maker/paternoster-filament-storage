#!/usr/bin/env python3
"""
Exercises Esp32ServoHardware against a fake ESP32 that speaks the esp32-servo
line protocol, without a serial port or gpiozero.

Checks:
  * the handshake (HELLO -> CFG/ENA/STOP) and linkOk in the snapshot
  * forward()/stop() become RUN/STOP lines with the right direction and Hz
  * sensor edges streamed by the controller land in the SAME counters the GPIO
    backends use (take_shelf_pulse / take_index_pulse / shelf_active), with
    SENSOR_INVERT applied exactly as RealHardware does
  * arm_stop() sends ARM with the gpiozero-sense level and the gap in µs
  * jog() blocks until JOGDONE and books the pulses on the odometer
  * a controller that stops sending status is reported as linkOk=False and the
    Carousel-facing alarms stay quiet (the Carousel reports link loss itself)

Run:  python3 test_esp32_link.py
"""
import sys
import threading
import time
import types

# ---- fake pyserial ---------------------------------------------------------
class FakeSerial:
    """One instance = one ESP32. Replies synchronously to each written line."""
    instances: list = []

    def __init__(self, port, baud, timeout=0.05, write_timeout=0.5):
        self.port = port
        self.baud = baud
        self.timeout = timeout
        self._out = bytearray()
        self._lock = threading.Lock()
        self.sent: list = []
        self.alive = True
        self.silent = False          # stop emitting ST (simulated link loss)
        self.auto_status = True
        self._status_thread = threading.Thread(target=self._status_loop, daemon=True)
        self._status_thread.start()
        FakeSerial.instances.append(self)

    # -- helpers the test uses to act like the firmware
    def emit(self, line: str) -> None:
        with self._lock:
            self._out += (line + "\n").encode()

    def status(self, s=0, h=0, aa=0, ab=0, pos=0.0):
        self.emit(f"ST run=0 hz=0 dir=1 ena=1 s={s} h={h} aa={aa} ab={ab} pos={pos:.1f} jog=0 arm=0 hold=00 up=1")

    def _status_loop(self):
        while self.alive:
            if self.auto_status and not self.silent:
                self.status()
            time.sleep(0.05)

    # -- pyserial surface
    @property
    def in_waiting(self):
        with self._lock:
            return len(self._out)

    def read(self, n=1):
        deadline = time.monotonic() + self.timeout
        while True:
            with self._lock:
                if self._out:
                    chunk = bytes(self._out[:n])
                    del self._out[:n]
                    return chunk
            if time.monotonic() >= deadline:
                return b""
            time.sleep(0.002)

    def write(self, data: bytes):
        if not self.alive:
            raise OSError("port gone")
        for raw in data.decode().split("\n"):
            line = raw.strip()
            if not line:
                continue
            self.sent.append(line)
            cmd = line.split()[0]
            if cmd == "HELLO":
                self.emit("HELLO pax-esp32 fw=test baud=460800")
            elif cmd == "JOG":
                _, which, d, pulses, *_r = line.split()
                threading.Timer(0.05, lambda: self.emit(f"JOGDONE {pulses}")).start()
                self.emit("OK JOG")
            else:
                self.emit(f"OK {cmd}")
        return len(data)

    def close(self):
        self.alive = False


fake_serial = types.ModuleType("serial")
fake_serial.Serial = FakeSerial
sys.modules["serial"] = fake_serial

import paternoster_agent as agent  # noqa: E402

agent.ESP32_HELLO_TIMEOUT_S = 1.0
agent.ESP32_STATUS_TIMEOUT_S = 0.4
agent.ESP32_RECONNECT_S = 0.2
agent.SERVO_ENABLE_SETTLE_S = 0.01

checks = 0


def check(cond, what):
    global checks
    checks += 1
    if not cond:
        print(f"FAIL: {what}")
        sys.exit(1)
    print(f"ok: {what}")


def wait_for(pred, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


hw = agent.Esp32ServoHardware(link="usb", port="/dev/fake0", baud=460800, max_pps=8000)
esp = FakeSerial.instances[-1]

check(wait_for(lambda: hw.link_ok), "handshake completes and linkOk is True")
check(any(s.startswith("CFG ") for s in esp.sent), "CFG pushed after HELLO")
cfg = next(s for s in esp.sent if s.startswith("CFG "))
check("mirror=1" in cfg and "maxpps=8000" in cfg and f"bounce_us={int(agent.SENSOR_BOUNCE * 1e6)}" in cfg,
      f"CFG carries mirror/maxpps/bounce ({cfg})")
snap = hw.servo_snapshot()
check(snap["driver"] == "esp32" and snap["port"] == "/dev/fake0" and snap["esp32Firmware"] == "test",
      "snapshot reports driver, port and firmware")

# ---- motion verbs -----------------------------------------------------------
esp.sent.clear()
hw.forward(0.5)
check(esp.sent[-1] == "RUN 1 4000", f"forward(0.5) -> RUN 1 4000 (got {esp.sent[-1]})")
hw.forward(1.0)
check(esp.sent[-1] == "RUN 1 8000", "speed change re-sends RUN with the new Hz")
hw.backward(0.25)
check(esp.sent[-1] == "RUN -1 2000", "backward -> RUN -1")
time.sleep(0.05)
hw.stop()
check(esp.sent[-1] == "STOP", "stop -> STOP")
check(abs(hw.pulse_position()) > 0, "odometer integrated the pulse train")

hw.release()
check(esp.sent[-1] == "ENA 0" and hw.held is False, "release -> ENA 0")
hw.forward(0.1)
check("ENA 1" in esp.sent, "a move re-engages first (ENA 1)")
hw.stop()

# ---- sensors through the shared counters ------------------------------------
# The fake reports gpiozero-sense ACTIVE levels. RealHardware treats
# "metal arrived" as activated unless SENSOR_INVERT, in which case it is the
# DEactivated edge. Reproduce both edges and check the counter semantics.
arrive = 0 if agent.SENSOR_INVERT else 1
leave = 1 - arrive
esp.auto_status = False
time.sleep(0.1)
hw.reset_pulses()
esp.status(s=leave, h=leave)
time.sleep(0.05)
check(hw.shelf_active() is False, "window empty before the flag")
esp.emit(f"E S {arrive} 1000 10.0")
time.sleep(0.05)
check(hw.shelf_active() is True, "arrival edge: shelf_active() True")
check(hw.take_shelf_pulse(0.0) is True, "arrival edge counted exactly once")
check(hw.take_shelf_pulse(0.0) is False, "no second pulse without a new edge")
hw.travel_direction = "down"
esp.emit(f"E S {leave} 2000 20.0")
time.sleep(0.05)
check(hw.shelf_active() is False and hw.flag_exit_direction == "down", "exit edge updates level + exit direction")
esp.emit(f"E H {arrive} 3000 30.0")
time.sleep(0.05)
check(hw.index_active() is True and hw.take_index_pulse(0.0) is True, "home edge counted")
# A lost E line is recovered from the next status line.
esp.status(s=arrive, h=leave)
time.sleep(0.05)
check(hw.shelf_active() is True and hw.take_shelf_pulse(0.0) is True, "status line re-syncs a missed edge")
esp.auto_status = True

# ---- ARM ---------------------------------------------------------------------
esp.sent.clear()
hw.arm_stop("shelf", min_gap_s=0.123)
check(esp.sent[-1] == f"ARM S {arrive} 123000", f"arm_stop sends level + gap µs ({esp.sent[-1]})")
hw.stop()
check(esp.sent[-1] == "STOP", "stop after arm sends STOP (firmware clears ARM)")

# ---- JOG ---------------------------------------------------------------------
esp.sent.clear()
before = hw.pulse_position()
t0 = time.monotonic()
hw.jog("both", "down", 400)
took = time.monotonic() - t0
check(any(s.startswith("JOG both 1 400") for s in esp.sent), "jog -> JOG both 1 400")
check(0.03 < took < 1.5, f"jog waited for JOGDONE ({took:.2f}s)")
check(abs(hw.pulse_position() - before - 400) < 1e-6, "jog of both chains books 400 pulses on the odometer")
hw.jog("a", "up", 100)
check(abs(hw.pulse_position() - before - 400) < 1e-6, "jog of one chain leaves the odometer alone")

# ---- alarms ---------------------------------------------------------------------
esp.auto_status = False
time.sleep(0.1)
esp.status(aa=1)
time.sleep(0.05)
check(hw.alarms() == (True, False), "ALM A from status -> alarms() (True, False)")
esp.status(aa=0)
esp.auto_status = True
esp.sent.clear()

# ---- link loss + recovery ------------------------------------------------------
esp.silent = True
check(wait_for(lambda: not hw.link_ok, 2.0), "silent controller -> linkOk False")
check(hw.alarms() == (False, False), "link loss does not masquerade as a drive alarm")
check(hw.servo_snapshot()["linkError"], "snapshot carries the link error")
# The reader reopens the port: a NEW FakeSerial answers HELLO and status.
check(wait_for(lambda: hw.link_ok and FakeSerial.instances[-1] is not esp, 3.0), "agent reconnects on its own")
esp2 = FakeSerial.instances[-1]
check(any(s.startswith("CFG ") for s in esp2.sent), "CFG re-pushed after reconnect")

hw.cleanup()
print(f"\nALL CHECKS PASSED ({checks})")
