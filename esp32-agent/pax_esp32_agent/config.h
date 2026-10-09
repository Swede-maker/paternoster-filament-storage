#pragma once

// ---------------------------------------------------------------------------
// PAX ESP32 slave agent — build-time settings.
//
// Everything marked "default" can be changed later from the app (Settings ->
// Hardware) or from the Wi-Fi setup page, and is then stored in flash. You
// only need to edit this file to change the PINS or the sensor polarity.
// ---------------------------------------------------------------------------

// ----- Network defaults (leave empty to use the setup hotspot instead) -----
#define DEFAULT_WIFI_SSID   ""
#define DEFAULT_WIFI_PSK    ""
// Hostname of the master Raspberry Pi. The ESP32 registers with it exactly
// like a slave Pi does, and joins the master's hotspot if the router is gone.
#define DEFAULT_MASTER_HOST "pax-master.local"
// Name shown in the app. The hostname becomes pax-esp32-XXXX (last 4 of MAC).
#define DEFAULT_AGENT_NAME  "ESP32 carousel"

#define AGENT_PORT          8765          // same port as the Pi agent
#define SETUP_AP_PASSWORD   "paxsetup"    // setup hotspot password (8+ chars)

// ----- Carousel defaults -----
#define DEFAULT_SHELVES       9
#define DEFAULT_MOTOR_MODE    "dc"        // "dc" (BTS7960) or "servo" (PUL/DIR)
#define DEFAULT_POSITION_MODE "sensor"    // "sensor" or "index" (Home only, servo)

// ----- Pins (ESP32 DevKit V1 / WROOM-32) -----
// The motor header is shared: the same 6 pins drive two BTS7960 bridges in DC
// mode, or two PUL/DIR servo drives in servo mode.
//            DC mode          servo mode
#define PIN_A1   25  // RPWM motor A   PUL motor A
#define PIN_A2   26  // LPWM motor A   DIR motor A
#define PIN_AEN  27  // R_EN+L_EN A    ENA motor A
#define PIN_B1   32  // RPWM motor B   PUL motor B
#define PIN_B2   33  // LPWM motor B   DIR motor B
#define PIN_BEN  14  // R_EN+L_EN B    ENA motor B

// Inputs. GPIO 34-39 are input-only and have NO internal pull-ups: the
// sensor interface (optocoupler board) must provide a pull-up to 3.3 V.
#define PIN_SHELF_SENSOR  34
#define PIN_HOME_SENSOR   35
#define PIN_ALARM_A       39   // servo ALM output (optional)
#define PIN_ALARM_B       36   // servo ALM output (optional)
#define PIN_ESTOP         13   // optional emergency-stop button to GND
#define PIN_STATUS_LED     2   // on-board LED: blinks = no Wi-Fi, solid = online

// ----- Polarity -----
// NPN inductive sensors through an optocoupler pull the GPIO LOW when they
// see metal. Set to 0 if your interface outputs HIGH on detection.
#define SENSOR_ACTIVE_LOW   1
// Set to 1 only when ALM- / ALM+ of both servo drives are wired with a
// pull-up; floating input-only pins would otherwise report fake alarms.
#define SERVO_ALARM_WIRED   0
#define ALARM_ACTIVE_LOW    1
// iSV57T: ENA is usually "enabled when the opto is OFF". 1 = drive the ENA pin
// HIGH to ENABLE, 0 = drive it LOW to enable.
#define SERVO_ENA_ACTIVE_HIGH 0
// The emergency-stop pin uses the internal pull-up; a button to GND triggers it.
#define ESTOP_FITTED        0

// ----- Timing (seconds unless noted) -----
#define SHELF_TIMEOUT_S     8.0    // no shelf flag for this long while moving -> fault
#define HOME_TIMEOUT_S     30.0    // index sensor not found -> fault
#define MOVE_TIMEOUT_S     90.0    // whole move limit in Home-only mode
#define DEFAULT_SENSOR_ARM_S 0.30  // "Safe move time": sensors ignored right after a start
#define SENSOR_ARM_MAX_S   10.0
#define SENSOR_DEBOUNCE_MS   10
#define RAMP_MAX_MS        1500    // soft start at 100 %
#define DC_JOG_MAX_MS      5000
#define WIFI_FALLBACK_S      45    // try the master hotspot after this long
#define PORTAL_AFTER_S       90    // open the setup hotspot after this long offline

// ESP32 LEDC tone output tops out around 78 kHz at 10-bit resolution.
#define ESP32_MAX_PPS     75000
