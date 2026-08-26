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
# 1. Copy this folder to the Pi (anywhere in your home dir), then:
cd ~/pi-agent
pip3 install -r requirements.txt

# 2. Run it (must match the shelves count you set for this unit in the app):
python3 paternoster_agent.py --name "Paternoster 1" --shelves 9 --port 8765
```

### Start automatically on boot

Use the installer — **don't copy the `.service` file by hand**:

```bash
sudo ./install.sh
# or: sudo ./install.sh --name "Unit 2" --shelves 12 --port 8766
journalctl -u paternoster-agent -f   # live logs
```

It detects your username and the real folder path, installs the dependencies,
selects the right pin factory for your Pi model, adds you to the `gpio` group,
and refuses to enable a unit that still has unfilled placeholders.

> **Why not `cp paternoster-agent.service`?** That is what these docs used to say,
> and the shipped unit hardcoded `User=pi` with `/home/pi/pi-agent`. Raspberry Pi
> OS no longer creates a `pi` user, so on a Pi whose user is anything else systemd
> fails with:
>
> ```
> Failed to determine user credentials: No such process
> Failed at step USER spawning /usr/bin/python3: No such process
> Main process exited, code=exited, status=217/USER
> ```
>
> The sibling failure is `status=200/CHDIR` — *"Changing to the requested working
> directory failed"* — which means `WorkingDirectory` points at a folder that does
> not exist, e.g. `/home/pi/pi-agent` when the agent really lives in
> `/home/raspberry/pax/pi-agent`.
>
> Either way the service crash-loops, nothing listens on 8765, and the app shows
> *"Connection refused"*. Re-running a plain `cp` silently restores the broken
> user and path, which is why a reinstall could make a previously working unit
> fail. `install.sh` fills in the real values, so this cannot recur.

### The journal shows only "Started …", nothing from the agent

Python block-buffers stdout when it is a pipe rather than a terminal, so under
systemd the agent's own lines can be withheld indefinitely. `journalctl -u
paternoster-agent | grep -i gpio` then matches only systemd's own `Started … PAX
paternoster GPIO agent.` lines — which looks like a dead agent even when it is
running perfectly. The unit sets `Environment=PYTHONUNBUFFERED=1` and the agent
flushes its startup lines, so `GPIO ready` (or the simulation warning) appears
immediately.

Rapidly repeating `Started` lines a few seconds apart are a crash loop, not a
healthy service. Check the real reason with:

```bash
systemctl status paternoster-agent --no-pager
journalctl -u paternoster-agent -n 40 --no-pager | grep -E "status=|Failed"
```

### Try it with no hardware

You can run the agent on a laptop or the Pi without any wiring — it fakes the
motor and sensors so you can test the app end to end:

```bash
python3 paternoster_agent.py --simulate --shelves 9 --port 8765
```

## Hardware test — start here when the carousel does not move

Before debugging the app, prove the hardware works. `motor_test.py` bypasses the
web app, the WebSocket and systemd entirely and drives the pins directly:

```bash
sudo systemctl stop paternoster-agent   # release the pins
cd ~/pax/pi-agent
python3 motor_test.py
```

It checks GPIO access, claims the pins, watches both sensors while you turn the
carousel by hand, then runs the motor in short low-speed bursts. It imports the
pin numbers and `SENSOR_TYPE` from `paternoster_agent.py`, so it tests the real
configuration rather than a copy that can drift out of sync.

This splits the problem in a single run:

- **Motor turns here** → the wiring is fine and the fault is in the agent/app layer.
- **Motor does not turn** → the fault is electrical, and no app-side fix will help.
  Check bridge power, then **common ground between Pi and driver** (the most common
  cause — without it the PWM signal has no reference), then the BCM pin numbers.

### "The app says it moved, but the carousel didn't"

If GPIO cannot be initialised, the agent falls back to that same simulator. It
still connects, still accepts commands and still reports smooth motion — the app
looks perfect while the motor pins stay idle. The connection is fine; the motion
is fake. Check the log:

```bash
journalctl -u paternoster-agent -n 30 --no-pager | grep -i simulation
```

`WARNING: GPIO IS UNAVAILABLE — RUNNING IN SIMULATION` confirms it, and the app
shows a red "Agent is simulating" banner in Manual Control with the reason.

The usual cause on a **Pi 5** is gpiozero's default pin factory (RPi.GPIO), which
does not support the Pi 5's new GPIO chip:

```bash
sudo apt install -y python3-lgpio
sudo systemctl edit paternoster-agent   # add: Environment=GPIOZERO_PIN_FACTORY=lgpio
sudo systemctl restart paternoster-agent
```

Other causes: `--simulate` left in the service's `ExecStart`, or the service user
missing from the `gpio` group (`sudo usermod -aG gpio <user>`).

To make this impossible to miss, add `--strict-gpio` to `ExecStart` on the real
unit. The agent then refuses to start rather than silently pretending, so the
failure is visible in `systemctl status` instead of looking like working hardware.

## Where the web app must run

**This is the most common cause of a stuck "offline" status.**

The browser never talks to the Pi directly. The app server holds a single
WebSocket to the agent and fans events out to every browser over SSE:

```
browser --SSE--> web app server --WebSocket--> Pi agent :8765
```

So **the machine that must reach the Pi is the app server**, not your phone or
laptop. A cloud-hosted app server (Vercel, or the v0 preview) has no route to a
private `192.168.x.x` address, so it can never connect no matter how healthy the
agent is — you get `offline` forever while `systemctl status` shows the agent
listening happily.

Run the app on the LAN. Simplest is on the Pi itself:

```bash
# on the Pi, in the repo root
pnpm install
pnpm build
# bind to all interfaces so other devices on the LAN can load the UI
pnpm start -- --hostname 0.0.0.0 --port 3000
```

Then browse to `http://<pi-ip>:3000` from any device, and set the unit's address
to `127.0.0.1` — the app server and the agent are now the same machine, so the
connection is local and always works. Any other always-on LAN machine (NAS,
mini-PC) works too; point it at the Pi's LAN IP instead.

No environment variables or database server are needed: state is kept in a local
SQLite file on the machine running the app. If the app reports a load error after
an update, rebuild the native module with `pnpm rebuild better-sqlite3`.

> **The v0 preview cannot drive hardware.** Its server runs in the cloud, so
> `127.0.0.1` there means the cloud sandbox — not your Pi — and there are no GPIO
> pins. Use the preview for UI work only; motors move only from an app server
> running on the Pi.

> Exposing the Pi to a cloud-hosted app server (Tailscale, Cloudflare Tunnel)
> also works, but the agent has **no authentication** — anyone who can reach the
> port can drive the motor. Don't do it without putting auth in front.

## Connect it in the app

1. Open the app → **Settings** → **Linked paternoster units**.
2. Either **Link another unit** and choose **Real Pi**, or on an existing unit
   press **Connect real Pi**.
3. Enter the Pi's **IP address / hostname** and the **agent port** (default 8765).
   Use `127.0.0.1` when the app runs on the Pi itself; otherwise find the Pi's IP
   with `hostname -I`, or use its `raspberrypi.local` name.
4. The unit's status chip turns **connecting → online** once the socket is up,
   then the app auto-homes it.

### Adding more units

Each unit stores its **own** address, and the app opens one independent socket per
unit. Addresses are always resolved **from the app server**, so `127.0.0.1` only
ever means "the machine running the web app":

| Unit | Address |
| --- | --- |
| The Pi running the web app | `127.0.0.1` |
| Every other Pi | its LAN IP, e.g. `192.168.1.51` |

There is no master/slave relationship in the protocol: the app server is the only
coordinator and every Pi is an equal peer running the same agent.

> Give the extra Pis a **static IP or DHCP reservation**. If an address changes on
> a router reboot, that unit goes offline until you re-enter it.

#### Installing an agent-only ("slave") Pi

`paternoster_agent.py` is **self-contained** — it imports only the Python standard
library plus `gpiozero` and `websockets`, and nothing from the rest of the repo. So
copy the `pi-agent/` folder and nothing else. You do **not** need Node.js, pnpm,
`node_modules/`, `app/`, `components/`, or `lib/` on this Pi.

Strictly, one file is mandatory (`paternoster_agent.py`); the other two just make
installation and autostart easier:

| File | Needed? | Why |
| --- | --- | --- |
| `paternoster_agent.py` | **required** | The whole agent |
| `requirements.txt` | recommended | So `pip3 install -r` gets the right versions |
| `paternoster-agent.service` | recommended | Starts on boot, restarts on crash |
| `README.md` | optional | Documentation only |

From your dev machine, copy just that folder:

```bash
scp -r pi-agent <user>@192.168.1.51:~/
```

Then on the slave Pi — the installer takes this unit's name and shelf count as
flags, so there is no unit file to hand-edit:

```bash
cd ~/pi-agent
sudo apt update && sudo apt install -y python3-pip
sudo ./install.sh --name "Paternoster 2" --shelves 12
```

Verify it's up and listening on **all** interfaces (`0.0.0.0`, which the agent
always binds — not just loopback):

```bash
systemctl status paternoster-agent
sudo ss -ltnp | grep 8765
```

Keep `--port 8765` on every unit. Since each Pi is a separate machine there's no
port conflict, and the app defaults to 8765 for new units. Finally, add the unit in
the app with **the slave's LAN IP** and wire its own BTS7960 + sensors exactly as
described above — each unit is independent hardware.

### If it stays offline

The widget now prints the actual reason underneath the status. Read it first:

| Message | Meaning | Fix |
| --- | --- | --- |
| Connection refused | Host reached, nothing on that port | Agent not running, or bound to `127.0.0.1` instead of `0.0.0.0`; check the port matches |
| Host unreachable | No network route from the app server | The app server isn't on the Pi's LAN — see the section above |
| Connection timed out | Packets dropped | Firewall (`sudo ufw allow 8765`), or wrong IP |
| Hostname could not be resolved | mDNS failed | Use the numeric IP instead of `*.local` |
| not a private address | Address rejected as non-LAN | The relay only permits private ranges; use the Pi's LAN IP |

Confirm the agent is actually listening on all interfaces:

```bash
sudo systemctl status paternoster-agent
sudo ss -ltnp | grep 8765     # want 0.0.0.0:8765, not 127.0.0.1:8765
```

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
