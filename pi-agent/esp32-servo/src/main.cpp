/*
 * PAX servo controller — ESP32 firmware
 * =====================================
 *
 * Sits between the Raspberry Pi (paternoster_agent.py, "ESP32" motor
 * controller) and two pulse + direction drives. ONE binary serves every
 * drive type; the Pi selects the profile at runtime with CFG profile=...:
 *
 *   ac-servo             StepperOnline A6-RS (DB44). S-ON enable, ALM
 *                        conducts while healthy, up to 300 kHz.
 *   integrated-servo     iSV57T-class motor with built-in drive. No enable
 *                        input (ENA drives an optional supply relay), ALM
 *                        conducts while healthy, up to 300 kHz.
 *   closed-loop-stepper  CL86Y-class closed-loop stepper drive. MF input
 *                        frees the coils when active, ALM conducts ON a
 *                        fault, up to 200 kHz.
 *
 * The Pi keeps every decision (which shelf, how fast, ramps, timeouts, chain
 * sync); this board only does the things Linux cannot do on time:
 *
 *   * generates the PUL trains for motor A and motor B from ONE hardware
 *     timer, so both chains always receive the same frequency in phase;
 *   * sends an exact pulse count for jogs (chain levelling);
 *   * pauses / resumes one motor on request (chain sync);
 *   * reads the shelf and home sensors with interrupts, debounces them and
 *     reports every edge with a microsecond timestamp and the pulse odometer;
 *   * can be ARMED to cut the pulse train itself on the next sensor edge, so
 *     the stop on the target shelf does not wait for a round trip to the Pi;
 *   * watches the two ALM (fault) outputs and the S-ON (enable) lines;
 *   * stops everything if the Pi goes quiet (cable pulled, agent crashed).
 *
 * LINK
 * ----
 * Newline-terminated ASCII, same syntax both ways, on ALL ports at once:
 *   USB   : UART0 (the DevKit's micro-USB / CP2102), /dev/ttyUSB0 on the Pi
 *   GPIO  : UART1 on RX=21 TX=22 (3.3 V, wire to Pi TXD/RXD + GND), /dev/serial0
 *   Wi-Fi : TCP port 8766 — a STANDALONE slave carousel with no Pi of its
 *           own; the master Pi's agent connects over the LAN or its own
 *           hotspot (see paxnet.h: WIFI / WIFIAP / NET / OTA)
 * Baud: PAX_LINK_BAUD (460800). Output is mirrored to every port; whichever
 * one the Pi is on simply sees it.
 *
 *   Pi -> ESP32
 *     HELLO                              -> HELLO pax-esp32 fw=.. pins=..
 *     CFG k=v [k=v ...]                  mirror=0|1 single=0|1 rev=0|1 npn=0|1
 *                                        maxpps=N bounce_us=N dirsetup_us=N
 *                                        jogpps=N status_hz=N wd_ms=N
 *                                        (wd_ms: silence before the motors
 *                                        stop; 1500 default, 3000 on Wi-Fi)
 *                                        profile=ac-servo|integrated-servo|
 *                                                closed-loop-stepper
 *                                        ena_low=0|1 alm_low=0|1
 *                                        (profile= sets the pulse ceiling and
 *                                        the two polarities; ena_low/alm_low
 *                                        AFTER it override them)
 *     RUN <dir> <hz>                     dir +1 = carousel "down", -1 = "up";
 *                                        hz 0 = stop. Repeat to change speed.
 *     STOP                               pulses off, motors HOLD position;
 *                                        also aborts a jog and clears ARM
 *     ENA 0|1                            0 = release (free to turn by hand)
 *     JOG a|b|both <dir> <pulses> [pps]  exact pulse count; answers JOGDONE
 *     HOLD 0|1                           pause ONE motor (chain sync)
 *     FREE 0|1 <dir> <hz>                run that motor again
 *     ARM S|H <level> [gap_us] | ARM 0   stop on the next edge of Shelf/Home
 *                                        whose ACTIVE level becomes <level>,
 *                                        after it was off that level >= gap_us
 *     PING                               keep-alive (watchdog)
 *
 *   ESP32 -> Pi
 *     BOOT                               once after reset
 *     OK <cmd> | ERR <reason>            one per command
 *     ST k=v ...                         status, status_hz times a second
 *     E S|H <level> <us> <pos>           sensor edge (after debounce)
 *     TRIP S|H <us> <pos>                an ARMed edge stopped the pulses
 *     JOGDONE <sent>                     jog finished or was aborted
 *     EV <text>                          watchdog / notices
 *
 * "level" is the sensor's ACTIVE state in the same sense the Pi's gpiozero
 * code uses: with npn=1 (sinking sensor, pulled up) active = pin LOW. The Pi
 * applies its own SENSOR_INVERT on top, exactly as it does for its GPIO.
 */

#include <Arduino.h>
#include "esp_timer.h"
#include "paxnet.h"

#ifndef PAX_FW_VERSION
#define PAX_FW_VERSION "1.2"
#endif
#ifndef PAX_LINK_BAUD
#define PAX_LINK_BAUD 460800
#endif
#ifndef PAX_ENA_LOW
#define PAX_ENA_LOW 0
#endif

// ---------------------------------------------------------------------------
// Pins (ESP32 DevKit V1, 30-pin). See README.md for the DB44 side.
// ---------------------------------------------------------------------------
static const int PIN_PUL_A = 25;
static const int PIN_DIR_A = 26;
static const int PIN_ENA_A = 27;
static const int PIN_PUL_B = 32;
static const int PIN_DIR_B = 33;
static const int PIN_ENA_B = 14;
static const int PIN_ALM_A = 18;   // INPUT_PULLUP; drive conducts (LOW) when healthy
static const int PIN_ALM_B = 19;
static const int PIN_SHELF = 4;    // inductive sensor, one flag per shelf
static const int PIN_HOME  = 13;   // inductive sensor, one flag at shelf 1
static const int PIN_LED   = 2;    // on-board LED: steady = link up, blink = no Pi
static const int PIN_LINK_RX = 21; // GPIO UART to the Pi (optional, see README)
static const int PIN_LINK_TX = 22;

// LEDC channels 0 and 1 share timer 0, which is what keeps A and B in phase.
static const int LEDC_CH_A = 0;
static const int LEDC_CH_B = 1;
static const int LEDC_RES_BITS = 8;          // 8 bits still allows 300 kHz
static const uint32_t LEDC_DUTY_ON = 128;    // 50 %

static const uint32_t ABS_MAX_PPS = 300000;
static const uint32_t MIN_PPS = 50;
static const uint32_t WATCHDOG_MS = 1500;    // no line from the Pi -> stop (default; CFG wd_ms=)
static const size_t PARSER_LINE_MAX = 200;

// Arduino-ESP32 3.x makes constrain() a template that needs all three
// arguments to be the exact same type, and on the newer Xtensa toolchain
// uint32_t is `unsigned long` while `200000u` is `unsigned int`.
static inline uint32_t clampU32(uint32_t v, uint32_t lo, uint32_t hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// ---------------------------------------------------------------------------
// Drive profiles (selected at runtime by CFG profile=...)
// ---------------------------------------------------------------------------
enum DriveProfile : uint8_t { PROFILE_AC_SERVO = 0, PROFILE_INTEGRATED_SERVO = 1, PROFILE_CL_STEPPER = 2 };

struct ProfileSpec {
  const char* name;
  uint32_t ceilingPps;   // the drive's rated pulse input frequency
  bool enaLowEngages;    // GPIO LOW on ENA = motor engaged (see Config)
  bool almLowIsFault;    // ALM optocoupler conducts (pin LOW) ON a fault
};

// Keep in step with PULSE_DRIVE_PROFILES in the Pi agent and the app.
static const ProfileSpec PROFILES[] = {
  { "ac-servo",            300000, false, false },
  { "integrated-servo",    300000, false, false },
  { "closed-loop-stepper", 200000, false, true  },
};

// ---------------------------------------------------------------------------
// Configuration (set by CFG, defaults match the Pi agent's constants)
// ---------------------------------------------------------------------------
struct Config {
  bool mirrorB = true;        // motor B faces the other way across the carousel
  bool single = false;        // only motor A is pulsed / monitored
  bool reverse = false;       // flip both directions
  bool npn = true;            // sensors sink to GND when active
  uint8_t profile = PROFILE_AC_SERVO;
  uint32_t ceilingPps = 300000; // from the profile; RUN/JOG never exceed it
  uint32_t maxPps = 8000;     // RUN hz is clamped to this (and to ceilingPps)
  uint32_t bounceUs = 10000;  // sensor debounce (gpiozero bounce_time = 0.01 s)
  uint32_t dirSetupUs = 1000; // DIR stable before pulses resume
  uint32_t jogPps = 800;
  uint32_t statusHz = 20;
  uint32_t watchdogMs = WATCHDOG_MS;
  // S-ON polarity. The A6-RS S-ON input is a 24 V input, so the README wires
  // it through an NPN transistor / ULN2003: GPIO HIGH turns the transistor on,
  // which pulls S-ON to COM- and enables the drive -> HIGH = ON (ena_low=0).
  // Build with -DPAX_ENA_LOW=1 (or send CFG ena_low=1) for a direct
  // common-anode optocoupler hookup where GPIO LOW = ON.
  // On a closed-loop stepper the input is MF ("motor free"): MF conducting =
  // coils OFF. The README wires it common-anode (+5 V on MF+, GPIO sinks
  // MF-), so GPIO LOW = MF conducting = released and GPIO HIGH = engaged:
  // again ena_low=0. If you drive MF through the S-ON transistor instead,
  // the sense flips -> send ena_low=1 (the app's "GPIO LOW engages" box).
  bool enaLowEngages = (PAX_ENA_LOW != 0);
  // ALM polarity. iSV57T / A6-RS conduct while healthy (open = fault);
  // CL86Y conducts on a fault. Set by the profile, overridable with alm_low=.
  bool almLowIsFault = false;
} cfg;

static void applyProfile(uint8_t p) {
  if (p >= sizeof(PROFILES) / sizeof(PROFILES[0])) p = PROFILE_AC_SERVO;
  cfg.profile = p;
  cfg.ceilingPps = PROFILES[p].ceilingPps;
  cfg.enaLowEngages = PROFILES[p].enaLowEngages || (PAX_ENA_LOW != 0);
  cfg.almLowIsFault = PROFILES[p].almLowIsFault;
  if (cfg.maxPps > cfg.ceilingPps) cfg.maxPps = cfg.ceilingPps;
}

// ---------------------------------------------------------------------------
// Motion state
// ---------------------------------------------------------------------------
static volatile bool g_running = false;       // continuous train active
static volatile uint32_t g_hz = 0;
static volatile int g_dir = +1;               // +1 = carousel down
static bool g_held[2] = {false, false};       // chain-sync pause per motor
static bool g_engaged = true;
static bool g_dirLevel[2] = {false, false};

// Pulse odometer: hz x time while running (signed by direction), exact counts
// for jogs. Reset only by power cycle; the Pi re-syncs it on every home flag.
static double g_pos = 0.0;
static uint32_t g_posLastUs = 0;

// Jog
static esp_timer_handle_t g_jogTimer = nullptr;
static volatile bool g_jogActive = false;
static volatile uint32_t g_jogRemainingHalf = 0;   // half-periods left
static volatile uint32_t g_jogSentPulses = 0;
static volatile bool g_jogPhaseHigh = false;
static volatile bool g_jogDoneFlag = false;
static bool g_jogTargets[2] = {false, false};
static int g_jogDir = +1;
static bool g_jogMovesCarousel = false;

// ARM (hardware stop on sensor edge)
static volatile int8_t g_armSensor = -1;      // -1 none, 0 shelf, 1 home
static volatile uint8_t g_armLevel = 1;
static volatile uint32_t g_armGapUs = 0;      // sensor must have been off-level this long
static volatile bool g_armReady = false;      // off-level seen since arming
static volatile bool g_tripFlag = false;
static volatile uint32_t g_tripUs = 0;
static volatile int8_t g_tripSensor = -1;

// Sensors
struct Edge { uint8_t sensor; uint8_t level; uint32_t us; };
static const size_t EDGE_RING = 64;
static volatile Edge g_edges[EDGE_RING];
static volatile uint8_t g_edgeHead = 0, g_edgeTail = 0;
static volatile uint8_t g_level[2] = {0, 0};
static volatile uint32_t g_lastEdgeUs[2] = {0, 0};
static volatile uint8_t g_rawPending[2] = {0, 0};
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;

// Link
static uint32_t g_lastRxMs = 0;
static bool g_linkUp = false;
static bool g_wdTripped = false;
static uint32_t g_lastStatusMs = 0;
static char g_lineUsb[PARSER_LINE_MAX]; static size_t g_lenUsb = 0;
static char g_lineUart[PARSER_LINE_MAX]; static size_t g_lenUart = 0;
static char g_lineTcp[PARSER_LINE_MAX]; static size_t g_lenTcp = 0;

HardwareSerial LinkUart(1);

// ---------------------------------------------------------------------------
// Output to every port
// ---------------------------------------------------------------------------
static void out(const char* s) {
  Serial.println(s);
  LinkUart.println(s);
  paxnet::print(s);
}
static void outf(const char* fmt, ...) {
  char buf[256];
  va_list ap; va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  out(buf);
}

// ---------------------------------------------------------------------------
// LEDC compatibility (Arduino core 2.x vs 3.x)
// ---------------------------------------------------------------------------
static void pulseSetup(int pin, int ch) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttachChannel(pin, 1000, LEDC_RES_BITS, ch);
  ledcWriteChannel(ch, 0);
#else
  ledcSetup(ch, 1000, LEDC_RES_BITS);
  ledcAttachPin(pin, ch);
  ledcWrite(ch, 0);
#endif
}
static void pulseDuty(int pin, int ch, uint32_t duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)pin;
  ledcWriteChannel(ch, duty);
#else
  (void)pin;
  ledcWrite(ch, duty);
#endif
}
static void pulseFreq(int pin, int ch, uint32_t hz) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)ch;
  ledcChangeFrequency(pin, hz, LEDC_RES_BITS);
#else
  (void)pin;
  ledcChangeFrequency(ch, hz, LEDC_RES_BITS);
#endif
}
static void pulseDetach(int pin) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcDetach(pin);
#else
  ledcDetachPin(pin);
#endif
  pinMode(pin, OUTPUT);
  digitalWrite(pin, LOW);
}
static void pulseReattach(int pin, int ch) {
  pulseSetup(pin, ch);
}

static inline int pulPin(int m) { return m == 0 ? PIN_PUL_A : PIN_PUL_B; }
static inline int dirPin(int m) { return m == 0 ? PIN_DIR_A : PIN_DIR_B; }
static inline int enaPin(int m) { return m == 0 ? PIN_ENA_A : PIN_ENA_B; }
static inline int ledcCh(int m) { return m == 0 ? LEDC_CH_A : LEDC_CH_B; }
static inline bool motorUsed(int m) { return m == 0 || !cfg.single; }

// ---------------------------------------------------------------------------
// Odometer
// ---------------------------------------------------------------------------
static void odoIntegrate() {
  uint32_t now = micros();
  if (g_running && g_hz > 0 && !(g_held[0] && (g_held[1] || cfg.single))) {
    double dt = (double)(uint32_t)(now - g_posLastUs) / 1e6;
    g_pos += (double)g_dir * (double)g_hz * dt;
  }
  g_posLastUs = now;
}

// ---------------------------------------------------------------------------
// Direction / enable
// ---------------------------------------------------------------------------
static void applyDir(int dir) {
  bool fwd = (dir > 0) != cfg.reverse;
  g_dirLevel[0] = fwd;
  g_dirLevel[1] = cfg.mirrorB ? !fwd : fwd;
  digitalWrite(PIN_DIR_A, g_dirLevel[0]);
  digitalWrite(PIN_DIR_B, g_dirLevel[1]);
}
static void applyEnable(bool engaged) {
  bool level = engaged ? !cfg.enaLowEngages : cfg.enaLowEngages;
  digitalWrite(PIN_ENA_A, level);
  digitalWrite(PIN_ENA_B, level);
  g_engaged = engaged;
}

// ---------------------------------------------------------------------------
// Continuous pulse train
// ---------------------------------------------------------------------------
static void trainOff() {
  odoIntegrate();
  pulseDuty(PIN_PUL_A, LEDC_CH_A, 0);
  pulseDuty(PIN_PUL_B, LEDC_CH_B, 0);
  g_running = false;
  g_hz = 0;
}

static void trainRun(int dir, uint32_t hz) {
  if (hz == 0) { trainOff(); return; }
  if (hz > cfg.maxPps) hz = cfg.maxPps;
  if (hz > cfg.ceilingPps) hz = cfg.ceilingPps;
  if (hz > ABS_MAX_PPS) hz = ABS_MAX_PPS;
  if (hz < MIN_PPS) hz = MIN_PPS;

  if (g_running && dir == g_dir && hz == g_hz) return;
  if (!g_running || dir != g_dir) {
    // Never flip DIR under a running train: stop, set it, let it settle.
    trainOff();
    applyDir(dir);
    delayMicroseconds(cfg.dirSetupUs);
  } else {
    odoIntegrate();
  }
  g_dir = dir;
  g_hz = hz;
  // Both channels sit on timer 0: one frequency change moves both.
  pulseFreq(PIN_PUL_A, LEDC_CH_A, hz);
  for (int m = 0; m < 2; m++) {
    bool on = motorUsed(m) && !g_held[m];
    pulseDuty(pulPin(m), ledcCh(m), on ? LEDC_DUTY_ON : 0);
  }
  g_running = true;
  g_posLastUs = micros();
}

static void holdOne(int m) {
  g_held[m] = true;
  pulseDuty(pulPin(m), ledcCh(m), 0);
}
static void freeOne(int m, int dir, uint32_t hz) {
  g_held[m] = false;
  if (g_running && dir == g_dir) {
    pulseDuty(pulPin(m), ledcCh(m), motorUsed(m) ? LEDC_DUTY_ON : 0);
  } else {
    trainRun(dir, hz);
  }
}

// ---------------------------------------------------------------------------
// Jog: exact pulse count via esp_timer (half-period callback)
// ---------------------------------------------------------------------------
static void IRAM_ATTR jogTick(void*) {
  if (g_jogRemainingHalf == 0) {
    g_jogDoneFlag = true;
    return;
  }
  g_jogPhaseHigh = !g_jogPhaseHigh;
  for (int m = 0; m < 2; m++) {
    if (g_jogTargets[m]) digitalWrite(pulPin(m), g_jogPhaseHigh ? HIGH : LOW);
  }
  if (!g_jogPhaseHigh) g_jogSentPulses = g_jogSentPulses + 1;   // count on the falling half
  g_jogRemainingHalf = g_jogRemainingHalf - 1;
  if (g_jogRemainingHalf == 0) g_jogDoneFlag = true;
}

static void jogFinish() {
  if (g_jogTimer) esp_timer_stop(g_jogTimer);
  for (int m = 0; m < 2; m++) {
    if (g_jogTargets[m]) {
      digitalWrite(pulPin(m), LOW);
      pulseReattach(pulPin(m), ledcCh(m));
    }
    g_jogTargets[m] = false;
  }
  if (g_jogMovesCarousel) g_pos += (double)g_jogDir * (double)g_jogSentPulses;
  g_jogActive = false;
  g_jogDoneFlag = false;
  outf("JOGDONE %u", (unsigned)g_jogSentPulses);
}

static bool jogStart(const char* which, int dir, uint32_t pulses, uint32_t pps) {
  if (g_jogActive) return false;
  bool a = false, b = false;
  if (strcmp(which, "a") == 0) a = true;
  else if (strcmp(which, "b") == 0) b = !cfg.single;
  else { a = true; b = !cfg.single; }
  if (!a && !b) { outf("JOGDONE 0"); return true; }
  if (pps < MIN_PPS) pps = cfg.jogPps;
  if (pps > 20000) pps = 20000;

  trainOff();
  applyDir(dir);
  delayMicroseconds(cfg.dirSetupUs);
  g_jogTargets[0] = a; g_jogTargets[1] = b;
  g_jogDir = dir;
  g_jogMovesCarousel = (a && b) || (a && cfg.single);
  for (int m = 0; m < 2; m++) if (g_jogTargets[m]) pulseDetach(pulPin(m));
  g_jogSentPulses = 0;
  g_jogPhaseHigh = false;
  g_jogRemainingHalf = pulses * 2;
  g_jogDoneFlag = false;
  g_jogActive = true;
  esp_timer_start_periodic(g_jogTimer, 500000ULL / pps);
  return true;
}

static void jogAbort() {
  if (!g_jogActive) return;
  g_jogRemainingHalf = 0;
  jogFinish();
}

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------
static inline uint8_t activeLevel(int pin) {
  int raw = digitalRead(pin);
  return cfg.npn ? (raw == LOW) : (raw == HIGH);
}

// Called with g_mux held, on every accepted level change of sensor `s`.
// A trip needs: ARMed on this sensor, the sensor seen OFF the arm level since
// arming, and that off period at least g_armGapUs long — so the flag that was
// just counted rocking back into the window (a short gap) never stops the
// carousel early, while the next shelf (a gap of most of a pitch) does.
static inline void IRAM_ATTR armCheck(int s, uint8_t lvl, uint32_t now, uint32_t prevEdge) {
  if (g_armSensor != s || g_tripFlag) return;
  if (lvl != g_armLevel) { g_armReady = true; return; }
  if (!g_armReady) return;
  if ((uint32_t)(now - prevEdge) < g_armGapUs) { g_armReady = false; return; }
  g_tripFlag = true;
  g_tripUs = now;
  g_tripSensor = s;
  g_armSensor = -1;
}

static void IRAM_ATTR sensorIsr(void* arg) {
  int s = (int)(intptr_t)arg;
  int pin = s == 0 ? PIN_SHELF : PIN_HOME;
  uint32_t now = micros();
  uint8_t lvl = cfg.npn ? (digitalRead(pin) == LOW) : (digitalRead(pin) == HIGH);
  portENTER_CRITICAL_ISR(&g_mux);
  // Debounce the way gpiozero does: a change inside bounce_us of the last
  // ACCEPTED change is ignored. The level is re-read by the main loop after
  // the window so a bounce that ends in a new state is still noticed.
  if ((uint32_t)(now - g_lastEdgeUs[s]) < cfg.bounceUs) {
    g_rawPending[s] = 1;
    portEXIT_CRITICAL_ISR(&g_mux);
    return;
  }
  if (lvl == g_level[s]) { portEXIT_CRITICAL_ISR(&g_mux); return; }
  uint32_t prevEdge = g_lastEdgeUs[s];
  g_level[s] = lvl;
  g_lastEdgeUs[s] = now;
  uint8_t next = (g_edgeHead + 1) % EDGE_RING;
  if (next != g_edgeTail) {
    g_edges[g_edgeHead].sensor = s;
    g_edges[g_edgeHead].level = lvl;
    g_edges[g_edgeHead].us = now;
    g_edgeHead = next;
  }
  armCheck(s, lvl, now, prevEdge);
  portEXIT_CRITICAL_ISR(&g_mux);
}

static void sensorsSettle() {
  // After a bounce window closes, make sure the stored level matches reality.
  for (int s = 0; s < 2; s++) {
    if (!g_rawPending[s]) continue;
    uint32_t now = micros();
    if ((uint32_t)(now - g_lastEdgeUs[s]) < cfg.bounceUs) continue;
    int pin = s == 0 ? PIN_SHELF : PIN_HOME;
    uint8_t lvl = activeLevel(pin);
    portENTER_CRITICAL(&g_mux);
    g_rawPending[s] = 0;
    if (lvl != g_level[s]) {
      uint32_t prevEdge = g_lastEdgeUs[s];
      g_level[s] = lvl;
      g_lastEdgeUs[s] = now;
      uint8_t next = (g_edgeHead + 1) % EDGE_RING;
      if (next != g_edgeTail) {
        g_edges[g_edgeHead].sensor = s;
        g_edges[g_edgeHead].level = lvl;
        g_edges[g_edgeHead].us = now;
        g_edgeHead = next;
      }
      armCheck(s, lvl, now, prevEdge);
    }
    portEXIT_CRITICAL(&g_mux);
  }
}

// A noisy sensor line can refill the ring as fast as it drains; capping the
// lines per pass keeps loop() reaching the status and watchdog steps.
static const int EDGES_PER_PASS = 16;

static void drainEdges() {
  for (int sent = 0; sent < EDGES_PER_PASS && g_edgeTail != g_edgeHead; sent++) {
    Edge e;
    portENTER_CRITICAL(&g_mux);
    e.sensor = g_edges[g_edgeTail].sensor;
    e.level = g_edges[g_edgeTail].level;
    e.us = g_edges[g_edgeTail].us;
    g_edgeTail = (g_edgeTail + 1) % EDGE_RING;
    portEXIT_CRITICAL(&g_mux);
    outf("E %c %u %lu %.1f", e.sensor == 0 ? 'S' : 'H', (unsigned)e.level,
         (unsigned long)e.us, g_pos);
  }
}

// ---------------------------------------------------------------------------
// Alarms (debounced 50 ms)
// ---------------------------------------------------------------------------
static bool g_alm[2] = {false, false};
static uint32_t g_almChangeMs[2] = {0, 0};
static bool g_almRaw[2] = {false, false};

static void pollAlarms() {
  uint32_t now = millis();
  for (int m = 0; m < 2; m++) {
    // Servo drives: the opto conducts (pulls LOW) while healthy, open = fault.
    // Closed-loop stepper drives: the opto conducts ON a fault (alm_low=1).
    bool high = digitalRead(m == 0 ? PIN_ALM_A : PIN_ALM_B) == HIGH;
    bool raw = cfg.almLowIsFault ? !high : high;
    if (raw != g_almRaw[m]) { g_almRaw[m] = raw; g_almChangeMs[m] = now; }
    else if (raw != g_alm[m] && now - g_almChangeMs[m] >= 50) g_alm[m] = raw;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
static void sendStatus() {
  odoIntegrate();
  outf("ST run=%d hz=%u dir=%d ena=%d s=%u h=%u aa=%d ab=%d pos=%.1f jog=%d arm=%d hold=%d%d up=%lu%s",
       g_running ? 1 : 0, (unsigned)g_hz, g_dir, g_engaged ? 1 : 0,
       (unsigned)g_level[0], (unsigned)g_level[1],
       g_alm[0] ? 1 : 0, (cfg.single ? 0 : (g_alm[1] ? 1 : 0)),
       g_pos, g_jogActive ? 1 : 0, g_armSensor >= 0 ? 1 : 0,
       g_held[0] ? 1 : 0, g_held[1] ? 1 : 0, (unsigned long)millis(), paxnet::statusSuffix());
}

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------
static bool parseBool(const char* v, bool& outv) {
  if (strcmp(v, "1") == 0 || strcmp(v, "true") == 0) { outv = true; return true; }
  if (strcmp(v, "0") == 0 || strcmp(v, "false") == 0) { outv = false; return true; }
  return false;
}

static void handleCfg(char* rest) {
  char* save = nullptr;
  for (char* tok = strtok_r(rest, " ", &save); tok; tok = strtok_r(nullptr, " ", &save)) {
    char* eq = strchr(tok, '=');
    if (!eq) continue;
    *eq = 0;
    const char* k = tok; const char* v = eq + 1;
    bool bv; uint32_t nv = strtoul(v, nullptr, 10);
    if (!strcmp(k, "mirror") && parseBool(v, bv)) cfg.mirrorB = bv;
    else if (!strcmp(k, "single") && parseBool(v, bv)) {
      cfg.single = bv;
      if (bv) pulseDuty(PIN_PUL_B, LEDC_CH_B, 0);
    }
    else if (!strcmp(k, "rev") && parseBool(v, bv)) cfg.reverse = bv;
    else if (!strcmp(k, "npn") && parseBool(v, bv)) {
      cfg.npn = bv;
      pinMode(PIN_SHELF, bv ? INPUT_PULLUP : INPUT_PULLDOWN);
      pinMode(PIN_HOME, bv ? INPUT_PULLUP : INPUT_PULLDOWN);
      g_level[0] = activeLevel(PIN_SHELF);
      g_level[1] = activeLevel(PIN_HOME);
    }
    else if (!strcmp(k, "maxpps")) {
      uint32_t ceiling = cfg.ceilingPps < ABS_MAX_PPS ? cfg.ceilingPps : ABS_MAX_PPS;
      cfg.maxPps = clampU32(nv, MIN_PPS, ceiling);
    }
    else if (!strcmp(k, "bounce_us")) cfg.bounceUs = clampU32(nv, 0, 200000);
    else if (!strcmp(k, "dirsetup_us")) cfg.dirSetupUs = clampU32(nv, 5, 20000);
    else if (!strcmp(k, "jogpps")) cfg.jogPps = clampU32(nv, MIN_PPS, 20000);
    else if (!strcmp(k, "status_hz")) cfg.statusHz = clampU32(nv, 1, 100);
    else if (!strcmp(k, "wd_ms")) cfg.watchdogMs = clampU32(nv, 500, 10000);
    else if (!strcmp(k, "profile")) {
      // The profile resets both polarities to the drive's defaults, so the
      // Pi sends it BEFORE any ena_low / alm_low override on the same line.
      uint8_t p = PROFILE_AC_SERVO;
      for (uint8_t i = 0; i < sizeof(PROFILES) / sizeof(PROFILES[0]); i++) {
        if (!strcmp(v, PROFILES[i].name)) { p = i; break; }
      }
      // Short aliases for typing by hand on a terminal.
      if (!strcmp(v, "isv")) p = PROFILE_INTEGRATED_SERVO;
      else if (!strcmp(v, "clstep") || !strcmp(v, "stepper")) p = PROFILE_CL_STEPPER;
      bool wasEngaged = g_engaged;
      applyProfile(p);
      applyEnable(wasEngaged);
      // The alarm debounce state was read in the old polarity.
      for (int m = 0; m < 2; m++) { g_alm[m] = false; g_almRaw[m] = false; g_almChangeMs[m] = millis(); }
    }
    else if (!strcmp(k, "ena_low") && parseBool(v, bv)) { cfg.enaLowEngages = bv; applyEnable(g_engaged); }
    else if (!strcmp(k, "alm_low") && parseBool(v, bv)) {
      cfg.almLowIsFault = bv;
      for (int m = 0; m < 2; m++) { g_alm[m] = false; g_almRaw[m] = false; g_almChangeMs[m] = millis(); }
    }
  }
  applyDir(g_dir);
  outf("OK CFG mirror=%d single=%d rev=%d npn=%d maxpps=%u bounce_us=%u dirsetup_us=%u jogpps=%u status_hz=%u "
       "profile=%s ceiling=%u ena_low=%d alm_low=%d",
       cfg.mirrorB, cfg.single, cfg.reverse, cfg.npn, (unsigned)cfg.maxPps, (unsigned)cfg.bounceUs,
       (unsigned)cfg.dirSetupUs, (unsigned)cfg.jogPps, (unsigned)cfg.statusHz,
       PROFILES[cfg.profile].name, (unsigned)cfg.ceilingPps, cfg.enaLowEngages, cfg.almLowIsFault);
}

static void handleLine(char* line) {
  // Trim
  while (*line == ' ' || *line == '\r') line++;
  size_t n = strlen(line);
  while (n && (line[n - 1] == ' ' || line[n - 1] == '\r')) line[--n] = 0;
  if (!n) return;

  g_lastRxMs = millis();
  if (!g_linkUp) { g_linkUp = true; digitalWrite(PIN_LED, HIGH); }
  g_wdTripped = false;

  char* save = nullptr;
  char* cmd = strtok_r(line, " ", &save);
  char* rest = save ? save : (char*)"";

  if (!strcmp(cmd, "PING")) { out("OK PING"); return; }
  if (!strcmp(cmd, "HELLO")) {
    outf("HELLO pax-esp32 fw=%s baud=%u profile=%s profiles=ac-servo,integrated-servo,closed-loop-stepper "
         "pul=%d/%d dir=%d/%d ena=%d/%d alm=%d/%d shelf=%d home=%d uart_rx=%d uart_tx=%d host=%s wifi=1",
         PAX_FW_VERSION, (unsigned)PAX_LINK_BAUD, PROFILES[cfg.profile].name, PIN_PUL_A, PIN_PUL_B, PIN_DIR_A, PIN_DIR_B,
         PIN_ENA_A, PIN_ENA_B, PIN_ALM_A, PIN_ALM_B, PIN_SHELF, PIN_HOME, PIN_LINK_RX, PIN_LINK_TX, paxnet::hostname());
    sendStatus();
    return;
  }
  if (!strcmp(cmd, "CFG")) { handleCfg(rest); return; }
  if (!strcmp(cmd, "STOP")) {
    jogAbort();
    g_armSensor = -1;
    trainOff();
    out("OK STOP");
    return;
  }
  if (!strcmp(cmd, "RUN")) {
    char* d = strtok_r(nullptr, " ", &save);
    char* h = strtok_r(nullptr, " ", &save);
    if (!d || !h) { out("ERR RUN needs <dir> <hz>"); return; }
    int dir = atoi(d) < 0 ? -1 : +1;
    uint32_t hz = strtoul(h, nullptr, 10);
    if (g_jogActive) jogAbort();
    if (!g_engaged) { applyEnable(true); }
    trainRun(dir, hz);
    outf("OK RUN %d %u", g_dir, (unsigned)g_hz);
    return;
  }
  if (!strcmp(cmd, "ENA")) {
    char* v = strtok_r(nullptr, " ", &save);
    bool on;
    if (!v || !parseBool(v, on)) { out("ERR ENA needs 0|1"); return; }
    if (!on) { jogAbort(); trainOff(); }
    applyEnable(on);
    outf("OK ENA %d", on ? 1 : 0);
    return;
  }
  if (!strcmp(cmd, "JOG")) {
    char* which = strtok_r(nullptr, " ", &save);
    char* d = strtok_r(nullptr, " ", &save);
    char* p = strtok_r(nullptr, " ", &save);
    char* r = strtok_r(nullptr, " ", &save);
    if (!which || !d || !p) { out("ERR JOG needs a|b|both <dir> <pulses> [pps]"); return; }
    int dir = atoi(d) < 0 ? -1 : +1;
    uint32_t pulses = strtoul(p, nullptr, 10);
    uint32_t pps = r ? strtoul(r, nullptr, 10) : cfg.jogPps;
    if (pulses == 0) { out("OK JOG"); out("JOGDONE 0"); return; }
    if (pulses > 200000) pulses = 200000;
    if (!g_engaged) applyEnable(true);
    if (!jogStart(which, dir, pulses, pps)) { out("ERR JOG busy"); return; }
    outf("OK JOG %s %d %u %u", which, dir, (unsigned)pulses, (unsigned)pps);
    return;
  }
  if (!strcmp(cmd, "HOLD")) {
    char* m = strtok_r(nullptr, " ", &save);
    if (!m) { out("ERR HOLD needs 0|1"); return; }
    int idx = atoi(m) ? 1 : 0;
    holdOne(idx);
    outf("OK HOLD %d", idx);
    return;
  }
  if (!strcmp(cmd, "FREE")) {
    char* m = strtok_r(nullptr, " ", &save);
    char* d = strtok_r(nullptr, " ", &save);
    char* h = strtok_r(nullptr, " ", &save);
    if (!m || !d || !h) { out("ERR FREE needs <motor> <dir> <hz>"); return; }
    int idx = atoi(m) ? 1 : 0;
    freeOne(idx, atoi(d) < 0 ? -1 : +1, strtoul(h, nullptr, 10));
    outf("OK FREE %d", idx);
    return;
  }
  if (!strcmp(cmd, "ARM")) {
    char* s = strtok_r(nullptr, " ", &save);
    char* l = strtok_r(nullptr, " ", &save);
    if (!s) { out("ERR ARM needs S|H <level> or 0"); return; }
    if (!strcmp(s, "0")) { g_armSensor = -1; out("OK ARM 0"); return; }
    if (!l) { out("ERR ARM needs <level>"); return; }
    char* g = strtok_r(nullptr, " ", &save);
    int8_t which = (!strcmp(s, "S")) ? 0 : (!strcmp(s, "H") ? 1 : -1);
    if (which < 0) { out("ERR ARM sensor must be S or H"); return; }
    portENTER_CRITICAL(&g_mux);
    g_tripFlag = false;
    g_armLevel = atoi(l) ? 1 : 0;
    g_armGapUs = g ? strtoul(g, nullptr, 10) : 0;
    // Off-level right now counts as "seen off" only if it has already lasted
    // the gap; otherwise wait for the next genuine exit.
    g_armReady = (g_level[which] != g_armLevel) &&
                 ((uint32_t)(micros() - g_lastEdgeUs[which]) >= g_armGapUs);
    g_armSensor = which;
    portEXIT_CRITICAL(&g_mux);
    outf("OK ARM %s %d %lu", s, g_armLevel, (unsigned long)g_armGapUs);
    return;
  }
  if (paxnet::handleCommand(cmd, save, out)) return;
  outf("ERR unknown command %s", cmd);
}

static void pump(Stream& port, char* buf, size_t& len) {
  while (port.available()) {
    char c = (char)port.read();
    if (c == '\n') {
      buf[len] = 0;
      handleLine(buf);
      len = 0;
    } else if (len < PARSER_LINE_MAX - 1) {
      buf[len++] = c;
    } else {
      len = 0; // overlong line: drop it
    }
  }
}

// ---------------------------------------------------------------------------
// Arduino entry points
// ---------------------------------------------------------------------------
void setup() {
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);

  pinMode(PIN_DIR_A, OUTPUT); pinMode(PIN_DIR_B, OUTPUT);
  pinMode(PIN_ENA_A, OUTPUT); pinMode(PIN_ENA_B, OUTPUT);
  applyProfile(PROFILE_AC_SERVO); // until the Pi's first CFG names the real drive
  applyEnable(true);           // power-up engaged, like the drive's own default
  applyDir(+1);

  pulseSetup(PIN_PUL_A, LEDC_CH_A);
  pulseSetup(PIN_PUL_B, LEDC_CH_B);

  pinMode(PIN_ALM_A, INPUT_PULLUP);
  pinMode(PIN_ALM_B, INPUT_PULLUP);

  pinMode(PIN_SHELF, cfg.npn ? INPUT_PULLUP : INPUT_PULLDOWN);
  pinMode(PIN_HOME, cfg.npn ? INPUT_PULLUP : INPUT_PULLDOWN);
  g_level[0] = activeLevel(PIN_SHELF);
  g_level[1] = activeLevel(PIN_HOME);
  attachInterruptArg(PIN_SHELF, sensorIsr, (void*)0, CHANGE);
  attachInterruptArg(PIN_HOME, sensorIsr, (void*)1, CHANGE);

  esp_timer_create_args_t targs = {};
  targs.callback = &jogTick;
  targs.name = "pax-jog";
  targs.dispatch_method = ESP_TIMER_TASK;
  esp_timer_create(&targs, &g_jogTimer);

  Serial.begin(PAX_LINK_BAUD);
  LinkUart.begin(PAX_LINK_BAUD, SERIAL_8N1, PIN_LINK_RX, PIN_LINK_TX);
  delay(50);
  out("BOOT");
  // Wi-Fi comes up after BOOT so a USB-connected Pi is never kept waiting;
  // without stored credentials this only prints a hint and stays idle.
  paxnet::begin(PAX_FW_VERSION, out);
  g_posLastUs = micros();
}

void loop() {
  // 1. Hardware stop requested by an ARMed sensor edge: do it before anything else.
  if (g_tripFlag) {
    trainOff();
    int8_t s = g_tripSensor;
    uint32_t us = g_tripUs;
    g_tripFlag = false;
    outf("TRIP %c %lu %.1f", s == 0 ? 'S' : 'H', (unsigned long)us, g_pos);
  }

  // 2. Input from any port: USB, GPIO UART, or the Wi-Fi client.
  pump(Serial, g_lineUsb, g_lenUsb);
  pump(LinkUart, g_lineUart, g_lenUart);
  paxnet::loop();
  if (Stream* tcp = paxnet::client()) pump(*tcp, g_lineTcp, g_lenTcp);
  else g_lenTcp = 0;
  if (paxnet::updating() && (g_running || g_jogActive)) {
    // Flashing firmware with the chains moving is the one thing we never do.
    jogAbort();
    trainOff();
    g_armSensor = -1;
    out("EV OTA in progress, motors stopped");
  }

  // 3. Jog completion.
  if (g_jogActive && g_jogDoneFlag) jogFinish();

  // 4. Sensors and alarms.
  sensorsSettle();
  drainEdges();
  pollAlarms();

  // 5. Watchdog: a Pi that stopped talking must not leave the motors running.
  uint32_t now = millis();
  if (g_linkUp && now - g_lastRxMs > cfg.watchdogMs) {
    if (g_running || g_jogActive) {
      jogAbort();
      trainOff();
      g_armSensor = -1;
      out("EV WATCHDOG link lost, motors stopped");
    }
    if (!g_wdTripped) { g_wdTripped = true; g_linkUp = false; }
  }
  if (!g_linkUp) digitalWrite(PIN_LED, (now / 250) % 2);

  // 6. Periodic status.
  if (now - g_lastStatusMs >= 1000 / cfg.statusHz) {
    g_lastStatusMs = now;
    sendStatus();
  }
}
