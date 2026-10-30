# PAX — Paternoster Filament Manager

A self-hosted web app for managing 3D-printer filament: spool inventory, a motorized
Paternoster carousel (Raspberry Pi), and live status for Klipper (Moonraker),
Prusa (PrusaLink), and Bambu Lab printers.

Everything you set up is stored in a **single local SQLite file** (`paternoster.db`) on
the machine that runs the app. There is **no external database and no required API key** to
run it. Any device on your network opens the app in a browser and shares the same data.

The server tracks filament usage **in the background** — as long as the app is
running it keeps polling your printers and deducting filament from the active spool, even
when no phone or computer has the app open. See [Background filament tracking](#background-filament-tracking).

---

## 1. Install

On a fresh Raspberry Pi OS (Bookworm or newer, Wi-Fi already set up by the imager) or
an always-on Debian/Ubuntu PC, run:

```bash
curl -fsSL https://raw.githubusercontent.com/Swede-maker/paternoster-filament-storage/main/setup.sh | sudo bash
```

It asks **what this device should be**. You need exactly one master; every
carousel beyond that is a slave.

| Choice | What gets installed | Address |
|---|---|---|
| **Master → PC** | Web app, database and slave sign-in. No motors, no GPIO, the PC's network is left alone. | You pick the hostname (default `pax-master.local`) |
| **Master → Raspberry Pi → no carousel** | Same as the PC server, plus the **PAX-Setup** hotspot if the router disappears. | `pax-master.local` |
| **Master → Raspberry Pi → with carousel** | Web app **and** this Pi drives one carousel, plus the hotspot fallback. | `pax-master.local` |
| **Slave** | Carousel agent only; signs in to the master. A Pi Zero 2 W is enough. | `pax-slave-<number>.local` |

For a carousel (master with carousel, or slave) it also asks **which motors** are
wired up and **how many shelves** the carousel has:

| Answer | Motors | Who makes the step pulses |
|---|---|---|
| `1` | **Integrated servos** — iSV57T or similar, drive built into the motor | An **ESP32** motor controller |
| `2` | **Closed-loop steppers** — CL57T / CL86Y or similar with a separate drive | An **ESP32** motor controller |
| `3` | **AC servos** — A6-RS or similar with a separate drive | An **ESP32** motor controller |
| `4` | **DC motors** — brushed motors on an H-bridge (L298N / BTS7960) | The Pi itself (PWM) |

For `1`, `2` and `3` it then asks **how the ESP32 is connected**: USB cable (default),
UART on GPIO14/15 (needs one reboot), or Wi-Fi (you enter its hostname). See
[ESP32 motor controller](#esp32-motor-controller-closed-loop-steppers-and-ac-servos).

A slave is additionally asked for its number, the master's hostname and,
optionally, the master's hotspot password (skip it if the master is a PC). Then it
installs everything — Node, the app as a service on port 80, the agent, mDNS,
hotspot, sudoers — without further questions. On a Pi with little RAM it enlarges
swap automatically so the build fits.

When it finishes it prints the app's address and, for a Raspberry Pi master, the
hotspot password — write that down.

### Updating

**In the app: Settings → Update.** It checks GitHub, lists the new changes and has
an **Update now** button. It downloads the newest code, rebuilds and restarts the
app (5–15 minutes on a Pi 4) and shows the progress log; the page reconnects by
itself when the app is back.

**Over SSH:**

```bash
curl -fsSL https://raw.githubusercontent.com/Swede-maker/paternoster-filament-storage/main/setup.sh | sudo bash -s -- --update
```

It asks nothing: it pulls the newest code, backs up the database, rebuilds and
restarts with your saved setup. On a device where PAX is not installed yet it stops
instead of installing.

Running the plain install command again on an installed device shows what is
installed and offers to:

- **Update** — newest code, same setup, no questions.
- **Wire a carousel to this computer** (on a master without carousel) — only asks the motor questions.
- **Change the motor type** (on a master with carousel or a slave).
- **Reconfigure** — asks everything again.

### Your data

Nothing above touches your data. It lives outside the code checkout:

| File | Contents |
|---|---|
| `/var/lib/pax/paternoster.db` | Filaments, shelves, storage units, printers, history |
| `/var/lib/pax-agent/motor.json` | Motor tuning |
| `/etc/paxnet.conf` | Hotspot name and password |
| `/etc/pax-install.conf` | Your installer answers |

A timestamped copy of the database is made in `/var/lib/pax/backups` before every
update (the five newest are kept).

### Scripted installs

```bash
sudo ./setup.sh --role server
sudo ./setup.sh --role pi-server
sudo ./setup.sh --role master --motor servo --shelves 9
sudo ./setup.sh --role master --pulse-drive closed-loop-stepper --esp32-link usb --shelves 9
sudo ./setup.sh --role slave --motor dc --number 1 --shelves 9 --master pax-master.local
```

`sudo ./setup.sh --help` lists every flag.

---

## 2. First run

On first launch you'll see **"Set up your storage"** — pick your storage type, name it,
and click **Build machine**. From then on, all your printers, spools, usage totals, and
history are saved automatically.

For a motorised carousel the wizard also asks for the **Motor drive**:

| Option | Hardware | What the Pi agent does |
| --- | --- | --- |
| **Standard DC motors** (default) | Two brushed DC motors — one per chain, one on each side — each on its own BTS7960 / IBT-2 bridge | Same PWM duty on both bridges in lockstep, soft start, run/stop, per-motor **timed jog** (milliseconds) for chain alignment |
| **Integrated servo motors (PUL/DIR)** | Two StepperOnline **iSV57T** servos (e.g. iSV57T-090(S)) | Pulse/direction on both motors in lockstep, speed by pulse frequency, per-motor **micro-jog** (exact pulses) for chain alignment, drive alarm lamps |
| **Closed-loop stepper (PUL/DIR)** | Two closed-loop steppers on separate drives (StepperOnline **CL57T / CL86Y** or similar) + an **ESP32** | Same as servos, but the pulses come from the ESP32. Calibrate measures pulses per turn and the home flag, and zeroes on the flag's middle |
| **AC servo (PUL/DIR)** | Two AC servos on separate drives (StepperOnline **A6-RS** or similar) + an **ESP32** | Same as closed-loop steppers |

Every carousel has two motors; the drive option only decides *what kind*. The
choice is saved with the unit and pushed to the agent, which persists it and
boots straight into the matching control logic. You can change it later under
**Settings → Hardware → Motor drive**, together with motor-B mirroring, the servo
pulses/rev and top pulse rate, and the jog step size (ms or pulses). The
pin-by-pin wiring is in [GPIO wiring](#gpio-wiring) below; deeper background is in
[`pi-agent/README.md`](pi-agent/README.md#hardware).

---

## GPIO wiring

> Using an **ESP32** as a slave controller instead of a Pi? Its pins and setup
> are in [`esp32-agent/README.md`](esp32-agent/README.md).

All numbers are **BCM GPIO numbers** (what `pinout` prints as `GPIOxx`), not the
physical header pin positions. The pins are set as constants at the top of
`pi-agent/paternoster_agent.py` if you need to move one.

**Three rules before you plug anything in:**

1. **Common ground.** The Pi's GND, every motor driver's GND, the servo supply's
   minus and every sensor's minus must all be connected together.
2. **Never feed more than 3.3 V into a GPIO.** Sensors on 12–24 V need an
   NPN/open-collector output (or an opto board) so the Pi only ever sees its own
   3.3 V pull-up.
3. **Motors get their own power supply**, never the Pi's 5 V pin.

### Sensors

| Sensor | Normal carousel / twin **Left** | Twin **Right** | Wire |
| --- | --- | --- | --- |
| Shelf sensor (one pulse per shelf) | **GPIO 23** | **GPIO 19** | Signal → GPIO, brown (+) → sensor supply, blue (−) → GND |
| Home / index sensor (only at shelf 1) | **GPIO 24** | **GPIO 4** | Signal → GPIO, brown (+) → sensor supply, blue (−) → GND |

Use **NPN (sinking) inductive sensors**: the agent turns on the Pi's internal
pull-up, so the input reads HIGH when idle and the sensor pulls it to GND when
metal is in front of it. If the lamp in the app is lit when nothing is there,
the sensor is the opposite type; set `SENSOR_INVERT` at the top of the agent.

**Servo carousels can skip the shelf sensor.** Choose *Settings → Hardware →
Motor drive → Positioning → **Home only***, wire just the home sensor, and run
**Calibrate** once. The agent measures one full turn in servo pulses and spaces
the shelves evenly from home; every pass of the home flag corrects the position.
Leave GPIO 23 (or 19) unconnected. Until calibrated, shelf moves are refused,
but jogging and **Home** still work. DC motors always need the shelf sensor,
because they have no pulse count to measure distance with.

### Standard DC motors (two BTS7960 / IBT-2 bridges)

| Bridge pin | Bridge **A** (motor A) | Bridge **B** (motor B) |
| --- | --- | --- |
| RPWM | **GPIO 12** | **GPIO 20** |
| LPWM | **GPIO 13** | **GPIO 21** |
| R_EN + L_EN (tie both together) | **GPIO 22** | **GPIO 27** |
| VCC | Pi **3.3 V** (not 5 V) | Pi **3.3 V** |
| GND | Pi GND | Pi GND |
| R_IS / L_IS | leave unconnected | leave unconnected |
| B+ / B− (screw terminals) | motor power supply | motor power supply |
| M+ / M− (screw terminals) | motor A | motor B |

### Integrated servo motors (two iSV57T on PUL/DIR)

The iSV57T inputs want 5 V, so **PUL and DIR go through a 74AHCT125 (or
74HCT245) level shifter** powered from the Pi's 5 V pin. Tie its `/OE` pins to
GND.

| Pi | Through | Motor **A** | Motor **B** |
| --- | --- | --- | --- |
| **GPIO 12** | shifter 1A → 1Y | PUL+ | — |
| **GPIO 13** | shifter 2A → 2Y | — | PUL+ |
| **GPIO 5** | shifter 3A → 3Y | DIR+ | — |
| **GPIO 6** | shifter 4A → 4Y | — | DIR+ |
| **GPIO 16** | direct | ALM+ | — |
| **GPIO 26** | direct | — | ALM+ |
| **GPIO 17** *(optional)* | relay IN | relay in +Vdc lead | — |
| **GPIO 25** *(optional)* | relay IN | — | relay in +Vdc lead |
| **GND** | shifter GND + `/OE` | PUL−, DIR−, ALM− | PUL−, DIR−, ALM− |
| **5 V** | shifter VCC | — | — |

Servo power: `VDC` → +24…36 V, `GND` → supply minus, and supply minus → Pi GND.
The relays on GPIO 17/25 are only needed for the *Release* button / idle release;
without them, leave *Release servos after idle* on **Always on**.

### ESP32 motor controller (closed-loop steppers and AC servos)

Closed-loop steppers and AC servos are pulsed by an **ESP32 DevKit** that sits
between the Pi and the two drives. The Pi still makes every decision (which
shelf, speed, ramps, homing, calibration); the ESP32 only does the timing Linux
cannot do reliably: both pulse trains from one hardware timer, the shelf and home
sensors on interrupts, and an instant stop on the flag.

1. **Flash** `pi-agent/esp32-servo` onto the ESP32 (`cd pi-agent/esp32-servo && pio run -t upload`).
   One firmware covers closed-loop steppers, AC servos and integrated servos; the Pi
   tells it which drive is wired.
2. **Wire the drives and both sensors to the ESP32**, not to the Pi. In this setup
   the Pi's motor and sensor pins above are not used.
3. **Connect it to the Pi:** USB cable, UART (GPIO14 → ESP32 GPIO21, GPIO15 ← ESP32
   GPIO22, GND), or Wi-Fi. The installer asks which.

Pins, drive wiring (PUL / DIR / ENA / ALM) and the Wi-Fi option are in
[`pi-agent/esp32-servo/README.md`](pi-agent/esp32-servo/README.md).

> **Not the same as the ESP32 slave.** [`esp32-agent`](esp32-agent/README.md) is a
> different firmware that turns an ESP32 into a complete slave carousel with no Pi
> of its own (DC motors or integrated servos). `esp32-servo` is the motor controller
> for a Pi.

### Twin carousels (one Pi, two carousels)

After **Split into twin**, motor A drives the **Left** carousel and motor B the
**Right** one, on exactly the motor pins above. Each side needs its own sensors:

| | Left (motor A) | Right (motor B) |
| --- | --- | --- |
| Shelf sensor | GPIO 23 | GPIO 19 *(not needed with Home only)* |
| Home sensor | GPIO 24 | GPIO 4 |

If one side runs the wrong way, use **Reverse motor A/B direction** on that unit
instead of rewiring.

### Checking the wiring

After installing, open *Manual control*: the sensor lamps should light as you pass
a piece of metal in front of each sensor, and the jog arrows should turn each
motor. The agent also prints the pins it is using for every carousel at start-up
(`journalctl -u paternoster-agent -f` over SSH).

---

## Background filament tracking

Filament consumption is tracked by the **server**, not the browser. When the app starts,
it launches a background poller (every 5 seconds) that connects to each linked printer
over your LAN — Klipper (Moonraker), Prusa (PrusaLink), and Bambu Lab — and subtracts the
filament used from the spool that is currently printing.

- **You do not need the app open** on any phone or computer for weights to update.
- **A sleeping or powered-off viewing device does not stop tracking.** Only the printer
  needs to be reachable for its own consumption to be recorded.
- When a printer is **off or unreachable**, tracking resumes automatically the next time
  it comes online (usage counters are cumulative, so no data is lost).
- Any browser you open will catch up to the server's totals within a few seconds.

There is nothing to configure — it starts on its own with the app.

---

## 3. Troubleshooting

**Logs.** Over SSH: `journalctl -u pax-app -f` (web app) and
`journalctl -u paternoster-agent -f` (carousel agent / slave sign-in).

**It shows the setup screen again after an update, or "Could not load your data".**
The compiled SQLite module got out of sync with your Node version. Run the update
command above, or rebuild just the module:

```bash
cd ~/pax && pnpm rebuild better-sqlite3 && sudo systemctl restart pax-app
```

Your data is safe — this only rebuilds the module.

**Another device can't reach it.**
Use the `.local` address or the machine's LAN IP (not `localhost`), and make sure its
firewall allows port 80.

**A printer shows "Not reachable".**
Confirm the printer's IP is correct and that the machine running PAX is on the same
network. Klipper needs Moonraker; Prusa needs PrusaLink enabled on the printer.

**The carousel stops randomly or "ESP32 not answering".**
Only one agent may run. Restart it with `sudo systemctl restart paternoster-agent`
and never start `paternoster_agent.py` by hand or under PM2 as well.
