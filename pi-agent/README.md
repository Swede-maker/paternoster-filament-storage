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

| Part                     | Purpose                                             |
| ------------------------ | --------------------------------------------------- |
| DC motor + H-bridge      | Rotates the carousel. PWM on ENABLE sets the speed. |
| H-bridge (L298N / TB6612)| Direction + speed driver between the Pi and motor.  |
| Inductive **shelf** sensor | Pulses once as **every** shelf passes the window. |
| Inductive **index** sensor | Active **only at shelf 1** — the home reference.  |

### Default wiring (BCM pin numbers)

Edit the constants at the top of `paternoster_agent.py` to match your board.

| Signal              | Pin (BCM) | Notes                                  |
| ------------------- | --------- | -------------------------------------- |
| Motor IN1 (dir)     | GPIO 17   | H-bridge input 1                       |
| Motor IN2 (dir)     | GPIO 27   | H-bridge input 2                       |
| Motor ENABLE (PWM)  | GPIO 22   | H-bridge enable — PWM speed control    |
| Shelf sensor        | GPIO 23   | One pulse per shelf                    |
| Index sensor        | GPIO 24   | Active only at shelf 1                 |
| GND                 | any GND   | **Common ground** Pi ↔ H-bridge ↔ sensors |

> Power the motor from its **own supply**, not the Pi's 5V rail. Tie all grounds
> together. Inductive sensors are often 6–36 V — use a **level shifter or divider**
> so their output never exceeds 3.3 V into a Pi GPIO.

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
