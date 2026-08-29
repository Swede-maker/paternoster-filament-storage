/*
 * PAX wireless RFID reader — ESP32 firmware
 * =========================================
 *
 * Reads NFC/RFID tags with a PN532 module and POSTs each tag's UID to the PAX
 * web app. Any browser (including iPhones, which can't read NFC on the web) can
 * then press "Wireless reader" on the Scan tab and receive the scan instantly.
 *
 * WHY THIS DESIGN
 *   The board reaches OUT to the app over plain HTTP — it never runs a server
 *   and the browser never connects to the board. That sidesteps every problem
 *   with a browser talking to a bare LAN device (HTTPS mixed-content, no TLS on
 *   the ESP32, CORS, local-network permission prompts).
 *
 * HARDWARE
 *   - ESP32 dev board (any).
 *   - PN532 NFC module in I2C mode (set the module's DIP/solder jumpers to I2C).
 *       PN532 SDA -> ESP32 GPIO21
 *       PN532 SCL -> ESP32 GPIO22
 *       PN532 VCC -> 3V3,  GND -> GND
 *   - (Optional) an LED on GPIO2 lights while a scan is being delivered.
 *   An RC522 works too, but needs a different library (see the .py agent notes).
 *
 * LIBRARIES (Arduino IDE -> Library Manager)
 *   - "Adafruit PN532"
 *   - "ArduinoJson"
 *   ESP32 board support: https://espressif.github.io/arduino-esp32/package_esp32_index.json
 *
 * SETUP
 *   1. Fill in WIFI_SSID / WIFI_PASS.
 *   2. Set APP_HOST to your PAX app's origin, e.g.
 *        "http://192.168.1.50:3000"  (LAN dev server)  or
 *        "https://pax.example.com"   (deployed; see the HTTPS note below).
 *   3. Paste the READER_TOKEN shown in the app: Settings -> RFID / QR tags ->
 *      Wireless readers -> your reader -> Pairing token.
 *   4. Flash. Watch the Serial Monitor at 115200 for status.
 *
 * HTTPS NOTE
 *   For an https:// APP_HOST use WiFiClientSecure. The simplest robust option on
 *   an ESP32 is client.setInsecure() (skips cert validation). If you want real
 *   validation, pin the server's root CA with client.setCACert(...).
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_PN532.h>
#include <ArduinoJson.h>

// ------------------------- CONFIG: EDIT THESE -------------------------
static const char *WIFI_SSID = "YOUR_WIFI";
static const char *WIFI_PASS = "YOUR_WIFI_PASSWORD";

// Your PAX app origin (no trailing slash).
static const char *APP_HOST = "http://192.168.1.50:3000";

// Pairing token from the app (Settings -> Wireless readers). KEEP SECRET.
static const char *READER_TOKEN = "PASTE_TOKEN_FROM_APP";

// Friendly name reported to the app on the first scan (optional).
static const char *READER_NAME = "ESP32 reader";

// Seconds between keepalive pings so the app shows the reader as "online".
static const unsigned long PING_INTERVAL_MS = 20000UL;

// Ignore the same tag if re-read within this window (debounce), ms.
static const unsigned long SAME_TAG_COOLDOWN_MS = 1500UL;

static const int LED_PIN = 2; // onboard LED on most ESP32 dev boards
// ----------------------------------------------------------------------

// PN532 over I2C (IRQ/RESET unused in I2C polling mode).
Adafruit_PN532 nfc(-1, -1, &Wire);

unsigned long lastPing = 0;
String lastUid;
unsigned long lastUidAt = 0;

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000UL) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[wifi] FAILED — will retry");
  }
}

// Format the PN532's binary UID as uppercase hex, e.g. "04A2B3C4D5".
String uidToHex(const uint8_t *uid, uint8_t len) {
  String out;
  for (uint8_t i = 0; i < len; i++) {
    if (uid[i] < 0x10) out += "0";
    out += String(uid[i], HEX);
  }
  out.toUpperCase();
  return out;
}

// POST a scan (or ping) to the app. Returns the HTTP status code (or <0).
int postToApp(const String &uid, const char *event) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  String url = String(APP_HOST) + "/api/reader/scan";
  if (!http.begin(url)) {
    Serial.println("[http] begin() failed (for https:// see the WiFiClientSecure note)");
    return -2;
  }
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<256> doc;
  doc["token"] = READER_TOKEN;
  doc["event"] = event;
  if (uid.length()) doc["uid"] = uid;
  doc["name"] = READER_NAME;
  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  if (code > 0) {
    // The app replies { ok, listeners } — listeners>0 means a browser is waiting.
    Serial.printf("[http] %s -> %d %s\n", event, code, http.getString().c_str());
  } else {
    Serial.printf("[http] POST failed: %s\n", http.errorToString(code).c_str());
  }
  http.end();
  return code;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Wire.begin(21, 22); // SDA=21, SCL=22
  nfc.begin();
  uint32_t ver = nfc.getFirmwareVersion();
  if (!ver) {
    Serial.println("[pn532] not found — check wiring and that the module is in I2C mode.");
  } else {
    Serial.printf("[pn532] found, firmware 0x%08X\n", ver);
    nfc.SAMConfig(); // ready to read passive targets
  }

  connectWifi();
  postToApp("", "ping"); // announce presence immediately
  lastPing = millis();
}

void loop() {
  connectWifi();

  // Keepalive so the app's "reader online" lamp stays lit between scans.
  if (millis() - lastPing >= PING_INTERVAL_MS) {
    postToApp("", "ping");
    lastPing = millis();
  }

  // Poll for a tag (100 ms timeout keeps the ping loop responsive).
  uint8_t uid[7] = {0};
  uint8_t uidLen = 0;
  bool found = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, 100);
  if (!found || uidLen == 0) return;

  String hex = uidToHex(uid, uidLen);
  unsigned long now = millis();
  // Debounce: the same tag held on the reader would otherwise fire repeatedly.
  if (hex == lastUid && now - lastUidAt < SAME_TAG_COOLDOWN_MS) return;
  lastUid = hex;
  lastUidAt = now;

  Serial.printf("[scan] uid=%s\n", hex.c_str());
  digitalWrite(LED_PIN, HIGH);
  postToApp(hex, "tag");
  digitalWrite(LED_PIN, LOW);
}
