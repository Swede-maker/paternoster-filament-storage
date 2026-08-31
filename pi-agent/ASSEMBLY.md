# Assembly & first-boot checklist

Follow this end to end when your parts arrive. It gets one paternoster from a
bare Pi to a carousel the app drives. Deep detail (wiring rationale, motion
tuning, failure analysis) lives in [`README.md`](./README.md) — this is the
happy-path sequence with pointers.

The split never changes: the **app** is UI + coordinator and never touches GPIO;
the **Pi agent** owns the motor and sensors. The app reaches the agent through
its own server, so the machine running the app must be on the **same LAN** as the
Pi. The v0 preview / any cloud host cannot drive real pins.

---

## 1. Wire the hardware

Follow **README → "Default wiring (BCM pin numbers)"** and **"Sensor wiring"**.
Summary, all BCM numbering:

| Signal            | Pin      | Notes                                   |
| ----------------- | -------- | --------------------------------------- |
| Motor RPWM        | GPIO 12  | hardware PWM, one direction             |
| Motor LPWM        | GPIO 13  | hardware PWM, other direction           |
| Motor R_EN + L_EN | GPIO 22  | tie both together; HIGH = armed         |
| Shelf sensor      | GPIO 23  | one pulse per shelf                     |
| Index sensor      | GPIO 24  | active only at shelf 1 (home reference) |
| GND               | any GND  | **common ground** Pi ↔ driver ↔ sensors |

Non-negotiables from the README:

- Motor runs from its **own supply** (B+/B−), never the Pi's 5 V rail. Tie all
  grounds together or motion is erratic.
- Use **NPN** inductive sensors with a pull-up to 3.3 V. **PNP needs a level
  shifter** or it feeds 12/24 V into a 3.3 V GPIO and destroys the Pi.
- Do not connect the driver's VCC logic pin to 5 V (see README note).

## 2. Prove the wiring before any software

```bash
sudo systemctl stop paternoster-agent 2>/dev/null   # release pins if re-running
python3 motor_test.py
```

Only the `✓ GPIO is reachable` line decides pass/fail. It watches both sensors as
you turn the carousel by hand, then bursts the motor. Fix wiring here — not in the
app. Detail: **README → "Bench-test the motor and sensors first"**.

## 3. Give the Pi a stable name

The app links to the Pi by **hostname**, not IP, so DHCP changing the address
never matters. Set a unique hostname per Pi when imaging (Raspberry Pi Imager →
advanced options) or:

```bash
sudo raspi-config    # System Options → Hostname, e.g. workshop-hardware
```

It is then reachable at `workshop-hardware.local` (mDNS/avahi, on by default in
Raspberry Pi OS). Verify from the app machine:

```bash
ping workshop-hardware.local
```

## 4. Install the agent

Copy this `pi-agent/` folder to the Pi, then:

```bash
cd ~/pi-agent
sudo ./install.sh --name "Workshop Hardware" --shelves 9 --port 8765
```

`--shelves` **must match** the shelf count set for that unit in the app. Use a
unique `--port` only if two agents share one Pi; on separate Pis keep 8765. The
installer adds Python deps, picks the correct pin factory (adds `lgpio` on a Pi
5), joins the `gpio` group, and enables a systemd service that starts on boot.

Verify it is driving real GPIO (not faking it):

```bash
journalctl -u paternoster-agent -n 20 --no-pager | grep -i -e gpio -e simulation
```

You want `GPIO ready`. `WARNING: GPIO IS UNAVAILABLE — RUNNING IN SIMULATION`
means pins failed to init — see **README → "The agent connects but the motor
never moves"** (usual Pi 5 cause: pin factory).

## 5. Link it in the app

Run the app on a machine on the same LAN (`pnpm start`, not the cloud preview).
Then in the app: **Hardware → Settings → the unit → Link → Real Pi tab**, enter:

- **Hostname**: `workshop-hardware.local` (pre-filled from the unit name — adjust
  to match the hostname you set in step 3)
- **Agent port**: the `--port` from step 4 (default 8765)

Press **Connect**. The status dot goes green (**Connected to Pi agent**) once the
server reaches the agent. If it shows a "faking motion" warning, the agent is
simulating — go back to step 4's verification.

Use **Reconnect** to retry without editing the address, and **Unlink** to drop
back to simulation.

## 6. Master / slave and filament

Master/slave and filament-vs-hardware are **app-side labels only** — every
physical carousel runs this identical agent. So a filament paternoster slave is
installed and linked exactly the same way; nothing here differs. Promote any unit
with **Make master**; the others become its slaves regardless of whether they
hold filament or hardware.

---

## Troubleshooting quick table

| Symptom                                    | Look at                                                        |
| ------------------------------------------ | -------------------------------------------------------------- |
| `motor_test.py` can't reach GPIO           | Wiring + `gpio` group; README → "Bench-test …"                 |
| Agent logs the SIMULATION warning          | README → "The agent connects but the motor never moves"        |
| App status stuck "Offline"                 | App machine not on the Pi's LAN, wrong hostname/port, firewall |
| App status "Connecting…" then offline      | Agent service not running: `systemctl status paternoster-agent`|
| Homing faults "index sensor not found"     | Index sensor on GPIO 24 / NPN wiring; README → "Sensor wiring" |
| Motor buzzes / jitters                     | Enable pigpio pin factory; README → wiring notes               |
| `.local` name won't resolve                | avahi/mDNS; try the Pi's numeric IP to confirm reachability    |
