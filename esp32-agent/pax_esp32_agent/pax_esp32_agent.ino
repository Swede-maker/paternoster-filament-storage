// PAX ESP32 slave agent
//
// Drives ONE paternoster carousel and speaks the same WebSocket protocol as
// pi-agent/paternoster_agent.py on port 8765, so the app (running on the
// master Raspberry Pi) controls it exactly like a slave Pi.
//
// Libraries (Arduino Library Manager / PlatformIO):
//   - "WebSockets" by Markus Sattler (links2004/WebSockets) >= 2.4
//   - "ArduinoJson" by Benoit Blanchon >= 7.0
// Board: "ESP32 Dev Module" (Arduino-ESP32 core 2.x or 3.x).

#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebServer.h>
#include <Preferences.h>
#include <WebSocketsServer.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <functional>
#include <math.h>
#include "config.h"

#define FIRMWARE "pax-esp32-1.0"

// The Arduino builder hoists auto-generated prototypes above every type
// definition, so the types they mention must be declared here first.
struct Input;
using Reply = std::function<void(JsonDocument&)>;
template <typename T>
bool takeNumber(JsonDocument& msg, const char* key, T& out, double lo, double hi);

// ---------------------------------------------------------------------------
// LEDC compatibility (Arduino-ESP32 core 2.x uses channels, 3.x uses pins)
// ---------------------------------------------------------------------------
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  #define PWM_ATTACH(pin, ch, freq, res) ledcAttach((pin), (freq), (res))
  #define PWM_WRITE(pin, ch, duty)       ledcWrite((pin), (duty))
  #define PWM_TONE(pin, ch, freq)        ledcWriteTone((pin), (freq))
#else
  #define PWM_ATTACH(pin, ch, freq, res) do { ledcSetup((ch), (freq), (res)); ledcAttachPin((pin), (ch)); } while (0)
  #define PWM_WRITE(pin, ch, duty)       ledcWrite((ch), (duty))
  #define PWM_TONE(pin, ch, freq)        ledcWriteTone((ch), (freq))
#endif

enum : uint8_t { CH_A1 = 0, CH_A2 = 1, CH_B1 = 2, CH_B2 = 3, CH_PUL_A = 4, CH_PUL_B = 6 };
enum : uint8_t { MOTOR_A = 1, MOTOR_B = 2, MOTOR_BOTH = 3 };

// ---------------------------------------------------------------------------
// Persistent settings
// ---------------------------------------------------------------------------
struct Settings {
  String name, ssid, psk, apSsid, apPsk, masterHost;
  int shelves;
  String motorMode;      // "dc" | "servo"
  String positionMode;   // "sensor" | "index" | "pulses" (treated as index)
  float moveSpeed, homingSpeed, approachSpeed;
  int rampPct;
  float sensorArmS;
  bool reverseDir, mirrorB, ignoreAlarm;
  uint32_t maxPps, pulsesPerRev;
  long carouselPulses;   // calibrated pulses per carousel turn (servo), 0 = none
} S;

Preferences prefs;

void loadSettings() {
  prefs.begin("pax", true);
  S.name = prefs.getString("name", DEFAULT_AGENT_NAME);
  S.ssid = prefs.getString("ssid", DEFAULT_WIFI_SSID);
  S.psk = prefs.getString("psk", DEFAULT_WIFI_PSK);
  S.apSsid = prefs.getString("apSsid", "");
  S.apPsk = prefs.getString("apPsk", "");
  S.masterHost = prefs.getString("master", DEFAULT_MASTER_HOST);
  S.shelves = prefs.getInt("shelves", DEFAULT_SHELVES);
  S.motorMode = prefs.getString("motor", DEFAULT_MOTOR_MODE);
  S.positionMode = prefs.getString("posMode", DEFAULT_POSITION_MODE);
  S.moveSpeed = prefs.getFloat("moveSpd", 0.6f);
  S.homingSpeed = prefs.getFloat("homeSpd", 0.35f);
  S.approachSpeed = prefs.getFloat("apprSpd", 0.3f);
  S.rampPct = prefs.getInt("ramp", 40);
  S.sensorArmS = prefs.getFloat("armS", DEFAULT_SENSOR_ARM_S);
  S.reverseDir = prefs.getBool("reverse", false);
  S.mirrorB = prefs.getBool("mirrorB", true);
  S.ignoreAlarm = prefs.getBool("ignAlarm", !SERVO_ALARM_WIRED);
  S.maxPps = prefs.getUInt("maxPps", 9000);
  S.pulsesPerRev = prefs.getUInt("ppr", 1600);
  S.carouselPulses = prefs.getLong("calPulses", 0);
  prefs.end();
  if (S.shelves < 1) S.shelves = DEFAULT_SHELVES;
}

void saveSettings() {
  prefs.begin("pax", false);
  prefs.putString("name", S.name);
  prefs.putString("ssid", S.ssid);
  prefs.putString("psk", S.psk);
  prefs.putString("apSsid", S.apSsid);
  prefs.putString("apPsk", S.apPsk);
  prefs.putString("master", S.masterHost);
  prefs.putInt("shelves", S.shelves);
  prefs.putString("motor", S.motorMode);
  prefs.putString("posMode", S.positionMode);
  prefs.putFloat("moveSpd", S.moveSpeed);
  prefs.putFloat("homeSpd", S.homingSpeed);
  prefs.putFloat("apprSpd", S.approachSpeed);
  prefs.putInt("ramp", S.rampPct);
  prefs.putFloat("armS", S.sensorArmS);
  prefs.putBool("reverse", S.reverseDir);
  prefs.putBool("mirrorB", S.mirrorB);
  prefs.putBool("ignAlarm", S.ignoreAlarm);
  prefs.putUInt("maxPps", S.maxPps);
  prefs.putUInt("ppr", S.pulsesPerRev);
  prefs.putLong("calPulses", S.carouselPulses);
  prefs.end();
}

bool isServo() { return S.motorMode == "servo"; }
bool isIndexMode() { return S.positionMode == "index" || S.positionMode == "pulses"; }

// ---------------------------------------------------------------------------
// Networking objects
// ---------------------------------------------------------------------------
WebSocketsServer ws(AGENT_PORT);
WebSocketsClient master;
WebServer portal(80);
String hostname;
bool portalOn = false, masterStarted = false, onMasterAp = false;
uint32_t offlineSince = 0, lastProfileSwitch = 0, reconnectAt = 0, restartAt = 0;

void broadcast(JsonDocument& d) {
  String out;
  serializeJson(d, out);
  ws.broadcastTXT(out);
}

void sendTo(uint8_t client, JsonDocument& d) {
  String out;
  serializeJson(d, out);
  ws.sendTXT(client, out);
}

void emitFault(const String& message) {
  JsonDocument d;
  d["type"] = "fault";
  d["message"] = message;
  broadcast(d);
  Serial.println("[agent] fault: " + message);
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
struct Input {
  uint8_t pin;
  bool activeLow;
  bool stable, raw;
  uint32_t changedAt;
  Input(uint8_t p, bool low) : pin(p), activeLow(low), stable(false), raw(false), changedAt(0) {}
};

Input shelfIn(PIN_SHELF_SENSOR, SENSOR_ACTIVE_LOW);
Input homeIn(PIN_HOME_SENSOR, SENSOR_ACTIVE_LOW);
Input alarmAIn(PIN_ALARM_A, ALARM_ACTIVE_LOW);
Input alarmBIn(PIN_ALARM_B, ALARM_ACTIVE_LOW);

bool readActive(const Input& in) {
  bool level = digitalRead(in.pin);
  return in.activeLow ? !level : level;
}

// Returns +1 when the input became active, -1 when it went inactive, else 0.
int updateInput(Input& in, uint32_t now) {
  bool r = readActive(in);
  if (r != in.raw) {
    in.raw = r;
    in.changedAt = now;
  }
  if (in.raw != in.stable && now - in.changedAt >= SENSOR_DEBOUNCE_MS) {
    in.stable = in.raw;
    return in.stable ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Motor drive
// ---------------------------------------------------------------------------
float appliedSpeed = -1;
int appliedDir = 0;
double currentPps = 0;
bool held = true;

void setupMotorPins() {
  pinMode(PIN_AEN, OUTPUT);
  pinMode(PIN_BEN, OUTPUT);
  if (isServo()) {
    pinMode(PIN_A2, OUTPUT);
    pinMode(PIN_B2, OUTPUT);
    PWM_ATTACH(PIN_A1, CH_PUL_A, 1000, 10);
    PWM_ATTACH(PIN_B1, CH_PUL_B, 1000, 10);
    PWM_TONE(PIN_A1, CH_PUL_A, 0);
    PWM_TONE(PIN_B1, CH_PUL_B, 0);
    bool en = SERVO_ENA_ACTIVE_HIGH;
    digitalWrite(PIN_AEN, en);
    digitalWrite(PIN_BEN, en);
  } else {
    PWM_ATTACH(PIN_A1, CH_A1, 20000, 8);
    PWM_ATTACH(PIN_A2, CH_A2, 20000, 8);
    PWM_ATTACH(PIN_B1, CH_B1, 20000, 8);
    PWM_ATTACH(PIN_B2, CH_B2, 20000, 8);
    PWM_WRITE(PIN_A1, CH_A1, 0);
    PWM_WRITE(PIN_A2, CH_A2, 0);
    PWM_WRITE(PIN_B1, CH_B1, 0);
    PWM_WRITE(PIN_B2, CH_B2, 0);
    digitalWrite(PIN_AEN, LOW);
    digitalWrite(PIN_BEN, LOW);
  }
}

void setServoEnabled(bool on) {
  bool level = SERVO_ENA_ACTIVE_HIGH ? on : !on;
  digitalWrite(PIN_AEN, level);
  digitalWrite(PIN_BEN, level);
  held = on;
}

// dir: +1 = "down" (shelf index increases), -1 = "up".
bool forwardFor(int dir, bool motorB) {
  bool fwd = dir > 0;
  if (S.reverseDir) fwd = !fwd;
  if (motorB && S.mirrorB) fwd = !fwd;
  return fwd;
}

void stopDrive() {
  if (isServo()) {
    PWM_TONE(PIN_A1, CH_PUL_A, 0);
    PWM_TONE(PIN_B1, CH_PUL_B, 0);
  } else {
    PWM_WRITE(PIN_A1, CH_A1, 0);
    PWM_WRITE(PIN_A2, CH_A2, 0);
    PWM_WRITE(PIN_B1, CH_B1, 0);
    PWM_WRITE(PIN_B2, CH_B2, 0);
    digitalWrite(PIN_AEN, LOW);
    digitalWrite(PIN_BEN, LOW);
  }
  currentPps = 0;
  appliedSpeed = -1;
  appliedDir = 0;
}

void applyDrive(int dir, float speed, uint8_t mask) {
  speed = constrain(speed, 0.0f, 1.0f);
  if (isServo()) {
    if (!held) setServoEnabled(true);
    double pps = max(50.0, (double)speed * min<uint32_t>(S.maxPps, ESP32_MAX_PPS));
    digitalWrite(PIN_A2, forwardFor(dir, false));
    digitalWrite(PIN_B2, forwardFor(dir, true));
    PWM_TONE(PIN_A1, CH_PUL_A, (mask & MOTOR_A) ? (uint32_t)pps : 0);
    PWM_TONE(PIN_B1, CH_PUL_B, (mask & MOTOR_B) ? (uint32_t)pps : 0);
    currentPps = pps;
  } else {
    uint32_t duty = (uint32_t)(speed * 255.0f);
    bool fa = forwardFor(dir, false), fb = forwardFor(dir, true);
    bool ea = mask & MOTOR_A, eb = mask & MOTOR_B;
    digitalWrite(PIN_AEN, ea);
    digitalWrite(PIN_BEN, eb);
    PWM_WRITE(PIN_A1, CH_A1, ea && fa ? duty : 0);
    PWM_WRITE(PIN_A2, CH_A2, ea && !fa ? duty : 0);
    PWM_WRITE(PIN_B1, CH_B1, eb && fb ? duty : 0);
    PWM_WRITE(PIN_B2, CH_B2, eb && !fb ? duty : 0);
  }
  appliedSpeed = speed;
  appliedDir = dir;
}

// ---------------------------------------------------------------------------
// Carousel state machine
// ---------------------------------------------------------------------------
enum class Mode { Idle, Homing, Moving, Calibrating, Jogging };
Mode mode = Mode::Idle;

int currentShelf = 0, targetShelf = -1, pendingGoto = -1, remainingFlags = 0;
bool homed = false, calibrateAfterHome = false;
int dirNow = 0;
uint8_t maskNow = MOTOR_BOTH;
float targetSpeed = 0;
uint32_t motionStart = 0, lastEdgeAt = 0, jogUntil = 0, lastDriveUpdate = 0;
double posPulses = 0, travelled = 0, travelGoal = 0, calPulses = 0;
int calFlags = 0;

float rampedSpeed(uint32_t now);
void afterHomed();
String fqdn() { return hostname + ".local"; }

const char* statusName() {
  switch (mode) {
    case Mode::Homing: return "homing";
    case Mode::Moving:
    case Mode::Jogging: return "moving";
    case Mode::Calibrating: return "calibrating";
    default: return "idle";
  }
}

int wrapShelf(int s) { return ((s % S.shelves) + S.shelves) % S.shelves; }

double wrapPulses(double p) {
  if (S.carouselPulses <= 0) return p;
  double c = (double)S.carouselPulses;
  p = fmod(p, c);
  return p < 0 ? p + c : p;
}

void fillState(JsonDocument& d) {
  d["type"] = "state";
  d["status"] = statusName();
  d["shelf"] = currentShelf;
  d["homed"] = homed;
  d["positionMode"] = S.positionMode;
  d["calibrated"] = S.carouselPulses > 0;
}

void fillServo(JsonDocument& d) {
  d["type"] = "servo";
  d["mode"] = isServo() ? "servo" : "dc";
  d["mirrorB"] = S.mirrorB;
  if (isServo()) {
    d["alarmA"] = alarmAIn.stable && !S.ignoreAlarm;
    d["alarmB"] = alarmBIn.stable && !S.ignoreAlarm;
    d["pulsesPerRev"] = S.pulsesPerRev;
    d["maxPps"] = S.maxPps;
    d["held"] = held;
  } else {
    d["jogMaxMs"] = DC_JOG_MAX_MS;
  }
}

void fillHello(JsonDocument& d) {
  d["type"] = "hello";
  d["name"] = S.name;
  d["shelves"] = S.shelves;
  d["firmware"] = FIRMWARE;
  d["role"] = "slave";
  d["simulated"] = false;
  d["simReason"] = nullptr;
  d["motorMode"] = S.motorMode;
  d["twin"] = false;
  d["sides"].to<JsonArray>();
  d["board"] = "esp32";
}

void broadcastState() { JsonDocument d; fillState(d); broadcast(d); }
void broadcastServo() { JsonDocument d; fillServo(d); broadcast(d); }

void emitShelfEvent(const char* type) {
  JsonDocument d;
  d["type"] = type;
  d["shelf"] = currentShelf;
  broadcast(d);
}

void emitCalibration(bool ok, const String& message, bool restored = false) {
  JsonDocument d;
  d["type"] = "calibration";
  d["ok"] = ok;
  if (isServo() && S.carouselPulses > 0) d["pulsesPerRev"] = S.carouselPulses;
  else d["pulsesPerRev"] = nullptr;
  d["indexWindowPulses"] = nullptr;
  if (!restored) d["shelfFlagsSeen"] = calFlags;
  d["shelves"] = S.shelves;
  d["message"] = message;
  if (restored) d["restored"] = true;
  broadcast(d);
}

void halt(const String& fault) {
  stopDrive();
  mode = Mode::Idle;
  pendingGoto = -1;
  calibrateAfterHome = false;
  if (fault.length()) emitFault(fault);
  broadcastState();
}

void startMotion(Mode m, int dir, float speed, uint8_t mask = MOTOR_BOTH) {
  mode = m;
  dirNow = dir;
  maskNow = mask;
  targetSpeed = speed;
  motionStart = lastEdgeAt = millis();
  travelled = 0;
  applyDrive(dir, rampedSpeed(motionStart), mask);
  broadcastState();
}

float rampedSpeed(uint32_t now) {
  float rampMs = S.rampPct / 100.0f * RAMP_MAX_MS;
  if (rampMs < 1) return targetSpeed;
  float k = min(1.0f, (now - motionStart) / rampMs);
  return targetSpeed * (0.25f + 0.75f * k);
}

bool busy() { return mode != Mode::Idle; }

void startHome() {
  if (busy()) { emitFault("Carousel is busy. Stop it first."); return; }
  if (homeIn.stable) {  // already sitting on the index flag
    homed = true;
    currentShelf = 0;
    posPulses = 0;
    emitShelfEvent("homed");
    afterHomed();
    return;
  }
  startMotion(Mode::Homing, +1, S.homingSpeed);
}

void startCalibrateRun() {
  calFlags = 0;
  calPulses = 0;
  startMotion(Mode::Calibrating, +1, S.homingSpeed);
}

void startCalibrate() {
  if (busy()) { emitFault("Carousel is busy. Stop it first."); return; }
  if (!homeIn.stable) {
    calibrateAfterHome = true;
    startHome();
    return;
  }
  homed = true;
  currentShelf = 0;
  posPulses = 0;
  startCalibrateRun();
}

void beginGoto(int target) {
  if (target < 0 || target >= S.shelves) { emitFault("Shelf " + String(target + 1) + " does not exist."); return; }
  if (busy()) { emitFault("Carousel is busy. Stop it first."); return; }
  if (isIndexMode() && !isServo()) {
    emitFault("Home only positioning needs servo drives: DC motors have no pulse count. Switch positioning to Shelf sensor.");
    return;
  }
  if (!homed) {
    pendingGoto = target;
    startHome();
    return;
  }
  targetShelf = target;
  if (target == currentShelf) { emitShelfEvent("arrived"); broadcastState(); return; }

  int n = S.shelves;
  if (isIndexMode()) {
    if (S.carouselPulses <= 0) { emitFault("Calibrate the carousel first (Settings -> Hardware -> Calibrate)."); return; }
    double c = (double)S.carouselPulses;
    double targetPos = c * target / n;
    double fwd = wrapPulses(targetPos - posPulses);
    double back = c - fwd;
    int dir = fwd <= back ? +1 : -1;
    startMotion(Mode::Moving, dir, S.moveSpeed);
    travelGoal = dir > 0 ? fwd : back;
  } else {
    int fwd = wrapShelf(target - currentShelf);
    int back = n - fwd;
    int dir = fwd <= back ? +1 : -1;
    remainingFlags = dir > 0 ? fwd : back;
    startMotion(Mode::Moving, dir, remainingFlags == 1 ? S.approachSpeed : S.moveSpeed);
  }
}

void afterHomed() {
  if (calibrateAfterHome) {
    calibrateAfterHome = false;
    startCalibrateRun();
  } else if (pendingGoto >= 0) {
    int t = pendingGoto;
    pendingGoto = -1;
    beginGoto(t);
  }
}

void arrive() {
  stopDrive();
  mode = Mode::Idle;
  if (targetShelf >= 0) currentShelf = targetShelf;
  if (isIndexMode() && S.carouselPulses > 0) posPulses = (double)S.carouselPulses * currentShelf / S.shelves;
  emitShelfEvent("arrived");
  broadcastState();
}

int shelfFromPulses() {
  double pitch = (double)S.carouselPulses / S.shelves;
  return wrapShelf((int)floor(wrapPulses(posPulses) / pitch + 0.5));
}

void startJog(const String& motor, const String& direction, long amount, float speed) {
  if (busy()) { emitFault("Jog ignored: the carousel is moving."); return; }
  uint8_t mask = motor == "a" ? MOTOR_A : motor == "b" ? MOTOR_B : MOTOR_BOTH;
  int dir = direction == "up" ? -1 : +1;
  speed = constrain(speed, 0.05f, 1.0f);
  uint32_t ms;
  if (isServo()) {
    double pps = max(50.0, (double)speed * min<uint32_t>(S.maxPps, ESP32_MAX_PPS));
    ms = (uint32_t)(amount / pps * 1000.0);
  } else {
    ms = min<long>(amount, DC_JOG_MAX_MS);
  }
  targetSpeed = speed;
  startMotion(Mode::Jogging, dir, speed, mask);
  jogUntil = motionStart + max<uint32_t>(ms, 1);
  JsonDocument d;
  d["type"] = "servo";
  d["mode"] = S.motorMode;
  d["jogging"] = true;
  d["motor"] = motor;
  d["direction"] = direction;
  broadcast(d);
}

void tickMotion() {
  static uint32_t lastUs = micros();
  uint32_t nowUs = micros();
  double dt = (nowUs - lastUs) / 1e6;
  lastUs = nowUs;
  uint32_t now = millis();

  int shelfEdge = updateInput(shelfIn, now);
  int homeEdge = updateInput(homeIn, now);
  if (shelfEdge != 0 && !isIndexMode()) {
    JsonDocument d;
    d["type"] = "sensor";
    d["on"] = shelfIn.stable;
    broadcast(d);
  }

  if (isServo() && SERVO_ALARM_WIRED) {
    int a = updateInput(alarmAIn, now), b = updateInput(alarmBIn, now);
    if (a != 0 || b != 0) broadcastServo();
    if (!S.ignoreAlarm && (alarmAIn.stable || alarmBIn.stable) && busy()) {
      halt(String("Servo drive alarm on motor ") + (alarmAIn.stable ? "A" : "B") + ". Check the drive LED, then power-cycle it.");
      return;
    }
  }
#if ESTOP_FITTED
  if (digitalRead(PIN_ESTOP) == LOW && busy()) { halt("Emergency stop button pressed."); return; }
#endif

  if (mode == Mode::Idle) return;

  if (isServo() && currentPps > 0) {
    double p = currentPps * dt;
    posPulses += p * dirNow;
    travelled += p;
    calPulses += p;
  }

  bool armed = now - motionStart >= (uint32_t)(S.sensorArmS * 1000.0f);
  bool shelfHit = armed && shelfEdge > 0 && !isIndexMode();
  bool homeHit = armed && homeEdge > 0;

  if (now - lastDriveUpdate >= 20) {
    lastDriveUpdate = now;
    float sp = rampedSpeed(now);
    if (fabsf(sp - appliedSpeed) > 0.01f || appliedDir != dirNow) applyDrive(dirNow, sp, maskNow);
  }

  switch (mode) {
    case Mode::Homing:
      if (homeHit) {
        stopDrive();
        mode = Mode::Idle;
        homed = true;
        currentShelf = 0;
        posPulses = 0;
        emitShelfEvent("homed");
        broadcastState();
        afterHomed();
      } else if (now - motionStart > HOME_TIMEOUT_S * 1000) {
        halt("Homing timed out: index sensor not found");
      }
      break;

    case Mode::Calibrating:
      if (shelfHit) calFlags++;
      if (homeHit) {
        stopDrive();
        mode = Mode::Idle;
        posPulses = 0;
        currentShelf = 0;
        String msg;
        if (isServo()) {
          S.carouselPulses = lround(calPulses);
          saveSettings();
          msg = "Calibrated: " + String(S.carouselPulses) + " pulses per revolution";
        } else {
          msg = "Calibrated";
        }
        if (!isIndexMode()) msg += ", " + String(calFlags) + " shelf flags seen (" + String(S.shelves) + " expected)";
        emitCalibration(true, msg + ".");
        emitShelfEvent("homed");
        broadcastState();
      } else if (now - motionStart > HOME_TIMEOUT_S * 2000) {
        halt("Calibration timed out: the index sensor did not come round again.");
        emitCalibration(false, "Calibration timed out.");
      }
      break;

    case Mode::Moving:
      if (isIndexMode()) {
        if (homeHit && dirNow > 0) {  // re-sync on every pass of the home flag
          posPulses = 0;
          double c = (double)S.carouselPulses;
          travelGoal = travelled + wrapPulses(c * targetShelf / S.shelves);
        }
        int s = shelfFromPulses();
        if (s != currentShelf) { currentShelf = s; emitShelfEvent("pos"); }
        double remaining = travelGoal - travelled;
        double pitch = (double)S.carouselPulses / S.shelves;
        if (remaining < pitch * 0.5) targetSpeed = S.approachSpeed;
        if (remaining <= 0) arrive();
        else if (now - motionStart > MOVE_TIMEOUT_S * 1000) halt("Move timed out.");
      } else {
        if (shelfHit) {
          currentShelf = wrapShelf(currentShelf + dirNow);
          lastEdgeAt = now;
          remainingFlags--;
          emitShelfEvent("pos");
          if (remainingFlags <= 0) { arrive(); break; }
          if (remainingFlags == 1) targetSpeed = S.approachSpeed;
        }
        if (now - lastEdgeAt > SHELF_TIMEOUT_S * 1000) {
          homed = false;
          halt("No shelf flag seen for " + String((int)SHELF_TIMEOUT_S) + " s. Check the shelf sensor, then home the carousel.");
        }
      }
      break;

    case Mode::Jogging:
      if (isIndexMode() && isServo() && S.carouselPulses > 0) {
        int s = shelfFromPulses();
        if (s != currentShelf) { currentShelf = s; emitShelfEvent("pos"); }
      }
      if ((int32_t)(now - jogUntil) >= 0) {
        stopDrive();
        mode = Mode::Idle;
        broadcastState();
      }
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Network commands (shared by the app socket and the master link)
// ---------------------------------------------------------------------------
void fillNetStatus(JsonDocument& d) {
  bool up = WiFi.status() == WL_CONNECTED;
  d["type"] = "net.status";
  d["mode"] = !up ? "offline" : onMasterAp ? "ap" : "router";
  d["ssid"] = up ? WiFi.SSID() : "";
  d["ip"] = up ? WiFi.localIP().toString() : "";
  d["signal"] = up ? constrain(2 * (WiFi.RSSI() + 100), 0, 100) : 0;
  d["hostname"] = fqdn();
  d["role"] = "slave";
}

void scheduleWifiReconnect() { reconnectAt = millis() + 1500; }

void handleNet(JsonDocument& msg, const Reply& reply) {
  String t = msg["type"] | "";
  if (t == "net.join") {
    String ssid = msg["ssid"] | "";
    if (!ssid.length()) return;
    S.ssid = ssid;
    S.psk = msg["psk"] | "";
    if (msg["apSsid"].is<const char*>()) S.apSsid = msg["apSsid"].as<String>();
    if (msg["apPsk"].is<const char*>()) S.apPsk = msg["apPsk"].as<String>();
    saveSettings();
    JsonDocument ack;
    ack["type"] = "net.ack";
    ack["op"] = "join";
    ack["ok"] = true;
    ack["hostname"] = fqdn();
    reply(ack);
    scheduleWifiReconnect();
  } else if (t == "net.set-ap-psk") {
    if (msg["apSsid"].is<const char*>()) S.apSsid = msg["apSsid"].as<String>();
    if (msg["psk"].is<const char*>()) S.apPsk = msg["psk"].as<String>();
    saveSettings();
    JsonDocument ack;
    ack["type"] = "net.ack";
    ack["op"] = "set-ap-psk";
    ack["ok"] = true;
    ack["hostname"] = fqdn();
    reply(ack);
  } else if (t == "net.registered") {
    String a = msg["apSsid"] | "", p = msg["apPsk"] | "";
    if (a.length() && p.length() && (a != S.apSsid || p != S.apPsk)) {
      S.apSsid = a;
      S.apPsk = p;
      saveSettings();
    }
  } else if (t == "net.status") {
    JsonDocument d;
    fillNetStatus(d);
    reply(d);
  }
}

// ---------------------------------------------------------------------------
// App commands
// ---------------------------------------------------------------------------
void sendGreeting(uint8_t client) {
  JsonDocument h; fillHello(h); sendTo(client, h);
  JsonDocument st; fillState(st); sendTo(client, st);
  if (!isIndexMode()) {
    JsonDocument se; se["type"] = "sensor"; se["on"] = shelfIn.stable; sendTo(client, se);
  }
  JsonDocument sv; fillServo(sv); sendTo(client, sv);
  if (S.carouselPulses > 0 && isServo()) {
    JsonDocument c;
    c["type"] = "calibration";
    c["ok"] = true;
    c["pulsesPerRev"] = S.carouselPulses;
    c["indexWindowPulses"] = nullptr;
    c["shelves"] = S.shelves;
    c["message"] = String("Calibration restored: ") + String(S.carouselPulses) + " pulses per revolution.";
    c["restored"] = true;
    sendTo(client, c);
  }
}

template <typename T>
bool takeNumber(JsonDocument& msg, const char* key, T& out, double lo, double hi) {
  if (!msg[key].is<double>() || msg[key].is<bool>()) return false;
  double v = constrain(msg[key].as<double>(), lo, hi);
  if ((T)v == out) return false;
  out = (T)v;
  return true;
}

void handleConfig(JsonDocument& msg) {
  bool changed = false, stateChanged = false;
  if (msg["twin"].is<bool>() && msg["twin"].as<bool>()) {
    emitFault("The ESP32 agent drives one carousel. Use one ESP32 per carousel instead of twin mode.");
  }
  int shelves = S.shelves;
  if (takeNumber(msg, "shelves", shelves, 1, 200)) {
    S.shelves = shelves;
    currentShelf = wrapShelf(currentShelf);
    changed = stateChanged = true;
  }
  changed |= takeNumber(msg, "moveSpeed", S.moveSpeed, 0.05, 1.0);
  changed |= takeNumber(msg, "homingSpeed", S.homingSpeed, 0.05, 1.0);
  changed |= takeNumber(msg, "approachSpeed", S.approachSpeed, 0.05, 1.0);
  changed |= takeNumber(msg, "rampPct", S.rampPct, 0, 100);
  changed |= takeNumber(msg, "sensorArmS", S.sensorArmS, 0.0, SENSOR_ARM_MAX_S);
  changed |= takeNumber(msg, "servoPulsesPerRev", S.pulsesPerRev, 100, 100000);
  if (msg["servoMaxPps"].is<double>()) {
    double want = msg["servoMaxPps"].as<double>();
    if (want > ESP32_MAX_PPS) emitFault("The ESP32 caps the pulse rate at " + String(ESP32_MAX_PPS) + " pulses/s; using that instead.");
    changed |= takeNumber(msg, "servoMaxPps", S.maxPps, 100, ESP32_MAX_PPS);
  }
  if (msg["servoMirrorB"].is<bool>() && msg["servoMirrorB"].as<bool>() != S.mirrorB) {
    S.mirrorB = msg["servoMirrorB"].as<bool>();
    changed = true;
  }
  if (msg["reverseDir"].is<bool>() && msg["reverseDir"].as<bool>() != S.reverseDir) {
    S.reverseDir = msg["reverseDir"].as<bool>();
    changed = true;
  }
  if (msg["servoIgnoreAlarm"].is<bool>() && msg["servoIgnoreAlarm"].as<bool>() != S.ignoreAlarm) {
    S.ignoreAlarm = msg["servoIgnoreAlarm"].as<bool>();
    changed = true;
    broadcastServo();
  }
  String pm = msg["positionMode"] | "";
  if ((pm == "sensor" || pm == "index" || pm == "pulses") && pm != S.positionMode && !busy()) {
    S.positionMode = pm;
    changed = stateChanged = true;
  }
  if (msg["servoCarouselPulses"].is<double>() && S.carouselPulses <= 0) {
    long p = lround(msg["servoCarouselPulses"].as<double>());
    if (p > 0) {
      S.carouselPulses = p;
      changed = stateChanged = true;
      emitCalibration(true, "Calibration restored: " + String(p) + " pulses per revolution.", true);
    }
  }
  String mm = msg["motorMode"] | "";
  bool restart = false;
  if ((mm == "dc" || mm == "servo") && mm != S.motorMode) {
    if (busy()) {
      emitFault("Motor drive change to '" + mm + "' ignored while the carousel is moving. Stop it first.");
    } else {
      S.motorMode = mm;
      changed = restart = true;
    }
  }
  if (changed) saveSettings();
  if (restart) {
    JsonDocument h; fillHello(h); broadcast(h);
    Serial.println("[agent] motor drive changed to " + S.motorMode + ", restarting");
    restartAt = millis() + 500;  // the pins are re-attached on boot
  } else if (stateChanged) {
    broadcastState();
  }
}

void handleAppMessage(uint8_t client, uint8_t* payload, size_t length) {
  JsonDocument msg;
  if (deserializeJson(msg, payload, length)) return;
  String t = msg["type"] | "";
  if (t.startsWith("net.")) {
    handleNet(msg, [client](JsonDocument& d) { sendTo(client, d); });
    return;
  }
  if (t == "stop") halt("");
  else if (t == "home") startHome();
  else if (t == "goto") beginGoto(msg["shelf"] | 0);
  else if (t == "calibrate") startCalibrate();
  else if (t == "config") handleConfig(msg);
  else if (t == "hello") { JsonDocument h; fillHello(h); sendTo(client, h); }
  else if (t == "release") {
    if (!isServo()) emitFault("Release is a servo-drive feature; the DC bridges are already de-energised whenever the carousel is idle.");
    else if (busy()) emitFault("Servos not released: the carousel is moving. Stop it first.");
    else { setServoEnabled(false); broadcastServo(); }
  } else if (t == "hold") {
    if (isServo()) { setServoEnabled(true); broadcastServo(); }
  } else if (t == "jog") {
    const char* unit = isServo() ? "pulses" : "ms";
    double amount = msg[unit] | 0.0;
    if (amount <= 0) {
      emitFault(String("Jog ignored: the ") + S.motorMode + " drive expects a '" + unit + "' amount.");
    } else {
      startJog(msg["motor"] | "both", msg["direction"] | "down", (long)amount, msg["speed"] | 0.45f);
    }
  }
}

void onAppEvent(uint8_t client, WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) sendGreeting(client);
  else if (type == WStype_TEXT) handleAppMessage(client, payload, length);
}

// ---------------------------------------------------------------------------
// Master link (outbound, like a slave Pi)
// ---------------------------------------------------------------------------
void onMasterEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) {
    JsonDocument d;
    d["type"] = "net.register";
    d["hostname"] = fqdn();
    d["mac"] = WiFi.macAddress();
    d["mode"] = onMasterAp ? "ap" : "router";
    d["ssid"] = WiFi.SSID();
    d["ip"] = WiFi.localIP().toString();
    d["board"] = "esp32";
    String out;
    serializeJson(d, out);
    master.sendTXT(out);
    Serial.println("[agent] registered with master " + S.masterHost);
  } else if (type == WStype_TEXT) {
    JsonDocument msg;
    if (deserializeJson(msg, payload, length)) return;
    handleNet(msg, [](JsonDocument& d) { String out; serializeJson(d, out); master.sendTXT(out); });
  }
}

void startMasterLink() {
  if (masterStarted || !S.masterHost.length()) return;
  String host = S.masterHost;
  IPAddress ip;
  if (host.endsWith(".local")) {
    ip = MDNS.queryHost(host.substring(0, host.length() - 6), 2000);
    if (ip == IPAddress(0, 0, 0, 0)) return;  // retried from loop()
  } else if (!ip.fromString(host)) {
    if (!WiFi.hostByName(host.c_str(), ip)) return;
  }
  master.begin(ip, AGENT_PORT, "/");
  master.onEvent(onMasterEvent);
  master.setReconnectInterval(5000);
  master.enableHeartbeat(20000, 5000, 2);
  masterStarted = true;
  Serial.println("[agent] master link -> " + ip.toString());
}

// ---------------------------------------------------------------------------
// Wi-Fi + setup hotspot
// ---------------------------------------------------------------------------
String htmlEscape(const String& s) {
  String o;
  for (char c : s) {
    if (c == '<') o += "&lt;"; else if (c == '>') o += "&gt;"; else if (c == '"') o += "&quot;"; else if (c == '&') o += "&amp;"; else o += c;
  }
  return o;
}

void portalRoot() {
  String page =
    "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>PAX ESP32 setup</title><style>body{font-family:sans-serif;background:#0d1117;color:#e6edf3;padding:16px;max-width:420px;margin:auto}"
    "label{display:block;margin-top:12px;font-size:14px}input{width:100%;font-size:16px;padding:10px;margin-top:4px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#e6edf3;box-sizing:border-box}"
    "button{margin-top:20px;width:100%;padding:12px;font-size:16px;border:0;border-radius:8px;background:#1f9cf0;color:#fff}</style>"
    "<h2>PAX ESP32 setup</h2><p>" + htmlEscape(hostname) + ".local</p><form method=post action=/save>"
    "<label>Wi-Fi name (SSID)<input name=ssid value=\"" + htmlEscape(S.ssid) + "\" required></label>"
    "<label>Wi-Fi password<input name=psk type=password value=\"" + htmlEscape(S.psk) + "\"></label>"
    "<label>Master Pi hostname<input name=master value=\"" + htmlEscape(S.masterHost) + "\"></label>"
    "<label>Carousel name<input name=name value=\"" + htmlEscape(S.name) + "\"></label>"
    "<button>Save and restart</button></form>";
  portal.send(200, "text/html", page);
}

void portalSave() {
  if (portal.hasArg("ssid") && portal.arg("ssid").length()) {
    S.ssid = portal.arg("ssid");
    S.psk = portal.arg("psk");
    if (portal.hasArg("master")) S.masterHost = portal.arg("master");
    if (portal.hasArg("name") && portal.arg("name").length()) S.name = portal.arg("name");
    saveSettings();
    portal.send(200, "text/html", "<meta name=viewport content='width=device-width'><p style='font-family:sans-serif'>Saved. The ESP32 restarts and joins the network.</p>");
    restartAt = millis() + 1500;
  } else {
    portal.send(400, "text/plain", "SSID is required");
  }
}

void startPortal() {
  if (portalOn) return;
  String apName = "PAX-ESP32-" + hostname.substring(hostname.length() - 4);
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(apName.c_str(), SETUP_AP_PASSWORD);
  portal.on("/", HTTP_GET, portalRoot);
  portal.on("/save", HTTP_POST, portalSave);
  portal.begin();
  portalOn = true;
  Serial.println("[agent] setup hotspot " + apName + " (password " SETUP_AP_PASSWORD ") at http://192.168.4.1");
}

void connectProfile(bool useMasterAp) {
  onMasterAp = useMasterAp && S.apSsid.length();
  const String& ssid = onMasterAp ? S.apSsid : S.ssid;
  const String& psk = onMasterAp ? S.apPsk : S.psk;
  if (!ssid.length()) return;
  WiFi.disconnect();
  WiFi.begin(ssid.c_str(), psk.length() ? psk.c_str() : nullptr);
  lastProfileSwitch = millis();
  Serial.println("[agent] joining Wi-Fi " + ssid);
}

void tickWifi() {
  uint32_t now = millis();
  if (reconnectAt && (int32_t)(now - reconnectAt) >= 0) {
    reconnectAt = 0;
    masterStarted = false;
    master.disconnect();
    connectProfile(false);
  }
  if (WiFi.status() == WL_CONNECTED) {
    offlineSince = 0;
    digitalWrite(PIN_STATUS_LED, HIGH);
    if (!masterStarted) {
      static uint32_t lastTry = 0;
      if (now - lastTry > 15000 || lastTry == 0) { lastTry = now; startMasterLink(); }
    }
    return;
  }
  digitalWrite(PIN_STATUS_LED, (now / 400) % 2);
  if (!offlineSince) offlineSince = now;
  if (!S.ssid.length() && !S.apSsid.length()) { startPortal(); return; }
  if (now - lastProfileSwitch > WIFI_FALLBACK_S * 1000UL) {
    // Alternate between the router and the master's hotspot.
    connectProfile(!onMasterAp);
  }
  if (now - offlineSince > PORTAL_AFTER_S * 1000UL) startPortal();
}

// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(200);
  loadSettings();

  uint8_t mac[6];
  WiFi.macAddress(mac);
  char suffix[5];
  snprintf(suffix, sizeof(suffix), "%02x%02x", mac[4], mac[5]);
  hostname = String("pax-esp32-") + suffix;

  pinMode(PIN_STATUS_LED, OUTPUT);
  pinMode(PIN_SHELF_SENSOR, INPUT);
  pinMode(PIN_HOME_SENSOR, INPUT);
  pinMode(PIN_ALARM_A, INPUT);
  pinMode(PIN_ALARM_B, INPUT);
#if ESTOP_FITTED
  pinMode(PIN_ESTOP, INPUT_PULLUP);
#endif
  setupMotorPins();
  stopDrive();
  shelfIn.stable = shelfIn.raw = readActive(shelfIn);
  homeIn.stable = homeIn.raw = readActive(homeIn);

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(hostname.c_str());
  WiFi.setSleep(false);
  if (S.ssid.length()) connectProfile(false);
  else startPortal();

  MDNS.begin(hostname.c_str());
  MDNS.addService("pax-agent", "tcp", AGENT_PORT);

  ws.begin();
  ws.onEvent(onAppEvent);
  Serial.println("[agent] " FIRMWARE " " + hostname + ".local:" + String(AGENT_PORT) + " motor=" + S.motorMode +
                 " positioning=" + S.positionMode + " shelves=" + String(S.shelves));
}

void loop() {
  tickMotion();
  ws.loop();
  if (masterStarted) master.loop();
  if (portalOn) portal.handleClient();
  tickWifi();
  if (restartAt && (int32_t)(millis() - restartAt) >= 0) ESP.restart();
}
