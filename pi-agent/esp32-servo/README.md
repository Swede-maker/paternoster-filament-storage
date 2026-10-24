# PAX motor controller — ESP32 + two pulse/direction drives

An ESP32 DevKit sits between the Raspberry Pi and two PUL/DIR drives. **One
firmware covers every drive type**; the Pi tells the board which one is wired
at runtime (`CFG profile=…`), so you never rebuild it when you change drives:

| profile | drives | enable input | ALM output | max pulse rate |
| --- | --- | --- | --- | --- |
| `ac-servo` | StepperOnline A6-RS (DB44) | S-ON | conducts while healthy | 300 kHz |
| `integrated-servo` | iSV57T-class (drive in the motor) | none — optional supply relay | conducts while healthy | 300 kHz |
| `closed-loop-stepper` | StepperOnline CL86Y, CL57T and similar | MF (motor free) | conducts **on a fault** | 200 kHz |

Pick the profile in the app under *Settings → Motor drive* (the three cards
under "Closed-loop stepper or servo"), or with `install.sh --pulse-drive …`.

The Pi (`paternoster_agent.py`, motor controller **ESP32**) still makes every
decision — which shelf, how fast, ramps, timeouts, chain sync. The ESP32 only
does what Linux cannot do on time:

- generates both PUL trains from **one** hardware timer (both chains in phase);
- reads the **shelf** and **home** sensors with interrupts and reports every
  edge with a microsecond timestamp;
- can be **armed** to cut the pulses itself on the next shelf flag, so the
  stop never waits for a serial round trip;
- sends exact pulse counts for jogs, pauses one motor for chain sync;
- watches both **ALM** outputs and stops everything if the Pi goes quiet.

Firmware: `src/main.cpp` (Arduino framework, PlatformIO project).

---

## 1. Flash the firmware

```bash
cd pi-agent/esp32-servo
pio run -t upload                 # ESP32 on a USB cable to this computer
pio device monitor -b 460800      # type HELLO + Enter -> "HELLO pax-esp32 fw=1.1 profile=ac-servo ..."
```

Arduino IDE instead: copy `src/main.cpp` to `pax_esp32/pax_esp32.ino`, board
**ESP32 Dev Module**, upload speed 921600. The same binary serves AC servos,
integrated servos and closed-loop steppers — the drive profile is **not** a
build option. The two build options at the top of `platformio.ini` are:

| flag | default | meaning |
| --- | --- | --- |
| `PAX_LINK_BAUD` | `460800` | serial speed on both link ports; must match **Baud** in the app |
| `PAX_ENA_LOW` | `0` | force "GPIO LOW engages" on every profile. Normally leave it and use the app's *Signal polarity* box instead |

The on-board LED is **steady** while the Pi is talking to the board and
**blinks** when it is not.

---

## 2. Connect the ESP32 to the Pi

Pick one in the app (*Settings → Motor drive → Servo controller → Link to
the Pi*) or with `install.sh --esp32-link usb|uart|wifi`. The firmware
listens on all ports at once, so the choice is purely on the Pi side.

### USB cable (default)

Micro-USB on the DevKit to any Pi USB port. This also powers the ESP32. The
Pi sees `/dev/ttyUSB0` (CP2102 / CH340 boards) or `/dev/ttyACM0`; the agent
auto-detects via `/dev/serial/by-id`. Only fill in **Serial device** if you
have several USB-serial adapters plugged in.

Opening the port resets the board (DTR), which is why the link takes about a
second to come up after the agent starts. That is normal.

### UART on the GPIO header

Three wires, all 3.3 V — no level shifter needed:

| Pi header | | ESP32 |
| --- | --- | --- |
| GPIO14 TXD (pin 8) | → | GPIO21 (RX) |
| GPIO15 RXD (pin 10) | ← | GPIO22 (TX) |
| GND (pin 6) | — | GND |

Power the ESP32 from the Pi's 5 V (pin 2/4) to **VIN**, or from its own USB
supply. Run `sudo ./install.sh --esp32-link uart` once or `cd /pax/pi-agent`  `sudo bash install.sh --esp32-link uart`: it frees the UART
from the login console, enables it (`/dev/serial0`) and, on Pi 3/4/Zero W,
moves the full UART back to GPIO14/15. **Reboot afterwards.**

### Wi-Fi — a carousel with no Pi at all (fw 1.2+)

The board can run **standalone**: it joins your Wi-Fi and serves the same
line protocol on TCP port 8766. A second copy of the agent runs on the
**master Pi** and drives it across the network, so every decision (shelves,
ramps, homing, pairing with the app) still lives in `paternoster_agent.py`.
Wire motors and sensors to the ESP32 exactly as in section 3; power it from
any 5 V USB supply.

**Give it credentials once** over the USB console (`pio device monitor`):

```
WIFI MyRouter supersecret        -> OK WIFI MyRouter            (router)
WIFIAP PAX-Setup-1A2B hotspotpw  -> OK WIFIAP PAX-Setup-1A2B    (master hotspot, fallback)
NET                              -> NET state=router ssid=MyRouter ip=192.168.1.42 rssi=-58 host=pax-esp32-1a2b ...
```

The master's hotspot name and password are printed at the end of its
`install.sh` run (also under *Settings → Network*). Boot logic mirrors the Pi
slaves: router first, after 45 s without it the board joins the master's
hotspot, and while on the hotspot it retries the router every 60 s (never
while the master is actually driving it). From now on the **master pushes
new credentials itself** whenever you save a router in the app — the board
registers with it like any slave — so the USB cable is only for the first
flash.

**Install the agent for it on the master Pi:**

```bash
sudo ./install.sh --instance hall-2 --name "Hall 2" --shelves 12 \
     --pulse-drive ac-servo --esp32-link wifi --esp32-host pax-esp32-1a2b.local
```

That creates `paternoster-agent-hall-2.service` on port 8767 with its own
`motor.json`. Add `ws://pax-master.local:8767` as the carousel's address in
the app (or "Add as carousel" from the master's slaves list, where the
board shows up tagged **ESP32**). Several boards = several `--instance`
runs with different names and ports.

**Firmware updates over the air.** After the first USB flash you never need
the cable again:

* Browser: open `http://pax-esp32-1a2b.local/`, upload
  `.pio/build/esp32dev/firmware.bin` (user `admin`, password `pax-esp32`
  unless you changed it with `OTAPASS`). Motors are held off during the
  upload and the board reboots into the new image; a failed upload keeps
  the old one (two app partitions).
* PlatformIO: `pio run -t upload --upload-port pax-esp32-1a2b.local
  --upload-protocol espota` with `--upload-flags --auth=pax-esp32`.

Other console commands: `HOSTNAME <name>` (mDNS name, after `REBOOT`),
`WIFI 0` / `WIFIAP 0` to forget, `OTAPASS <pw>`, `REBOOT`. The on-board LED
is steady once a master is connected and blinks while it waits for one.
Over Wi-Fi the silence watchdog is 3 s instead of 1.5 s (`CFG wd_ms=`),
which the agent sets automatically.

---

## 3. Wire the ESP32 to the A6-RS drives (CN1, DB44)

Two drives, one board. Motor **A** and motor **B** have identical hookups on
different ESP32 pins. The A6-RS low-speed pulse input is a **5 V** input and
the digital inputs (S-ON) are **24 V** inputs, so there are two small
interface parts you must not skip:

- a **74HCT125** (or 74HCT245) — one 5 V buffer for the four PUL/DIR lines.
  Powered from the DevKit's 5 V pin, HCT inputs read the ESP32's 3.3 V as HIGH
  and the outputs are the clean 5 V the opto inputs want. Driving pins 41/37
  straight from 3.3 V works on some units and not on others; don't.
- a **ULN2003** (or two 2N2222 + 1 kΩ base resistors) to sink the 24 V
  **S-ON** inputs. Never connect an ESP32 pin to S-ON directly.

### Pulse / direction (5 V differential, via 74HCT125)

| signal | ESP32 (motor A) | ESP32 (motor B) | → HCT buffer → | A6-RS CN1 |
| --- | --- | --- | --- | --- |
| PUL | GPIO25 | GPIO32 | buffer out | **41** PULS+ |
| PUL return | | | | **43** PULS− → GND of the buffer |
| DIR | GPIO26 | GPIO33 | buffer out | **37** SIGN+ |
| DIR return | | | | **39** SIGN− → GND of the buffer |

Keep the buffer's GND, the ESP32 GND and the drives' signal ground common.
Do **not** connect 24 V or pin 35 (PULLH) to the low-speed inputs.

### Enable, alarm and the drive's own 24 V

The A6-RS has an internal 24 V supply on CN1 for its inputs:

| | A6-RS CN1 | note |
| --- | --- | --- |
| jumper | **17** (24 V) → **11** (COM+) | powers the input commons, do this on each drive |
| 24 V return | **14** (COM−) | this is the emitter / COM of the ULN2003 for that drive |

| signal | ESP32 (A) | ESP32 (B) | via | A6-RS CN1 |
| --- | --- | --- | --- | --- |
| S-ON (enable) | GPIO27 | GPIO14 | ULN2003 in → out | **33** S-ON, ULN COM/E → **14** COM− |
| ALM+ | GPIO18 | GPIO19 | direct (ESP32 pull-up) | **1** ALM+ |
| ALM− | GND | GND | | **26** ALM− |

With `PAX_ENA_LOW=0` (default) GPIO HIGH turns the ULN2003 channel on, which
pulls S-ON to COM− and **enables** the drive; the ESP32 boots with both
drives enabled and holding. The ALM output is an open-collector transistor
that conducts while the drive is healthy, so the ESP32 reads LOW = OK,
HIGH = fault — exactly what the Pi's own GPIO driver expected. Until ALM is
wired, turn on **Ignore the drives' alarm outputs** in the app.

### Sensors (moved from the Pi to the ESP32)

| sensor | ESP32 | note |
| --- | --- | --- |
| shelf flag (NPN inductive) | GPIO4 | internal pull-up, sensor sinks to GND when metal is present |
| home flag (NPN inductive) | GPIO13 | same |

12–24 V NPN sensors need their output taken to 3.3 V — a 10 kΩ pull-up to the
ESP32's 3V3 is already provided internally; just make sure the sensor is an
open-collector NPN type (or PNP with `npn=0`, which the agent sets from
`SENSOR_TYPE`). The Pi's `SENSOR_INVERT`, debounce and all counting logic
apply unchanged; the sensors simply plug into the ESP32 instead of the Pi.

### Drive parameters

Same as the GPIO wiring: pulse + direction mode, **4000 pulses/rev** (match
*Pulses per revolution* in the app), S-ON from the external input, no
internal enable. Both drives identical; motor B's direction mirror is handled
by the firmware (`mirror=1` by default, changeable in the app).

---

## 3b. Wire the ESP32 to closed-loop stepper drives (CL86Y / CL57T)

Profile **`closed-loop-stepper`**. The CL86Y's control inputs (PU, DR, MF)
are opto-isolated **5–24 V** inputs that need **7–20 mA** — too much for a
3.3 V ESP32 pin on its own and below the 5 V minimum. Wire them
**common-anode from +5 V** and let the ESP32 pin *sink* the signal: `+` of
every input to the DevKit's 5 V (VIN/USB 5 V), `−` to the GPIO. No series
resistor at 5 V (the manual only asks for one above 24 V). The 74HCT125
buffer from section 3 is **not** needed; if you already have it, its outputs
can sink the current just as well.

| signal | motor A | motor B | CL86Y pin |
| --- | --- | --- | --- |
| PU− (pulse) | GPIO25 | GPIO32 | **2** PU− (PU+ → +5 V) |
| DR− (direction) | GPIO26 | GPIO33 | **4** DR− (DR+ → +5 V) |
| MF− (motor free) | GPIO27 | GPIO14 | **6** MF− (MF+ → +5 V) |
| ALM+ | GPIO18 | GPIO19 | **9** ALM+ (ALM− → ESP32 GND) |
| GND | — | — | drive's signal GND ↔ ESP32 GND |

- **MF** conducting = coil current OFF (motor turns freely, alarm cleared).
  Common-anode, GPIO **LOW** = MF conducting = **released**; GPIO **HIGH** =
  engaged. That is the profile's default (`ena_low=0`) — if you route MF
  through the S-ON transistor from section 3 instead, the sense inverts:
  tick *"MF: GPIO LOW engages the motor"* under *Signal polarity* in the app.
- **ALM** is an opto output (≤ 50 mA) that conducts **when the drive has
  tripped** — the opposite of the servo drives. The ESP32 pin has a pull-up,
  so LOW = fault, HIGH = healthy. The profile sets `alm_low=1` for this; an
  **unwired** ALM therefore reads as healthy, so *Ignore alarm* is not needed.
- **DIP switches:** SW1 **OFF** (PU/DR mode, not CW/CCW), SW2 direction as
  you like (the app's *Mirror motor B* and *Reverse* cover the rest), SW3–SW6
  = pulses/rev (400 … 51 200). Enter the same number as *Pulses per
  revolution* in the app; 1600 or 3200 is a good start.
- **Pulse rate:** the drive accepts 200 kHz; the firmware clamps RUN/JOG to
  that in this profile and the app caps *Pulse rate at 100 %* the same way.
  A stepper loses torque above a few hundred rpm at the shaft, so a geared
  carousel should sit far below the ceiling.
- **Power:** 24–80 V DC (or 20–80 V AC) on the drive, sized for the motor's
  rated current; the control inputs above take nothing from it.
- **Release after idle** in the app now does exactly what it says: the
  controller drops MF, the coils go cold and the carousel can be pushed by
  hand. Every move or jog re-engages first and waits the settle time before
  the first pulse.

The sensors are wired as in section 3.

---

## 4. Switch the agent over

In the app: *Settings → Motor drive*, pick the drive card (AC servo /
integrated servo / closed-loop stepper), then *Motor controller → **ESP32***,
choose the link, save. The agent rebuilds its backend while idle, sends the
board its `CFG profile=…`, and reports the link status (port, firmware,
profile, OK / error) right under the setting.

Or on the Pi:

```bash
sudo ./install.sh --pulse-drive ac-servo                         # A6-RS, USB link
sudo ./install.sh --pulse-drive closed-loop-stepper              # CL86Y, USB link
sudo ./install.sh --pulse-drive closed-loop-stepper --esp32-link uart && sudo reboot
journalctl -u paternoster-agent -f | grep -i esp32
```

(`--pulse-drive` implies `--motor servo`, and the AC servo / stepper profiles
default to `--servo-driver esp32`.)

Expected: `ESP32 servo controller: connected on /dev/ttyUSB0 (fw 1.1) — link
usb, 460800 baud, two closed-loop-stepper drives`.
If you see `no HELLO from the ESP32`, check the cable, that the firmware is
flashed, and that the baud in the app equals `PAX_LINK_BAUD`.

### What changes in behaviour

- the stop on a shelf is now armed in the ESP32 for the last leg of every
  move, so the agent's stop latency no longer depends on Python;
- the two motors can never drift apart in frequency — they share a timer;
- if the Pi, the agent or the cable disappears, the ESP32 stops the motors
  within 1.5 s and the app shows *ESP32 servo controller link lost*;
- twin mode (two carousels on one Pi) is **not** supported on this driver:
  one ESP32 drives one carousel. Use a second Pi + ESP32 for the second unit.

---

## 5. Protocol (for debugging)

Newline-terminated ASCII at `PAX_LINK_BAUD`, identical on every port (USB,
GPIO UART and TCP 8766 — `nc pax-esp32-1a2b.local 8766` works too). Open
`pio device monitor` and type:

```
HELLO              -> HELLO pax-esp32 fw=1.2 profile=ac-servo profiles=... pins=... host=pax-esp32-1a2b wifi=1
CFG profile=closed-loop-stepper
                   -> OK CFG ... profile=closed-loop-stepper ceiling=200000 ena_low=0 alm_low=1
CFG profile=clstep ena_low=1      (short aliases: isv, clstep; overrides go AFTER profile=)
CFG maxpps=8000    -> OK CFG mirror=1 single=0 ...
ENA 1              -> OK ENA 1                 (ENA 0 = release: S-ON off / MF asserted)
RUN 1 2000         -> OK RUN 1 2000        (both motors, carousel "down", 2 kHz)
STOP               -> OK STOP
JOG a 1 400 800    -> OK JOG ... then JOGDONE 400
ARM S 1 50000      -> OK ARM S 1 50000     (stop on the next shelf arrival)
```

The board streams `ST ...` status 20 times a second (with `wifi=… rssi=…`
appended when Wi-Fi is on) and an `E S|H <level> <us> <pos>` line for every
sensor edge. Without a `PING` or any other line for 1.5 s (3 s over Wi-Fi,
`CFG wd_ms=`) it stops the motors and prints `EV WATCHDOG`. Network commands
(`WIFI`, `WIFIAP`, `HOSTNAME`, `OTAPASS`, `NET`, `REBOOT`) are listed in
`src/paxnet.h`.
