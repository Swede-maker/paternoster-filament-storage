# PAX Paternoster — Raspberry Pi agent

This folder contains the program that runs **on a Raspberry Pi** to drive one
physical paternoster carousel and connect it to the PAX web app.

- The **web app** is the UI + coordinator. It never touches GPIO directly.
- The **Pi agent** (`paternoster_agent.py`) owns the motor and sensors, runs the
  homing + move logic, and reports the true position back over WebSocket.
- One agent runs per unit. Link several units in the app (one master, the rest
  slaves) and they act as one combined storage pool.

```
[ Browser / PAX app ]  --WebSocket-->  [ Pi agent ]  --GPIO-->  motor drive + 2 sensors
```

The agent supports two **motor drive modes**, selected in the app (setup wizard
or *Settings → Units → Motor drive*) and persisted on the Pi in
`/var/lib/pax-agent/motor.json`:

| Mode | Hardware | Section |
| --- | --- | --- |
| `dc` (default) | **Two** brushed DC motors, each on its own BTS7960 / IBT-2 bridge | [DC drive](#dc-drive-two-bts7960-bridges) |
| `servo` | **Two** StepperOnline **iSV57T** integrated servos on PUL/DIR | [Servo drive](#servo-drive-two-isv57t-on-puldir) |

A carousel always has **two motors — one per chain, one on each side** (motor
**A** and motor **B**). In both modes they run in lockstep during a move, and
each can be **jogged on its own** from *Manual control* to level the shelves if
the chains drift. The sensors are identical in both modes. You can also force a
mode from the command line with `--motor dc` / `--motor servo`.

## Hardware

### DC drive (two BTS7960 bridges)

Each carousel uses:

| Part                       | Qty | Purpose                                            |
| -------------------------- | --- | -------------------------------------------------- |
| Brushed DC motor           | 2   | One per chain, one on each side of the carousel.   |
| BTS7960 / IBT-2 43A        | 2   | One half-bridge driver **per motor**. **Dual PWM**: RPWM vs LPWM picks direction. |
| Inductive **shelf** sensor | 1   | Pulses once as **every** shelf passes the window.  |
| Inductive **index** sensor | 1   | Active **only at shelf 1** — the home reference.   |

The agent gives both bridges the **same PWM duty and direction** during a move,
so the two chains stay in step. Because motor B usually sits across the
carousel from motor A, its direction is **inverted in software** by default
(`DC_MIRROR_B = True` / *Mirror motor B* in the app) — flip that switch rather
than rewiring if the two sides fight each other.

### Default wiring (BCM pin numbers)

Edit the constants at the top of `paternoster_agent.py` (`PIN_MOTOR_A_*`,
`PIN_MOTOR_B_*`) to match your boards.

| Signal        | Bridge **A** (motor A) | Bridge **B** (motor B) | Notes                                      |
| ------------- | ---------------------- | ---------------------- | ------------------------------------------ |
| RPWM          | GPIO 12                | GPIO 20                | PWM — drives one direction                 |
| LPWM          | GPIO 13                | GPIO 21                | PWM — drives the other direction           |
| R_EN + L_EN   | GPIO 22                | GPIO 27                | **Tie both EN pins of a bridge to its one GPIO.** HIGH = armed |
| VCC           | 3.3 V                  | 3.3 V                  | Logic supply — **not** 5 V (see below)     |
| GND           | any GND                | any GND                | **Common ground** Pi ↔ both drivers ↔ sensors |
| R_IS / L_IS   | *unused*               | *unused*               | Current-sense outputs, leave disconnected  |
| Shelf sensor  | GPIO 23                |                        | One pulse per shelf (shared)               |
| Index sensor  | GPIO 24                |                        | Active only at shelf 1 (shared)            |

The screw terminals carry the power side: **B+ / B−** of *each* bridge to your
motor supply (the big cap is already on-board), **M+ / M−** to that bridge's
motor. If the whole carousel runs the wrong way, flip `HOMING_DIRECTION`; if
only *one* side runs the wrong way, toggle **Mirror motor B** in the app (or
swap M+/M− on that bridge).

**Key points for these boards:**

- **Never drive RPWM and LPWM high at the same time** — that shoots through the
  bridge. The code uses gpiozero's `Motor` without an `enable` argument, which
  guarantees only one of the two is ever given a duty cycle, on each bridge.
- **Power VCC from 3.3 V, not 5 V.** The BTS7960's inputs are happy at 3.3 V
  logic, and feeding VCC 5 V can make the on-board logic pull the input pins
  above the Pi's 3.3 V limit.
- GPIO 12/13 are the Pi's **hardware PWM** channels, so bridge A gets them;
  bridge B on GPIO 20/21 is driven by software PWM. For the smoothest result
  install `pigpio` (`sudo apt install pigpio && sudo systemctl enable --now
  pigpiod`) and export `GPIOZERO_PIN_FACTORY=pigpio` — pigpio generates
  jitter-free PWM on *any* GPIO, so both bridges then run identically. Without
  it gpiozero falls back to software PWM, which can make a motor buzz.
- Pulling **EN low is a hardware stop** — the outputs float regardless of the PWM
  state. That's why `stop()` zeroes both PWMs and then disarms both ENs.

> Power the motors from their **own supply**, not the Pi's 5V rail. Size it for
> two motors. Tie all grounds together — the Pi's GND *must* be common with both
> drivers' GND or the PWM signals have no reference and the motors behave
> erratically.

#### Jogging one DC motor

A DC bridge has no step unit, so a jog is **timed**: *Manual control → Motor
jog* runs motor A, motor B or both for a set number of **milliseconds** (default
150 ms, 10–5000 ms) at the unit's *Motor speed* PWM. Use it exactly like the
servo micro-jog: nudge one side until the shelf hangs level, then **Home**. The
step size is saved per unit.

`motor_test.py` still exercises bridge A only (`PIN_MOTOR_RPWM/LPWM/EN` are
aliases for the A pins); to bench-test bridge B, point those constants at the
`PIN_MOTOR_B_*` values temporarily.

### Servo drive: two iSV57T on PUL/DIR

Select **Integrated servo motors (PUL/DIR)** in the app. The agent then drives
two StepperOnline iSV57T integrated servos (tested target: **iSV57T-090(S)**)
instead of the two BTS7960 bridges:

- both motors receive the **same pulse train and direction**, so the two chains
  stay synchronised during a move;
- speed = **pulse frequency** (the app's speed sliders scale 0–100 % of the
  configurable top rate, default 8 000 pulses/s);
- each motor can be **micro-jogged individually** by an exact pulse count to
  level the shelf if the chains drift (Manual control → *Servo micro-jog*; the
  DC drive has the same panel in milliseconds);
- the drives' **ALM** fault outputs are read back and shown as lamps; an alarm
  stops the pulse train and raises a fault in the app;
- a parked servo **holds its position with full torque** and cannot be turned
  by hand. The iSV57T has **no enable input** (its control header is only
  PUL/DIR/ALM), so by default the servos simply stay on and you move the
  carousel with the jog arrows. Optionally, a relay in the drives' +Vdc lead
  on **GPIO 17/25** lets the agent cut the servo supply after an idle timeout
  (*Settings → Motor drive → Release servos after idle*, default *Always on*)
  or on the **Release** button; any move or jog powers the drives up again
  first and re-homes.

#### Positioning by pulses instead of the shelf sensor (pax-agent-1.5+)

The pulse train is also an **odometer**: the agent integrates pulses × time for
every segment it sends, so it always knows how far the chain has moved. That
enables two things:

- **Bounce / re-entry filter (always on, both drives).** A shelf edge that
  arrives less than half a shelf pitch after the previous counted edge is the
  same shelf rocking in the window, and the first edge of a move within 0.3 of a
  pitch of the start is the shelf you were parked beside — e.g. after a stop
  that landed exactly on the flag edge and the chain rocked back off the sensor.
  Both are ignored (logged as `shelf edge ignored as bounce/re-entry`). On the
  servo the distance is measured in pulses; on DC it falls back to a fraction of
  the pitch *time* measured earlier in the same move.
- **Calibrate** (*Settings → Motor drive → Positioning*): one continuous run at
  homing speed. The agent homes on the index flag (zeroing the odometer without
  stopping), measures the index window width and counts shelf flags on the way
  round, and stops on the next index edge. The result is **pulses per
  revolution**; divided by the shelf count it gives pulses per shelf. It is
  saved in `motor.json` and mirrored to the app, which hands it back if the Pi
  is ever re-installed.
- **Servo pulses** positioning: a `goto` drives the calibrated distance from the
  home datum with a smooth slowdown onto the target, and the shelf sensor is only
  reported, never used to stop. Every time the home flag passes the index sensor
  the odometer is **corrected on the fly** (a `sync` frame carries the drift in
  pulses; more than half a shelf also raises a fault), so a calibration that is
  a few pulses short can never accumulate into a shelf of error. Coming the
  other way, the index edge is the far side of the window, which is why the
  window width is measured too.

- **Home only** positioning: identical to *Servo pulses*, for builds with **no
  shelf sensor at all**: only the index (home) sensor is wired. Calibration
  skips the shelf-flag count, the shelf lamp is hidden, and a floating shelf
  input is ignored. Because there is nothing to fall back to, a shelf move
  before the first calibration is refused with a fault instead of counting a
  dead input; jog, Home and Calibrate always work.

Changing the shelf count in the app does not need a re-run: the pitch is
recomputed from the same revolution. Re-run after mechanical changes (sprocket,
chain, shelves added or removed).

#### What you need

| Part | Qty | Notes |
| --- | --- | --- |
| iSV57T-090(S) integrated servo | 2 | 24–36 V DC, 180 W. Each has its own driver inside — there is no separate motor driver board. |
| 24–36 V DC supply | 1 | ≥ 10 A for two motors (manual recommends 24 V/8 A per motor at full torque; a carousel seldom needs that). **Separate from the Pi's 5 V.** |
| 5 V logic level shifter / line driver | 1 | **74AHCT125** or **74HCT245**, powered from the Pi's 5 V pin. The iSV57T's PUL/DIR opto inputs want 4–5 V and 7–16 mA; a Pi GPIO is 3.3 V and only safely sources a few mA, so **do not connect PUL/DIR straight to the GPIO**. |
| Twisted-pair / shielded cable for PUL/DIR | — | Keep signal cables away from the motor power leads. |

#### Pin map (BCM numbers)

Constants live at the top of `paternoster_agent.py` (`PIN_SERVO_*`). Both
drives share the direction convention, so **motor B's DIR is inverted in software**
by default (`SERVO_MIRROR_B = True` / *Mirror motor B* in the app) because on most
dual-chain builds the two servos face each other.

| Pi (BCM) | → 74AHCT125 | → Motor **A** | → Motor **B** | Notes |
| --- | --- | --- | --- | --- |
| **GPIO 12** | 1A → 1Y | **PUL+** | — | Hardware PWM channel 0: the pulse train |
| **GPIO 13** | 2A → 2Y | — | **PUL+** | Hardware PWM channel 1 |
| **GPIO 5**  | 3A → 3Y | **DIR+** | — | Direction |
| **GPIO 6**  | 4A → 4Y | — | **DIR+** | Direction (mirrored in software) |
| **GPIO 17** | *(optional)* relay IN | relay in **+Vdc** lead | — | Supply relay for *Release*. Leave unconnected if you don't need it (see note) |
| **GPIO 25** | *(optional)* relay IN | — | relay in **+Vdc** lead | Supply relay, motor B (or share one relay for both) |
| **GPIO 16** | *(direct)* | **ALM+** | — | Alarm output, internal pull-up |
| **GPIO 26** | *(direct)* | — | **ALM+** | Alarm output, internal pull-up |
| **GND** | GND, all /OE pins | **PUL−, DIR−, ALM−** | **PUL−, DIR−, ALM−** | **Common ground** Pi ↔ shifter ↔ both drives |
| **5 V** | VCC | — | — | Powers the line driver only |
| **GPIO 23** | — | shelf sensor | | unchanged from DC mode |
| **GPIO 24** | — | index sensor | | unchanged from DC mode |

Why PUL on GPIO 12/13: those are the Pi's two **hardware PWM** channels, so the
pulse train comes from the PWM peripheral and is jitter-free. Each motor has its
own channel, which is what makes individual jogging possible. Install `pigpio`
(or `lgpio` on a Pi 5) exactly as in the DC section so gpiozero uses them.

The iSV57T control connector (manual §3, 6-pin "control signal" header):

| iSV57T pin | Function | Wire to |
| --- | --- | --- |
| PUL+ / PUL− | Pulse input, opto-isolated | PUL+ ← shifter output, PUL− → GND |
| DIR+ / DIR− | Direction input, opto-isolated | DIR+ ← shifter output, DIR− → GND |
| ALM+ / ALM− | Alarm output, open-collector | ALM+ → GPIO 16 / 26, ALM− → GND |

There is no ENA pin on this drive — the 5-pin header next to the DIP switches
(NC/RX/GND/TX/5V) is the RS232 tuning port, not a control input.

**Power connector**: `VDC` to +24…36 V, `GND` to supply −. Also tie the supply −
to the Pi's GND so the opto inputs have a return path.

> The ALM output is **conducting when healthy** and goes high-impedance on a
> fault. With the Pi's pull-up enabled the GPIO therefore reads LOW = OK,
> HIGH = alarm. If your lamps show "alarm" with healthy drives, check that ALM−
> really is at GND.

> **Optional supply relay (GPIO 17/25).** Because the drive cannot be
> disabled electrically, *Release* works by cutting its 24–36 V supply. Put a
> relay or high-side MOSFET module rated for the drive current in each
> drive's +Vdc lead (or one relay feeding both) and drive its IN pin from
> GPIO 17 / 25. `SERVO_ENA_ACTIVE_RELEASES = True` means GPIO HIGH = relay
> open = motor free; set it `False` for active-low relay boards. The agent
> waits `SERVO_ENABLE_SETTLE_S` (1.2 s) for the drive to boot before sending
> pulses. With nothing wired, leave *Release servos after idle* on
> **Always on** (the default) — the servos hold and you move the carousel with
> the jog arrows.

#### Drive configuration (DIP switches / software)

Set these on **both** servos; the app's *Settings → Motor drive* values must match.

| Setting | Value | Why |
| --- | --- | --- |
| Control mode (Pr0.01) | **0 — position (pulse + direction)** | Factory default. The agent streams pulses; the servo follows them. |
| Pulse mode (Pr0.07) | **PUL/DIR** | Not CW/CCW. Factory default. |
| Pulses per revolution (S1–S3 / Pr0.08) | **4000** (factory default) | Matches `SERVO_PULSES_PER_REV` and the app default. If you change the DIP, change *Pulses per rev* in the app so jog degrees and rpm read correctly. |
| Direction (S4 / Pr0.06) | leave default | Flip *Mirror motor B* in the app instead if one chain runs the wrong way. |
| Enable | not wired | The drive is enabled on power-up and holds position when the pulse train stops — a stopped servo brakes far harder than a coasting DC motor. |

The top pulse rate (*Max pulse rate*, default 8 000 pps = 120 rpm at 4000 ppr) is
far below the drive's 300 kHz input limit; raise it only if your gearing needs
more carousel speed.

#### Aligning the two chains (both drives)

If the shelf hangs lower on one side after assembly or a jam:

1. Open **Manual control** for the unit; the jog card (**Servo micro-jog** or
   **Motor jog**) shows the motor selector and the arrows — plus the two ALM
   lamps on servos.
2. Set the **step size**. Servo: pulses per tap (40 pulses = 3.6° at 4000 ppr).
   DC: milliseconds per tap (default 150 ms, at the unit's *Motor speed* PWM).
   It is saved per unit.
3. Select **Motor A** or **Motor B** and tap **▲ / ▼** until the shelf is level,
   or select **Both** to nudge the whole carousel.
4. **Home** the carousel so the shelf count is re-referenced.

A jog never changes the recorded shelf number; the shelf sensor keeps counting
underneath it, so jogging across a flag is handled like a coasting stop. The
arrows stay disabled until the agent has confirmed it is running the same drive
the app has selected (so a pulse count is never sent to a DC bridge or vice
versa); that needs pax-agent-1.3+ for the DC drive.

#### Running without hardware

`--simulate` honours the mode too, so either jog panel can be exercised on a
laptop: `python3 paternoster_agent.py --simulate --motor servo` (or `--motor dc`).

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
- **Goto shelf N**: the agent picks the shorter direction around the loop, waits
  for the currently parked shelf to leave the sensor window, then counts shelf
  **arrivals** until it reaches N, emitting a `pos` event per shelf and an
  `arrived` event when it stops. A missing pulse within `PULSE_TIMEOUT` reports a
  `fault` (jam / sensor failure) and stops the motor.
- **Parking**: a move ends with the target shelf's flag still *inside* the shelf
  sensor window, so "in position" can be verified at any time rather than
  inferred. If the soft stop coasted out of the window, the carousel creeps back
  until the sensor triggers again.

Speed and soft start are set from the **app's sliders** at runtime, not by editing
the script — `HOMING_SPEED` and `MOVE_SPEED` are only the values used before the
app first sends a `config` (see the `config` section below). Edit the timeouts and
`MIN_DUTY` in the script if needed. If the carousel moves the opposite way from
the app's up/down labels, flip `HOMING_DIRECTION`.

## Install & run on the Pi

**Easiest:** the one-command installer at the repository root sets up the agent, the
networking and (on a master) the web app, asking only for the role and shelf count:

```bash
curl -fsSL https://raw.githubusercontent.com/Swede-maker/paternoster-filament-storage/main/setup.sh | sudo bash
```

The manual steps below are what that script runs for you.

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

Step 1 may print `gpiozero : unknown` or `board : unknown (AttributeError)`.
That is harmless — not every gpiozero build exposes a version or board info, and
only the `✓ GPIO is reachable` line decides whether the check passed.

This splits the problem in a single run:

- **Motor turns here** → the wiring is fine and the fault is in the agent/app layer.
- **Motor does not turn** → the fault is electrical, and no app-side fix will help.
  Check bridge power, then **common ground between Pi and driver** (the most common
  cause — without it the PWM signal has no reference), then the BCM pin numbers.

## Design rule: sensors count, they never gate power

**Sensor state must never decide whether the motor is energised.** The sensors do
exactly two jobs: find the home shelf via the index sensor, and count shelves as
they pass. Motion code starts the motor unconditionally, then consumes counted
pulses while it runs.

This was broken in three places, all the same mistake — reading a sensor *level*
where an *edge* was meant:

1. **Homing** asked "is the index sensor active?" A carousel parked with a shelf
   in the index window answered yes immediately, so homing "succeeded" in
   microseconds and the motor never turned.
2. **Moving** used `wait_for_active()`, which returns instantly when the sensor is
   already covered. All the steps were consumed at once and the motor was switched
   off before it could physically move — a twitch, and the appearance of a motor
   that only ran while a sensor saw something.
3. **Drift correction** read the index level right after homing, while the carousel
   was still sitting on the home flag, so the first shelf pulse was reset to 0
   (reporting `0,1,2` for a 3-shelf move instead of `1,2,3`).

The fixes: sensors are now edge counters (`when_activated`), and homing drives
*off* the flag before looking for a real edge.

The carousel deliberately parks **inside** the shelf sensor window (see
*"A move stops after ~30mm"* below), so a move starts with that sensor active.
Rather than guessing a blanking time, the move waits for the parked flag to
physically leave the window before counting — a real geometric event instead of a
tuned constant. `PULSE_BLANKING` remains only as the fallback for the rare case
where a move begins with the window already empty (an aborted move, or a fault
that left the carousel mid-travel). Crucially the motor is running throughout
both paths: they filter *counting*, never power.

Two deliberate consequences:

- The only sensor-related stop left is the jam guard, which fires on **elapsed
  time with no pulse at all** — never on a sensor merely reading inactive.
- An un-homed carousel can still move. Refusing meant a failed home (e.g. a
  miswired index sensor) left the machine totally immobile, including the manual
  Move buttons, so the motor could never be exercised to diagnose the fault
  blocking it. Position is then relative and `homed` stays `false`.

`test_motion_logic.py` locks this in without any hardware. It fakes a carousel
parked *on* the sensor and asserts the motor is powered continuously — one power
cycle, not one per pulse:

```bash
python3 test_motion_logic.py
```

## Speed and soft start reach the motor via `config`

The speed and soft-start sliders used to be cosmetic: they retimed the on-screen
animation only. The chain was broken in **three** independent places, and any one
of them alone was enough to make the sliders do nothing to the hardware:

1. **The app never sent a `config` command at all.** `SET_NODE_SPEED` /
   `SET_NODE_RAMP` updated local state that only fed the animation clock. Shelf
   count reached the Pi as a stream query param, so `ConfigCommand` was dead code
   from end to end.
2. **`/api/pi/command` rebuilt the command field-by-field** and copied only
   `shelves`, so any motion field would have been dropped in transit anyway.
3. **The agent's motion code read the module constants** `MOVE_SPEED` /
   `HOMING_SPEED`, so even a delivered setting could not change the PWM duty.

The settings now flow all the way through:

```
slider (sec/shelf) -> secPerShelfToDuty() -> config{moveSpeed,homingSpeed,rampPct}
   -> relay -> agent.set_motion() -> self.move_speed -> PWM duty
```

`MOVE_SPEED` / `HOMING_SPEED` in the agent are **defaults only**. Motion code must
read `self.move_speed`, `self.homing_speed` and `self.ramp_pct` — never the
constants — or the sliders go dead again.

Duty is clamped to `MIN_DUTY` (0.25) … 1.0 in both the app and the agent: below
about a quarter duty a geared carousel cannot break stiction and the motor just
buzzes and heats, which looks like the slider breaking the machine. The slider's
1.5–8 s/shelf range maps across the whole usable band (1.0 down to 0.25).

Soft start/stop is a real PWM ramp, not an animation curve: the duty climbs from
`MIN_DUTY` to target in `RAMP_STEP_SECONDS` increments, drops to a slower approach
duty one shelf before the target, then eases down to a halt. At `rampPct = 0` full
duty is applied in one step and the stop is immediate. The motor stays energised
throughout — ramping changes how fast it accelerates, never whether it has power,
so this does not reintroduce the sensor-gating bug above.

The jam timeout scales with the chosen speed plus the ramp time, so a
slow-but-healthy move is not misreported as a jam.

Settings are re-sent on reconnect, because a restarted Pi comes back on defaults.
The **relay** owns that memory (`relay.motion`), not the browser: it replays the
last known tuning on every socket open, so a Pi reboot cannot silently revert the
carousel to default speed.

Two further faults were found by watching a live agent log while driving the real
UI, either of which alone kept the sliders from reaching the hardware:

- **The client effect was keyed on a ref.** `conns` is a `useRef`, so flipping
  `conn.online` is a plain mutation that triggers no re-render. A signature built
  from it stayed frozen at its mount value, so the effect never re-fired. The
  signature now reads `n.link` from the store — dispatched right beside that
  mutation, and real state that React can see.
- **`sendCommand` threw a 500 on every config.** `registry` is module-level and
  long-lived, so a relay object can outlive the code that reads it (hot reload in
  dev, an old object surviving a redeploy). Those relays have no `motion` field,
  and writing through it raised `Cannot set properties of undefined`: the POST
  500'd and the agent log stayed frozen — indistinguishable from a UI that never
  sent anything. `sendCommand` now heals the shape instead of assuming it.

Note the speed slider is **inverted**: its DOM value is "fastness" (right =
faster) and the displayed seconds-per-shelf is `MIN + MAX - value`. Driving the
raw DOM value in a test therefore gives the opposite of what you expect.

```bash
python3 test_speed_control.py   # asserts the duty actually changes
```

To confirm on real hardware, watch the agent while moving a slider — one line
should appear per change:

```bash
journalctl -u paternoster-agent -f | grep "motion set"
```

### "It skips a shelf — shelf 1 runs past the sensor instead of shelf 2 arriving"

This looked like the sensor miscounting the parked shelf, but the sensor was
fine; the blanking window was being measured from the wrong instant.

`_drive()` **blocks** for the whole soft-start ramp (0.48s at `rampPct` 40%, up
to `MAX_RAMP_SECONDS` = 1.2s). The old order was *drive → sleep(PULSE_BLANKING)
→ reset_pulses()*, so pulses were discarded for the ramp **plus** another 0.15s
— about 0.63s. A shelf only takes ~0.5s to pass, so the target shelf's genuine
pulse landed inside that window and was thrown away, and the **next** carrier
was counted in its place: exactly one shelf of overshoot.

Three things now keep a one-shelf request to one shelf:

- Blanking is timed from `motor_start`, before the blocking ramp, and only
  sleeps for whatever of the window has not already elapsed. Once it is over,
  every pulse counts.
- A single-shelf hop runs entirely at the gentle approach duty. There is no room
  to cruise fast and then slow down, so a 1-shelf move at full speed always
  coasted well past the target.
- Deceleration after the target pulse is pure overshoot, so the stop ramp is
  capped by `STOP_RAMP_SECONDS` (0.25s) instead of the full ramp budget.

The same blocking ramp also explains why the speed slider felt dead even after
the config plumbing was fixed: a 1.2s soft start across a ~0.5s move meant the
motor was still accelerating when it arrived and never reached the requested
duty. Short moves now get a capped soft start.

`test_shelf_counting.py` measures **physical shelves travelled** (not the
reported number) across every speed/ramp combination. Against the pre-fix code
it fails 15 times, reproducing the reported symptom — a 1-shelf request moving
1.58, 2.77, even 4.90 shelves:

```bash
python3 test_shelf_counting.py   # one-shelf request must move one shelf
```

### "A move stops after ~30mm, as soon as the sensor stops being triggered"

The carousel now parks with the target shelf's flag still **inside** the sensor
window, so "in position" is a fact that can be re-checked rather than dead
reckoning. That inverts an assumption the old code made, and two things follow.

**A move now BEGINS with the sensor already active.** The parked flag has to be
driven out of the window before counting starts. Otherwise the level dropping as
it leaves — or the smallest bounce on that boundary — is counted as the target
shelf arriving, and the move ends about 30mm in. `shelf_clear()` waits for that
real departure at `MIN_DUTY` **before** the soft start; the motor runs the whole
time, so this gates counting, never power. The order matters, because `_drive`
blocks for up to 1.2s — long enough to carry the carousel past a whole shelf
before the wait would even begin.

**A move must END inside the window.** A soft stop always coasts, so counting
alone cannot say where the shelf physically stopped. `_settle_on_sensor()` checks
the sensor afterwards and, if the flag drifted out, crawls **back the way it
came** at `CREEP_DUTY` until it is found again. Either way the flag is then eased
a little deeper (`CENTER_NUDGE_SECONDS`) so it rests nearer the middle of the
window than its boundary — parking on the edge is what makes a shelf read as "not
in position" after a nudge, and what makes the next move's departure ambiguous.
The nudge creeps in short slices and stops the moment the flag would leave, so it
can never push the shelf out the far side.

Homing runs the same alignment, because it stops on the *index* edge, which
leaves the shelf flag on the boundary rather than inside the window.

Tuning: `SHELF_CLEAR_TIMEOUT`, `CREEP_DUTY`, `CREEP_TIMEOUT`,
`CENTER_NUDGE_SECONDS`. If the shelf consistently rests slightly off-centre,
adjust `CENTER_NUDGE_SECONDS` first.

### "A 3-shelf move only travels 2 shelves"

An inductive sensor is a **level**, not a tripwire, so each shelf passing raises
**two** edges: one as the flag enters the window and one as it leaves. Counting
raw edges counted every shelf twice. A shelf is now counted only on **arrival**;
the matching departure edge is consumed and discarded.

Classifying an edge purely by reading the level is racy — at speed the flag can
cross the whole window before the level is read — so arrival/departure parity is
tracked and the level is trusted only while it still reads "inside".

This is also what lets the carousel stop *on* the sensor: the stop is triggered
by the target shelf arriving at the window rather than leaving it.

```bash
python3 test_sensor_parking.py   # parks ON the sensor, recovers from overshoot
python3 test_shelf_counting.py   # N shelves requested == N shelves travelled
```

Both harnesses model the sensor as a window of real width
(`SIM_SENSOR_HALF_WIDTH`) that pulses on **both** edges. That fidelity matters: a
zero-width tripwire is never active at rest, so it cannot represent a carousel
parked on its sensor, and a single-edge model hid the double-counting bug above
completely — the parking test passed against the broken code until both edges
were modelled.

### "The browser shows shelf 3, but jumps to 2 after a refresh"

Two bugs in the debounced save in `lib/store.tsx`, both losing the last write:

- The timer captured `state` from its own render. The debounce is reset by every
  `pos` tick, so the timer that eventually fired belonged to an **earlier**
  render and wrote that older shelf. It now reads `stateRef.current`.
- The effect cleanup cancelled the armed timer. Keyed on `[sig]`, it also ran
  when the next render bailed out at the `sig === lastSavedSig` guard — killing
  a save nothing ever rescheduled.

A pending save is also flushed on `visibilitychange`, so refreshing inside the
600ms debounce no longer drops the position.

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

## Networking: router mode, hotspot fallback, slave provisioning

`paxnet.py` runs inside the agent and manages the Pi's Wi-Fi through
NetworkManager (`nmcli`). It needs **Raspberry Pi OS Bookworm or newer**; on a
dhcpcd-based image `install.sh` stops with a clear error, or run it with
`--no-net` for a wired bench setup.

### Roles

| | Master (Pi 4/5, runs the web app) | Slave (Pi Zero 2 W) |
| --- | --- | --- |
| Install | `sudo ./install.sh --role master --hostname pax-master` | `sudo ./install.sh --role slave --hostname pax-slave-1 --master pax-master.local --ap-ssid PAX-Setup-XXXX --ap-psk <pw>` |
| Router profile | `pax-router` (autoconnect, priority 100) | same |
| Fallback | Brings up its own hotspot `pax-ap` (SSID `PAX-Setup-XXXX`, gateway `10.42.0.1`) | Joins the master's hotspot via `pax-master-ap` (autoconnect, priority 10) |
| Reachable as | `http://pax-master.local` (or `http://10.42.0.1` on the hotspot) | `ws://pax-slave-1.local:8765` |
| Extra | Keeps a registry of slaves and pushes router credentials to them | Keeps an outbound socket to the master and registers itself |

The installer sets the hostname, enables Avahi (mDNS) so `pax-*.local` resolves
on any network, generates the hotspot password once (reinstalling never rotates
it), writes `/etc/paxnet.conf`, and drops a sudoers rule so the agent may run
`nmcli` without becoming root. Address nodes in the app by hostname, not IP, and
a move to a network with different addresses needs no edits.

### The fallback timeline (`mode = auto`)

```
boot ─▶ NM autoconnects pax-router ─▶ gateway reachable?  yes ─▶ stay, re-check every 5 s
                                                          │
                                        45 s with no gateway
                                                          ▼
                        master: nmcli con up pax-ap      slave: NM autoconnects pax-master-ap
                        broadcast net.status {mode:"ap"}
                                                          │
                                  every 60 s: try pax-router again
                                                          │
                                      router back? ─▶ drop hotspot, resume
```

The same loop runs if the router disappears mid-session (loss timeout 45 s).
The mode pin in Settings → Network changes the rules:

| Pin | Behaviour |
| --- | --- |
| **Auto** | The timeline above. Default. |
| **Local router** | Never falls back. Hotspot stays down even with no router. Use when a nearby PAX hotspot would confuse people. |
| **Standalone AP** | Master only. Hotspot always on, router never tried. Use at a show or a shop with no Wi-Fi. |

### Moving the system to a new workshop

Nothing needs a keyboard or a re-flash. Power everything on and:

1. **Master boots**, cannot find the old router, after 45 s starts
   `PAX-Setup-XXXX`.
2. **Slaves boot**, cannot find the old router, NetworkManager joins
   `PAX-Setup-XXXX` on its own. Each slave's agent connects to
   `ws://pax-master.local:8765` and registers (`net.register`). The master now
   lists them under *Slave units following this master*.
3. On a phone, join `PAX-Setup-XXXX` with the password from the install
   printout (or scan the QR in Settings → Network → Standalone hotspot), and
   open `http://10.42.0.1`.
4. **Settings → Network → Scan for Wi-Fi networks**, pick the new router, type
   its password, **Save & connect**.
5. The master first pushes the SSID/password to every registered slave
   (`net.join {fromMaster:true}`) and waits for their acks (5 s each). They
   only *store* the profile; they do not switch yet because the socket they
   are being asked on would die.
6. The master drops the hotspot and joins the router. The hotspot vanishing
   makes each slave's NetworkManager fall through to `pax-router`, which is
   now saved with the new credentials, so they follow within seconds.
7. Reconnect the phone to the workshop Wi-Fi and open
   `http://pax-master.local`. Every node is back online at its `.local` name.

If a slave was powered off during step 5, plug it in later: it lands on the
master's hotspot only if the master is still serving one, so instead the
master reappears in *Slave units* as offline. Press **Re-push credentials**
once it registers (it will, over whatever link it has), or simply leave it:
the next time the master falls back to AP mode both sides meet there again.

### Slave first contact without hotspot credentials

`--ap-ssid/--ap-psk` are optional on the slave installer **if the slave is on
the same router as the master at install time**. On its first registration
the master replies `net.registered {apSsid, apPsk}`; the slave stores them in
`/etc/paxnet.conf` and creates `pax-master-ap`. From then on it has the
fallback network. Check with:

```bash
sudo python3 /path/to/pi-agent/paxnet.py status
nmcli -f NAME,AUTOCONNECT,AUTOCONNECT-PRIORITY con show | grep pax-
```

### Debugging paxnet

```bash
python3 paxnet.py status          # what the agent would broadcast as net.status
python3 paxnet.py scan            # what the app's scanner shows
journalctl -u paternoster-agent -f | grep -e paxnet -e '\[agent\] net'
sudo cat /etc/paxnet.conf         # role / pin / hotspot creds / master host
```

| Symptom | Cause | Fix |
| --- | --- | --- |
| Panel says *nmcli not found* / mode `unknown` | Not NetworkManager | Bookworm image, or `raspi-config → Advanced → Network Config → NetworkManager` |
| `net.join` fails with *sudo: a password is required* | Sudoers rule missing | Re-run `install.sh` (writes `/etc/sudoers.d/paxnet`) |
| Master boots straight into hotspot every time | `pax-ap` has autoconnect on, or pin is `ap` | `nmcli con modify pax-ap connection.autoconnect no`; set pin to Auto |
| Slave never appears in the slaves table | Cannot resolve `pax-master.local` | Both need `avahi-daemon` running; try `ping pax-master.local` from the slave |
| Slave ignored pushed creds | Slave was on the master's hotspot but the ack timed out | Panel shows it under *failed*; press **Re-push credentials** |
| Phone joins the hotspot but the app will not load | App not running on the master | The web app must be hosted on the master Pi for AP mode to be useful |

## Wire protocol

The agent and app exchange newline-free JSON messages. This mirrors
`lib/node-protocol.ts` in the web app — keep the two in sync if you extend it.

**App → Pi**

| Message                              | Meaning                          |
| ------------------------------------ | -------------------------------- |
| `{"type":"hello"}`                   | Handshake request                |
| `{"type":"config","shelves":N,"moveSpeed":0.7,"homingSpeed":0.45,"rampPct":40,"motorMode":"dc"\|"servo","servoPulsesPerRev":4000,"servoMaxPps":8000,"servoMirrorB":true,"servoHoldTimeoutS":60}` | Shelf count + live motion tuning + drive selection. The motion fields are optional; omitted ones keep their current value, so they must be sent for the sliders to take effect. `servoMirrorB` applies to both drives. `servoHoldTimeoutS` is the idle auto-release (0 = hold always), persisted on the Pi. |
| `{"type":"release"}` / `{"type":"hold"}` | Servo only: de-energise the drives now so the carousel can be turned by hand / re-energise them. `release` is refused with a `fault` while moving; moves and jogs re-engage automatically |
| `{"type":"home"}`                    | Start homing                     |
| `{"type":"goto","shelf":N}`          | Rotate to shelf N (0-based)      |
| `{"type":"stop"}`                    | Emergency stop (also aborts a jog) |
| `{"type":"jog","motor":"a"\|"b"\|"both","direction":"up"\|"down","pulses":N}` | Servo drive: step one motor (or both) by exactly N pulses |
| `{"type":"jog","motor":"a"\|"b"\|"both","direction":"up"\|"down","ms":N,"speed":0.45}` | DC drive: run one motor (or both) for N milliseconds at `speed` duty (optional, agent default otherwise). An amount in the wrong unit for the live drive is answered with a `fault`. |
| `{"type":"net.status"}`              | Ask for a fresh `net.status` (+ `net.slaves` on a master) |
| `{"type":"net.scan"}`                | Rescan Wi-Fi → `net.scan`        |
| `{"type":"net.join","ssid":S,"psk":P}` | Save router + connect. Master pushes to slaves first. `psk:""` for an open network |
| `{"type":"net.mode","mode":"auto"\|"router"\|"ap"}` | Pin the mode (`ap` master only) |
| `{"type":"net.forget"}`              | Delete the saved router profile  |
| `{"type":"net.provision-slaves"}`    | Master: re-push saved router creds to all registered slaves |
| `{"type":"net.set-ap-psk","psk":P}`  | Master: change the hotspot password (pushes to slaves first, then rewrites `pax-ap`, bouncing it if live) |

**Pi ↔ Pi (slave's outbound socket to the master)**

| Message | Meaning |
| --- | --- |
| slave → master `{"type":"net.register","hostname":H,"mac":M,"mode":...,"ssid":...,"ip":...}` | Slave introduces itself on (re)connect |
| master → slave `{"type":"net.registered","master":H,"apSsid":S,"apPsk":P}` | Ack; slave stores the hotspot creds |
| master → slave `{"type":"net.join","fromMaster":true,"ssid":S,"psk":P,"apSsid":..,"apPsk":..}` | Store these router creds (do not switch yet) |
| master → slave `{"type":"net.set-ap-psk","fromMaster":true,"psk":P,"apSsid":S}` | Hotspot key changed; update `pax-master-ap` |
| slave → master `{"type":"net.ack","op":"join"\|"set-ap-psk","ok":true,"hostname":H}` | Stored |

**Pi → App**

| Message                                             | Meaning                         |
| --------------------------------------------------- | ------------------------------- |
| `{"type":"hello","name":...,"shelves":N,"motorMode":"dc"\|"servo","simulated":b}` | Handshake reply                 |
| `{"type":"state","status":...,"shelf":N,"homed":b}` | Full state snapshot             |
| `{"type":"servo","mode":"dc"\|"servo","mirrorB":b,"alarmA"?:b,"alarmB"?:b,"pulsesPerRev"?:N,"maxPps"?:N,"held"?:b,"holdTimeoutS"?:N,"jogMaxMs"?:N,"jogging"?:b,"motor"?:..,"direction"?:..,"pulses"?:N,"ms"?:N}` | Drive status; sent on connect, on a drive switch, when an ALM line changes, when the servos are released/engaged and around each jog. `mode` is the backend actually running — the app only enables the jog arrows once it matches the selected drive. Alarm/pulse fields are servo-only |
| `{"type":"pos","shelf":N}`                          | Passed a shelf (live position)  |
| `{"type":"arrived","shelf":N}`                      | Stopped at shelf N              |
| `{"type":"homed","shelf":0}`                        | Homing finished                 |
| `{"type":"fault","message":...}`                    | Jam / timeout / sensor error    |
| `{"type":"net.status","role":..,"pin":..,"mode":"router"\|"ap"\|"master-ap"\|"offline"\|"unknown","ssid":..,"signal":..,"ip":..,"gateway":..,"hostname":..,"apSsid":..,"routerSaved":b}` | Network picture; sent on connect and on every change |
| `{"type":"net.scan","networks":[{"ssid","signal","security","inUse"}]}` | Scan result |
| `{"type":"net.result","op":..,"ok":b,"error"?:..}`  | Outcome of a `net.*` op. `op:"join-starting"` / `"ap-starting"` are sent right before the Pi switches networks and drops this socket |
| `{"type":"net.slaves","slaves":[{"hostname","mac","online","mode","ssid","ip"}]}` | Master only: registered slaves |

Shelf indexes are **0-based** on the wire (shelf 0 = the index-sensor position),
matching the app's internal representation.
