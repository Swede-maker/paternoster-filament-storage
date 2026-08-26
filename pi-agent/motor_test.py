#!/usr/bin/env python3
"""
PAX paternoster — standalone hardware test.

This bypasses EVERYTHING: no web app, no WebSocket, no systemd, no database.
It talks straight to the GPIO pins so you can find out, in about a minute,
whether the motor and sensors are wired and configured correctly.

Run it directly (stop the service first so both don't fight over the pins):

    sudo systemctl stop paternoster-agent
    cd ~/pax/pi-agent
    python3 motor_test.py

It runs four checks in order and stops at the first one that fails:

    1. Can gpiozero talk to this Pi's GPIO chip at all?
    2. Can it claim the motor pins?
    3. Do the two inductive sensors actually read?  (you turn the carousel by hand)
    4. Does the motor physically turn?               (short, slow bursts)

Everything is short and low-speed, and the bridge is disarmed on exit even if
you Ctrl-C out of it.
"""

import sys
import time

# Imported from the agent so this tests the REAL configuration rather than a
# copy that can drift out of sync. If a pin number or SENSOR_TYPE is wrong in
# paternoster_agent.py, it is wrong here too — which is the point.
from paternoster_agent import (
    HOMING_SPEED,
    PIN_INDEX_SENSOR,
    PIN_MOTOR_EN,
    PIN_MOTOR_LPWM,
    PIN_MOTOR_RPWM,
    PIN_SHELF_SENSOR,
    SENSOR_TYPE,
)

BURST = 1.2  # seconds of motor run per direction — long enough to see, short enough to be safe


def hr(title: str) -> None:
    print()
    print("=" * 68)
    print(f"  {title}")
    print("=" * 68, flush=True)


def fail(msg: str, *hints: str) -> None:
    print(f"\n  ✗ {msg}", flush=True)
    for h in hints:
        print(f"    → {h}", flush=True)
    sys.exit(1)


def step1_pin_factory():
    hr("1/4  GPIO access")
    try:
        import gpiozero
        from gpiozero import Device
    except ImportError as exc:
        fail(
            f"gpiozero is not installed ({exc})",
            "sudo apt install -y python3-gpiozero python3-lgpio",
        )

    # The ONLY thing that decides pass/fail here is whether gpiozero can bring up
    # a pin factory. Nothing cosmetic belongs in this try block: an earlier
    # version printed gpiozero.__version__ here, that attribute does not exist on
    # all builds, and the resulting AttributeError got caught below and reported
    # as "cannot reach the GPIO chip" — a hard failure on a perfectly good Pi.
    try:
        Device.ensure_pin_factory()
        factory = type(Device.pin_factory).__name__
    except Exception as exc:
        fail(
            f"cannot reach the GPIO chip: {type(exc).__name__}: {exc}",
            "On a Pi 5 install the lgpio backend: sudo apt install -y python3-lgpio",
            "Then re-run with: GPIOZERO_PIN_FACTORY=lgpio python3 motor_test.py",
            "If you are not in the gpio group: sudo usermod -aG gpio $USER (then log out/in)",
        )

    # Everything below is diagnostic only, so each lookup is individually
    # tolerant — missing version info must never fail the hardware test.
    version = getattr(gpiozero, "__version__", "unknown")
    print(f"  gpiozero   : {version}")
    print(f"  pin factory: {factory}")

    model = ""
    try:
        board = Device.pin_factory.board_info
        model = str(board.model)
        print(f"  board      : Pi {model} (rev {board.revision})", flush=True)
    except Exception as exc:
        print(f"  board      : unknown ({type(exc).__name__})", flush=True)

    # A Pi 5 uses a different GPIO controller; the legacy RPi.GPIO backend cannot
    # drive it. Only assert this when the model was actually readable.
    if "RPiGPIO" in factory and model and "5" in model:
        fail(
            "this is a Pi 5 but gpiozero picked the RPi.GPIO backend, which cannot drive Pi 5 GPIO",
            "sudo apt install -y python3-lgpio",
            "export GPIOZERO_PIN_FACTORY=lgpio",
        )
    print("\n  ✓ GPIO is reachable", flush=True)


def step2_claim_pins():
    hr("2/4  Claiming the motor + sensor pins")
    from gpiozero import DigitalInputDevice, DigitalOutputDevice, Motor

    print(f"  motor RPWM={PIN_MOTOR_RPWM}  LPWM={PIN_MOTOR_LPWM}  EN={PIN_MOTOR_EN}")
    print(f"  sensors shelf={PIN_SHELF_SENSOR}  index={PIN_INDEX_SENSOR}  type={SENSOR_TYPE}", flush=True)

    # Track whatever we manage to claim, so a failure half-way through can release
    # the rest. Without this, a partial claim leaves pins held by this process and
    # the next run fails with a misleading "could not claim the pins".
    claimed = []
    try:
        motor = Motor(forward=PIN_MOTOR_RPWM, backward=PIN_MOTOR_LPWM, pwm=True)
        claimed.append(motor)
        enable = DigitalOutputDevice(PIN_MOTOR_EN, initial_value=False)
        claimed.append(enable)
        pull_up = SENSOR_TYPE.upper() == "NPN"
        shelf = DigitalInputDevice(PIN_SHELF_SENSOR, pull_up=pull_up)
        claimed.append(shelf)
        index = DigitalInputDevice(PIN_INDEX_SENSOR, pull_up=pull_up)
        claimed.append(index)
    except Exception as exc:
        for dev in claimed:
            try:
                dev.close()
            except Exception:
                pass
        fail(
            f"could not claim the pins: {type(exc).__name__}: {exc}",
            "Is the agent still running and holding them? sudo systemctl stop paternoster-agent",
            "Another process (or a second copy of this script) may own the pins.",
            f"A pin may be in use by another function (SPI/I2C) — check BCM {PIN_MOTOR_RPWM}/{PIN_MOTOR_LPWM}/{PIN_MOTOR_EN}.",
        )

    print("\n  ✓ All five pins claimed", flush=True)
    return motor, enable, shelf, index


def step3_sensors(shelf, index):
    hr("3/4  Sensors — turn the carousel BY HAND now")
    print("  Watching both sensors for 20 seconds.")
    print("  Rotate the carousel slowly by hand so shelves pass the sensors.")
    print("  (Ctrl-C to skip ahead.)\n", flush=True)

    shelf_seen = index_seen = 0
    last_s = shelf.is_active
    last_i = index.is_active
    print(f"  idle state: shelf={'ACTIVE' if last_s else 'idle'}  index={'ACTIVE' if last_i else 'idle'}", flush=True)

    end = time.time() + 20
    try:
        while time.time() < end:
            s, i = shelf.is_active, index.is_active
            if s != last_s:
                if s:
                    shelf_seen += 1
                    print(f"  SHELF  pulse #{shelf_seen}", flush=True)
                last_s = s
            if i != last_i:
                if i:
                    index_seen += 1
                    print(f"  INDEX  pulse #{index_seen}  <- this is home / shelf 1", flush=True)
                last_i = i
            time.sleep(0.005)
    except KeyboardInterrupt:
        print("  (skipped)", flush=True)

    print(f"\n  shelf pulses: {shelf_seen}    index pulses: {index_seen}", flush=True)
    if shelf_seen == 0 and index_seen == 0:
        print("\n  ! Neither sensor ever changed. Homing CANNOT work in this state —")
        print("    it will always fail with 'index sensor not found'.")
        print(f"    - SENSOR_TYPE is set to {SENSOR_TYPE}. If your sensors are the other")
        print("      kind, flip it in paternoster_agent.py (NPN <-> PNP).")
        print("    - Check sensor power (12/24 V) and that the signal reaches the Pi.")
        print(f"    - Verify the wiring really lands on BCM {PIN_SHELF_SENSOR}/{PIN_INDEX_SENSOR}.")
        print("    - PNP sensors need a level shifter; 12/24 V direct will kill the pin.", flush=True)
    else:
        print("\n  ✓ Sensors are responding", flush=True)


def step4_motor(motor, enable):
    hr("4/4  Motor — it should physically turn now")
    print("  Two short bursts at low speed. KEEP CLEAR of the carousel.")
    print("  Ctrl-C stops immediately.\n", flush=True)
    try:
        input("  Press Enter when ready (or Ctrl-C to abort)... ")
    except KeyboardInterrupt:
        print("\n  aborted", flush=True)
        return
    except EOFError:
        # No terminal attached (e.g. output piped into `tee`). Never spin a motor
        # nobody confirmed they were ready for.
        print("\n  no terminal attached — skipping the motor burst for safety.")
        print("  Run this directly in a shell to test the motor.", flush=True)
        return

    for label, run in (("FORWARD (down)", motor.forward), ("BACKWARD (up)", motor.backward)):
        print(f"\n  {label}: arming bridge, {BURST}s at {int(HOMING_SPEED * 100)}% duty", flush=True)
        enable.on()          # R_EN + L_EN high = bridge armed
        run(HOMING_SPEED)
        time.sleep(BURST)
        motor.stop()
        enable.off()         # disarm between directions
        print("  stopped.", flush=True)
        time.sleep(0.8)

    print("\n  Did the carousel physically move?")
    print("    YES -> the hardware is fine; the fault is in the agent/app layer.")
    print("    NO  -> the fault is electrical, not software. Check, in order:")
    print(f"      1. Bridge power: is the BTS7960 getting motor voltage? Is EN (BCM {PIN_MOTOR_EN}) wired?")
    print("      2. Common ground between the Pi and the driver board — the single most")
    print("         common cause. Without it the PWM signal has no reference and nothing moves.")
    print(f"      3. RPWM/LPWM really on BCM {PIN_MOTOR_RPWM}/{PIN_MOTOR_LPWM} (BCM numbers, not physical pin numbers).")
    print("      4. Motor leads to M+/M-, and the motor itself turns on direct power.", flush=True)


def main() -> None:
    print("PAX paternoster hardware test — nothing here touches the web app.", flush=True)
    step1_pin_factory()
    motor, enable, shelf, index = step2_claim_pins()
    try:
        step3_sensors(shelf, index)
        step4_motor(motor, enable)
    finally:
        # Always leave the hardware safe, even on Ctrl-C or an exception.
        try:
            motor.stop()
            enable.off()
        finally:
            for dev in (motor, enable, shelf, index):
                try:
                    dev.close()
                except Exception:
                    pass
        print("\n  bridge disarmed, pins released.", flush=True)
        print("  Restart the agent with: sudo systemctl start paternoster-agent", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted", flush=True)
