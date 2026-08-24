# PAX Paternoster — Raspberry Pi agent

This folder contains the program that runs **on a Raspberry Pi** to drive one
physical paternoster carousel and connect it to the PAX web app.

- The **web app** is the UI + coordinator. It never touches GPIO directly.
- The **Pi agent** (`paternoster_agent.py`) owns the motor and sensors, runs the
  homing + move logic, and reports the true position back over WebSocket.
- One agent runs per unit. Link several units in the app (one master, the rest
  slaves) and they act as one combined storage pool.

```
[ Browser / PAX app ]  --WebSocket-->  [ Pi agent ]  --GPIO-->  DC motor + 2 sensors
```

## Hardware

Each carousel uses:

| Part                       | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| DC motor                   | Rotates the carousel.                              |
| BTS7960 / IBT-2 43A        | Half-bridge driver. **Dual PWM**: RPWM vs LPWM picks direction. |
| Inductive **shelf** sensor | Pulses once as **every** shelf passes the window.  |
| Inductive **index** sensor | Active **only at shelf 1** — the home reference.   |

### Default wiring (BCM pin numbers)

Edit the constants at the top of `paternoster_agent.py` to match your board.

| BTS7960 pin  | Pin (BCM) | Notes                                          |
| ------------ | --------- | ---------------------------------------------- |
| RPWM         | GPIO 12   | PWM — drives one direction                     |
| LPWM         | GPIO 13   | PWM — drives the other direction               |
| R_EN + L_EN  | GPIO 22   | **Tie both to this one pin.** HIGH = armed     |
| VCC          | 3.3 V     | Logic supply — **not** 5 V (see below)         |
| GND          | any GND   | **Common ground** Pi ↔ driver ↔ sensors        |
| R_IS / L_IS  | *unused*  | Current-sense outputs, leave disconnected      |
| Shelf sensor | GPIO 23   | One pulse per shelf                            |
| Index sensor | GPIO 24   | Active only at shelf 1                         |

The screw terminals carry the power side: **B+ / B−** to your motor supply
(with the big cap already on-board), **M+ / M−** to the motor. Swap M+/M− if the
carousel runs the wrong way, or just flip `HOMING_DIRECTION`.

**Key points for this board:**

- **Never drive RPWM and LPWM high at the same time** — that shoots through the
  bridge. The code uses gpiozero's `Motor` without an `enable` argument, which
  guarantees only one of the two is ever given a duty cycle.
- **Power VCC from 3.3 V, not 5 V.** The BTS7960's inputs are happy at 3.3 V
  logic, and feeding VCC 5 V can make the on-board logic pull the input pins
  above the Pi's 3.3 V limit.
- GPIO 12/13 are the Pi's **hardware PWM** channels. For jitter-free speed
  control install `pigpio` (`sudo apt install pigpio && sudo systemctl enable
  --now pigpiod`) and export `GPIOZERO_PIN_FACTORY=pigpio`; otherwise gpiozero
  falls back to software PWM, which can make the motor buzz.
- Pulling **EN low is a hardware stop** — the outputs float regardless of the PWM
  state. That's why `stop()` zeroes the PWM and then disarms EN.

> Power the motor from its **own supply**, not the Pi's 5V rail. Tie all grounds
> together — the Pi's GND *must* be common with the driver's GND or the PWM
> signals have no reference and the motor behaves erratically.

### Sensor type: NPN vs PNP

Set `SENSOR_TYPE` at the top of `paternoster_agent.py`. It defaults to `"NPN"`.
Get this wrong and the sensors read as permanently inactive — homing spins until
it faults with *"index sensor not found"*.

| | Idle | Shelf detected | Pi input | Extra parts |
| --- | --- | --- | --- | --- |
| **NPN** (sinking, active-LOW) | open | pulls to **GND** | pull-**up** | none |
| **PNP** (sourcing, active-HIGH) | open | sources **+V** | pull-**down** | level shifter / divider |

**NPN is the recommended choice for a Raspberry Pi.** The sensor only ever pulls
the line to GND, so with a pull-up to 3.3 V the GPIO sees 3.3 V or 0 V and never
the sensor's 12/24 V supply — even though the sensor itself is powered from that
higher rail.

A 3-wire NPN sensor wires up as: brown → +12/24 V, blue → **common GND**,
black (signal) → the GPIO. The Pi's internal pull-up is weak (~50 kΩ), so on long
cable runs near a motor add an external **4.7 kΩ–10 kΩ pull-up to 3.3 V** on the
signal line to keep inductive noise from causing phantom shelf pulses.

> With **PNP** you must add a level shifter or divider, or the sensor will feed
> 12/24 V straight into a 3.3 V GPIO and destroy the Pi.

## How motion works

- **Homing**: the motor turns until the **index** sensor triggers (shelf 1), then
  stops. Position is now known = shelf 0. If it can't find the index within
  `HOME_TIMEOUT`, it reports a `fault`.
- **Goto shelf N**: the agent picks the shorter direction around the loop and
  counts **shelf**-sensor pulses until it reaches N, emitting a `pos` event at
  each pulse and an `arrived` event when it stops. A missing pulse within
  `PULSE_TIMEOUT` reports a `fault` (jam / sensor failure) and stops the motor.

Tune `HOMING_SPEED`, `MOVE_SPEED`, and the timeouts at the top of the script.
If the carousel moves the opposite way from the app's up/down labels, flip
`HOMING_DIRECTION`.

## Install & run on the Pi

```bash
# 1. Copy this folder to the Pi (e.g. /home/pi/pi-agent) and install deps:
cd /home/pi/pi-agent
pip3 install -r requirements.txt

# 2. Run it (must match the shelves count you set for this unit in the app):
python3 paternoster_agent.py --name "Paternoster 1" --shelves 9 --port 8765
```

### Start automatically on boot

```bash
sudo cp paternoster-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now paternoster-agent
journalctl -u paternoster-agent -f   # live logs
```

### Try it with no hardware

You can run the agent on a laptop or the Pi without any wiring — it fakes the
motor and sensors so you can test the app end to end:

```bash
python3 paternoster_agent.py --simulate --shelves 9 --port 8765
```

## Connect it in the app

1. Open the app → **Settings** → **Linked paternoster units**.
2. Either **Link another unit** and choose **Real Pi**, or on an existing unit
   press **Connect real Pi**.
3. Enter the Pi's **IP address / hostname** and the **agent port** (default 8765).
   Find the Pi's IP with `hostname -I` on the Pi, or use its `raspberrypi.local`
   name.
4. The unit's status chip turns **connecting → online** once the socket is up,
   then the app auto-homes it. If it shows **offline**, check the agent is
   running and the IP/port are reachable (`ping`, firewall).

## Wire protocol

The agent and app exchange newline-free JSON messages. This mirrors
`lib/node-protocol.ts` in the web app — keep the two in sync if you extend it.

**App → Pi**

| Message                              | Meaning                          |
| ------------------------------------ | -------------------------------- |
| `{"type":"hello"}`                   | Handshake request                |
| `{"type":"config","shelves":N}`      | Tell the agent the shelf count   |
| `{"type":"home"}`                    | Start homing                     |
| `{"type":"goto","shelf":N}`          | Rotate to shelf N (0-based)      |
| `{"type":"stop"}`                    | Emergency stop                   |

**Pi → App**

| Message                                             | Meaning                         |
| --------------------------------------------------- | ------------------------------- |
| `{"type":"hello","name":...,"shelves":N,"homed":b}` | Handshake reply                 |
| `{"type":"state","status":...,"shelf":N,"homed":b}` | Full state snapshot             |
| `{"type":"pos","shelf":N}`                          | Passed a shelf (live position)  |
| `{"type":"arrived","shelf":N}`                      | Stopped at shelf N              |
| `{"type":"homed","shelf":0}`                        | Homing finished                 |
| `{"type":"fault","message":...}`                    | Jam / timeout / sensor error    |

Shelf indexes are **0-based** on the wire (shelf 0 = the index-sensor position),
matching the app's internal representation.
