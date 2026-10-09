# PAX ESP32 slave agent

Firmware that turns an **ESP32** into a slave controller for one paternoster
carousel. It speaks the same WebSocket protocol on port **8765** as the Pi agent
(`pi-agent/paternoster_agent.py`). The app on the master Raspberry Pi drives it
the same way it drives a slave Pi: Go to shelf, Home, Calibrate, Jog, Stop, motor
settings, Safe move time and live sensor lamps.

| | Slave Pi | ESP32 |
|---|---|---|
| Carousels per board | 1, or 2 in twin mode | **1** (use one ESP32 per carousel) |
| DC motors (BTS7960) | yes | yes |
| Integrated servos (PUL/DIR) | yes | yes, up to 75 000 pulses/s |
| Positioning: Shelf sensor | yes | yes |
| Positioning: Home only (servo) | yes | yes |
| Registers with the master, gets Wi-Fi pushed | yes | yes |
| Joins the master hotspot when the router is gone | yes | yes |

## 1. What you need

- ESP32 DevKit V1 (ESP32-WROOM-32, 30 or 38 pin)
- The same motor drivers and sensors as a Pi carousel (see the main README)
- **One optocoupler board** (PC817, 2+ channels) for the 12–24 V inductive sensors
- For servo drives: a **5 V level shifter** (74HCT245 or a ULN2003 / transistor stage)
  for PUL / DIR / ENA. The iSV57T optos switch unreliably at 3.3 V.
- A 5 V supply for the ESP32 (USB or the `VIN` pin)

## 2. Wiring

> **Safety:**
> 1. **Common ground:** connect the ESP32 GND to the driver logic GND.
> 2. **Never** connect more than **3.3 V** to any ESP32 GPIO. The 12–24 V
>    sensors must go through the optocoupler board.
> 3. Motors get their **own** supply, never from the ESP32 board.

### Sensors (both drive types)

| Signal | ESP32 GPIO | Notes |
|---|---|---|
| Shelf sensor (one flag per shelf) | **GPIO 34** | Not needed with **Home only** positioning |
| Home / index sensor (one flag per turn) | **GPIO 35** | Required |
| Emergency stop button (optional) | **GPIO 13** to GND | Set `ESTOP_FITTED 1` in `config.h` |
| Status LED | GPIO 2 (on board) | Blinking = no Wi-Fi, solid = online |

GPIO 34–39 have **no internal pull-up**. Wire each sensor through the optocoupler
like this:

```
Sensor brown (+12..24 V) ── sensor supply +
Sensor blue  (0 V)       ── sensor supply −
Sensor black (NPN out)   ── opto IN−      opto IN+ ── sensor supply + (via the board's resistor)

Opto OUT (collector)     ── GPIO 34 / 35  ── 10 kΩ ── 3.3 V   (skip if the board has a pull-up)
Opto OUT (emitter)       ── ESP32 GND
```

When metal is under the sensor the GPIO is pulled **LOW** (`SENSOR_ACTIVE_LOW 1`).
If your board outputs HIGH on detection, set `SENSOR_ACTIVE_LOW 0`.

### DC motors: two BTS7960 / IBT-2 bridges

| BTS7960 pin | Motor A | Motor B |
|---|---|---|
| RPWM | **GPIO 25** | **GPIO 32** |
| LPWM | **GPIO 26** | **GPIO 33** |
| R_EN + L_EN (tie together) | **GPIO 27** | **GPIO 14** |
| VCC | ESP32 3.3 V | ESP32 3.3 V |
| GND | ESP32 GND | ESP32 GND |
| B+ / B− | motor supply | motor supply |
| M+ / M− | motor A | motor B |

The BTS7960 accepts 3.3 V logic directly. PWM runs at 20 kHz.

### Integrated servos: two iSV57T (PUL/DIR)

These are the same six pins as DC mode, through the 5 V level shifter:

| Drive input | Motor A | Motor B |
|---|---|---|
| PUL+ | **GPIO 25** → shifter → | **GPIO 32** → shifter → |
| DIR+ | **GPIO 26** → shifter → | **GPIO 33** → shifter → |
| ENA+ | **GPIO 27** → shifter → | **GPIO 14** → shifter → |
| PUL− / DIR− / ENA− | GND | GND |
| ALM+ (optional) | **GPIO 39** + 10 kΩ pull-up to 3.3 V | **GPIO 36** + 10 kΩ pull-up |
| ALM− | GND | GND |

Only set `SERVO_ALARM_WIRED 1` when the ALM pins are really connected. Floating
pins would otherwise report fake alarms. If the motor stays free with ENA wired,
flip `SERVO_ENA_ACTIVE_HIGH`.

## 3. Install the firmware

### Option A: Arduino IDE

1. Install **Arduino IDE 2**, then *Boards Manager* → **esp32 by Espressif Systems**.
2. *Library Manager*: install **WebSockets** (Markus Sattler) and **ArduinoJson** (Benoit Blanchon, v7).
3. Open `esp32-agent/pax_esp32_agent/pax_esp32_agent.ino`.
4. Optional: edit `config.h` (pins, sensor polarity, or your Wi-Fi name and password).
5. *Tools → Board*: **ESP32 Dev Module**. Choose the USB port and click **Upload**.
   If the upload hangs on "Connecting…", hold the **BOOT** button.
6. *Tools → Serial Monitor* at **115200** shows the hostname and the Wi-Fi status.

### Option B: PlatformIO

```bash
cd esp32-agent
pio run -t upload
pio device monitor
```

## 4. Connect it to the system

1. **Wi-Fi.** If you left the Wi-Fi fields in `config.h` empty, the ESP32 opens a
   hotspot named **`PAX-ESP32-xxxx`** (password `paxsetup`). Join it with your
   phone, open **http://192.168.4.1**, and enter:
   - your Wi-Fi name and password
   - the master hostname (default `pax-master.local`)
   - a carousel name
   
   Tap **Save and restart**.
2. **Master link.** The ESP32 joins the router and registers with the master,
   like a slave Pi. From then on Wi-Fi changes made on the master are pushed to it
   too. If the router is gone, it joins the master's hotspot after 45 s.
3. **Add it in the app.** Settings → **Hardware** (or Filament) → **Add storage
   unit** → driver **Hardware**. Then set:
   - **Address:** the ESP32 hostname from the serial monitor, for example
     `pax-esp32-3fa1.local` (or its IP address)
   - **Port:** `8765`
   
   It shows **Connected** within a few seconds.
4. **Set it up.** In the unit's Motor drive section, pick **DC motors** or
   **Integrated servos**. The ESP32 saves the choice and restarts once to switch
   pins. Then choose Positioning, set the shelf count and the **Safe move time**,
   and run **Home** and **Calibrate**.

## 5. Check the wiring

- **Sensors:** in the app, move a metal object in front of each sensor. The shelf
  lamp in Manual control must light, and Home must stop on the home flag.
- **Direction:** **Move Down** must move the shelves the same way as homing. If one
  motor runs backwards, use **Mirror motor B direction**. If both run backwards,
  use **Reverse direction**.
- **Serial monitor:** every fault is printed with an `[agent] fault:` prefix.

## Limits

- One carousel per ESP32: twin mode is refused with a message.
- The servo pulse rate is capped at **75 000 pulses/s** by the ESP32 PWM hardware.
  Higher values in the app are lowered automatically, and you get a warning.
- The ESP32 counts servo pulses from the rate it sends, not with a hardware counter.
  In Home only mode the position is corrected on every pass of the home flag.
