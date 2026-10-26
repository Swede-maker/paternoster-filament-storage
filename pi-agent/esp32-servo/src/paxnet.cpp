#include "paxnet.h"

#include <WiFi.h>
#include <WiFiClient.h>
#include <WiFiServer.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <WebServer.h>
#include <Update.h>
#include <Preferences.h>

#ifndef PAX_LINK_PORT
#define PAX_LINK_PORT 8766
#endif
#ifndef PAX_OTA_PASSWORD_DEFAULT
#define PAX_OTA_PASSWORD_DEFAULT "pax-esp32"
#endif

namespace paxnet {

// Same timings as the Pi slaves (pi-agent/paxnet.py Watchdog).
static const uint32_t ROUTER_TIMEOUT_MS = 45000;   // give up on the router -> hotspot
static const uint32_t AP_TIMEOUT_MS = 30000;       // hotspot join attempt
static const uint32_t RETRY_ROUTER_MS = 60000;     // while on the hotspot
static const uint32_t IDLE_RESCAN_MS = 15000;      // nothing to join: look again

enum class Target : uint8_t { None, Router, Ap };
enum class State : uint8_t { Disabled, Connecting, Router, Ap, Offline };

static Preferences g_prefs;
static String g_routerSsid, g_routerPsk;
static String g_apSsid, g_apPsk;
static String g_hostname;
static String g_otaPass;
static const char* g_fw = "?";
static LineSink g_sink = nullptr;

static State g_state = State::Disabled;
static Target g_target = Target::None;
static uint32_t g_attemptMs = 0;       // when the current join attempt started
static uint32_t g_lastRouterTryMs = 0; // last time we tried the router while on the AP
static bool g_servicesUp = false;
static bool g_updating = false;
static bool g_radioOff = false; // persisted: a Pi master over USB/UART needs no Wi-Fi
static char g_statusBuf[64] = "";

static WiFiServer g_server(PAX_LINK_PORT);
static WiFiClient g_client;
static WebServer g_http(80);

static void notice(const char* fmt, ...) {
  char buf[200];
  va_list ap; va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (g_sink) g_sink(buf);
}

static const char* stateName(State s) {
  switch (s) {
    case State::Router: return "router";
    case State::Ap: return "ap";
    case State::Connecting: return "connecting";
    case State::Offline: return "offline";
    default: return "disabled";
  }
}

static String defaultHostname() {
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char buf[24];
  snprintf(buf, sizeof buf, "pax-esp32-%02x%02x", mac[4], mac[5]);
  return String(buf);
}

static bool validHostname(const String& h) {
  if (h.length() < 1 || h.length() > 32) return false;
  for (size_t i = 0; i < h.length(); i++) {
    char c = h[i];
    if (!(isalnum((unsigned char)c) || c == '-')) return false;
    if (isupper((unsigned char)c)) return false;
  }
  return h[0] != '-' && h[h.length() - 1] != '-';
}

static void load() {
  g_prefs.begin("paxnet", false);
  g_routerSsid = g_prefs.getString("rssid", "");
  g_routerPsk = g_prefs.getString("rpsk", "");
  g_apSsid = g_prefs.getString("assid", "");
  g_apPsk = g_prefs.getString("apsk", "");
  g_hostname = g_prefs.getString("host", "");
  g_otaPass = g_prefs.getString("ota", PAX_OTA_PASSWORD_DEFAULT);
  g_radioOff = g_prefs.getBool("off", false);
  if (!validHostname(g_hostname)) g_hostname = defaultHostname();
}

// ---------------------------------------------------------------------------
// Station manager
// ---------------------------------------------------------------------------
static void startJoin(Target t) {
  const String& ssid = t == Target::Router ? g_routerSsid : g_apSsid;
  const String& psk = t == Target::Router ? g_routerPsk : g_apPsk;
  g_target = t;
  g_state = State::Connecting;
  g_attemptMs = millis();
  WiFi.disconnect(false, false);
  WiFi.begin(ssid.c_str(), psk.length() ? psk.c_str() : nullptr);
  notice("EV NET joining %s \"%s\"", t == Target::Router ? "router" : "hotspot", ssid.c_str());
}

static void stopServices() {
  if (!g_servicesUp) return;
  if (g_client) g_client.stop();
  g_server.stop();
  g_http.stop();
  ArduinoOTA.end();
  MDNS.end();
  g_servicesUp = false;
}

static void httpRoot();
static void httpStatus();
static void httpUpdateDone();
static void httpUpdateChunk();

static void startServices() {
  if (g_servicesUp) return;
  MDNS.begin(g_hostname.c_str());
  MDNS.addService("pax-esp32", "tcp", PAX_LINK_PORT);
  MDNS.addService("http", "tcp", 80);
  g_server.begin();
  g_server.setNoDelay(true);

  g_http.on("/", HTTP_GET, httpRoot);
  g_http.on("/status", HTTP_GET, httpStatus);
  g_http.on("/update", HTTP_POST, httpUpdateDone, httpUpdateChunk);
  g_http.begin();

  ArduinoOTA.setHostname(g_hostname.c_str());
  ArduinoOTA.setPassword(g_otaPass.c_str());
  ArduinoOTA.onStart([]() { g_updating = true; notice("EV OTA start"); });
  ArduinoOTA.onEnd([]() { notice("EV OTA done, rebooting"); });
  ArduinoOTA.onError([](ota_error_t e) { g_updating = false; notice("EV OTA error %u", (unsigned)e); });
  ArduinoOTA.begin();
  g_servicesUp = true;
}

static void onConnected() {
  g_state = g_target == Target::Router ? State::Router : State::Ap;
  g_lastRouterTryMs = millis();
  startServices();
  notice("EV NET up %s ssid=\"%s\" ip=%s host=%s.local link=tcp:%u", stateName(g_state),
         WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), g_hostname.c_str(), (unsigned)PAX_LINK_PORT);
}

static void pickTarget() {
  if (g_routerSsid.length()) startJoin(Target::Router);
  else if (g_apSsid.length()) startJoin(Target::Ap);
  else { g_state = State::Offline; g_target = Target::None; g_attemptMs = millis(); }
}

static bool g_motion = false;

static void stationLoop() {
  if (g_state == State::Disabled) return;
  if (g_motion) return;
  uint32_t now = millis();
  bool up = WiFi.status() == WL_CONNECTED;

  switch (g_state) {
    case State::Connecting: {
      if (up) { onConnected(); break; }
      uint32_t limit = g_target == Target::Router ? ROUTER_TIMEOUT_MS : AP_TIMEOUT_MS;
      if (now - g_attemptMs > limit) {
        notice("EV NET %s not reachable", g_target == Target::Router ? "router" : "hotspot");
        if (g_target == Target::Router && g_apSsid.length()) startJoin(Target::Ap);
        else if (g_target == Target::Ap && g_routerSsid.length()) startJoin(Target::Router);
        else { g_state = State::Offline; g_attemptMs = now; WiFi.disconnect(false, false); }
      }
      break;
    }
    case State::Router:
      if (!up) { notice("EV NET router lost"); stopServices(); pickTarget(); }
      break;
    case State::Ap:
      if (!up) { notice("EV NET hotspot lost"); stopServices(); pickTarget(); break; }
      // Periodically try to get back onto the router, but never while the
      // master is actually driving us: a reconnect costs the TCP session.
      if (g_routerSsid.length() && !g_client && now - g_lastRouterTryMs > RETRY_ROUTER_MS) {
        g_lastRouterTryMs = now;
        stopServices();
        startJoin(Target::Router);
      }
      break;
    case State::Offline:
      if (now - g_attemptMs > IDLE_RESCAN_MS) pickTarget();
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// TCP link
// ---------------------------------------------------------------------------
static void linkLoop() {
  if (!g_servicesUp) return;
  if (g_server.hasClient()) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    WiFiClient next = g_server.accept();
#else
    WiFiClient next = g_server.available();
#endif
    if (g_client && g_client.connected()) {
      notice("EV NET new client %s replaces %s", next.remoteIP().toString().c_str(),
             g_client.remoteIP().toString().c_str());
      g_client.stop();
    } else {
      notice("EV NET client %s connected", next.remoteIP().toString().c_str());
    }
    g_client = next;
    g_client.setNoDelay(true);
  }
  if (g_client && !g_client.connected()) {
    g_client.stop();
    notice("EV NET client disconnected");
  }
}

// ---------------------------------------------------------------------------
// HTTP (status + firmware upload)
// ---------------------------------------------------------------------------
// Credentials are checked once, when the upload starts; the chunk handler
// must not answer the request itself, so it only records the verdict.
static bool g_uploadAuthed = false;

static void httpRoot() {
  String page;
  page.reserve(1600);
  page += F("<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
            "<title>PAX ESP32</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:40em;margin:2em auto;padding:0 1em;color:#222}"
            "code{background:#eee;padding:.1em .3em;border-radius:3px}dl{display:grid;grid-template-columns:max-content 1fr;gap:.25em 1em}"
            "dt{color:#666}form{margin-top:2em;padding:1em;border:1px solid #ccc;border-radius:6px}</style></head><body>");
  page += F("<h1>PAX servo controller</h1><dl>");
  page += F("<dt>Firmware</dt><dd>"); page += g_fw; page += F("</dd>");
  page += F("<dt>Hostname</dt><dd>"); page += g_hostname; page += F(".local</dd>");
  page += F("<dt>Network</dt><dd>"); page += stateName(g_state); page += F(" — "); page += WiFi.SSID(); page += F("</dd>");
  page += F("<dt>IP</dt><dd>"); page += WiFi.localIP().toString(); page += F("</dd>");
  page += F("<dt>RSSI</dt><dd>"); page += String(WiFi.RSSI()); page += F(" dBm</dd>");
  page += F("<dt>Link</dt><dd>tcp:"); page += String(PAX_LINK_PORT); page += g_client ? F(" — master connected") : F(" — waiting for the master"); page += F("</dd>");
  page += F("<dt>Uptime</dt><dd>"); page += String(millis() / 1000); page += F(" s</dd></dl>");
  page += F("<form method=POST action=/update enctype=multipart/form-data><strong>Firmware update</strong><br>"
            "Build with <code>pio run</code> and upload <code>.pio/build/esp32dev/firmware.bin</code>. The board reboots when done; "
            "motors are held off during the upload.<br><br><input type=file name=firmware accept=.bin required> "
            "<button>Upload</button></form></body></html>");
  g_http.send(200, "text/html", page);
}

static void httpStatus() {
  char buf[320];
  snprintf(buf, sizeof buf,
           "{\"fw\":\"%s\",\"host\":\"%s\",\"state\":\"%s\",\"ssid\":\"%s\",\"ip\":\"%s\",\"rssi\":%d,"
           "\"port\":%u,\"client\":%s,\"uptimeS\":%lu}",
           g_fw, g_hostname.c_str(), stateName(g_state), WiFi.SSID().c_str(),
           WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(), (unsigned)PAX_LINK_PORT,
           g_client ? "true" : "false", (unsigned long)(millis() / 1000));
  g_http.send(200, "application/json", buf);
}

static void httpUpdateChunk() {
  HTTPUpload& up = g_http.upload();
  if (up.status == UPLOAD_FILE_START) {
    g_uploadAuthed = g_http.authenticate("admin", g_otaPass.c_str());
    if (!g_uploadAuthed) { notice("EV OTA web upload refused (bad password)"); return; }
    g_updating = true;
    notice("EV OTA web upload %s", up.filename.c_str());
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) notice("EV OTA begin failed: %s", Update.errorString());
  } else if (!g_uploadAuthed) {
    return;
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (Update.write(up.buf, up.currentSize) != up.currentSize) notice("EV OTA write failed: %s", Update.errorString());
  } else if (up.status == UPLOAD_FILE_END) {
    if (Update.end(true)) notice("EV OTA web upload done (%u bytes)", (unsigned)up.totalSize);
    else notice("EV OTA end failed: %s", Update.errorString());
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    g_updating = false;
    notice("EV OTA web upload aborted");
  }
}

static void httpUpdateDone() {
  if (!g_uploadAuthed) {
    g_http.requestAuthentication(BASIC_AUTH, "pax-esp32", "firmware password required");
    return;
  }
  bool ok = !Update.hasError();
  String body = ok ? String("OK - rebooting\n") : String("FAILED: ") + Update.errorString() + "\n";
  g_http.sendHeader("Connection", "close");
  g_http.send(ok ? 200 : 500, "text/plain", body);
  g_uploadAuthed = false;
  if (ok) { delay(300); ESP.restart(); }
  g_updating = false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
static void radioOff() {
  stopServices();
  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_OFF);
  g_state = State::Disabled;
  g_target = Target::None;
}

static void radioOn() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(g_hostname.c_str());
  WiFi.setAutoReconnect(false);
  WiFi.setSleep(false);
  if (!g_routerSsid.length() && !g_apSsid.length()) {
    g_state = State::Offline;
    g_attemptMs = millis();
    return;
  }
  pickTarget();
}

void begin(const char* fwVersion, LineSink sink) {
  g_fw = fwVersion;
  g_sink = sink;
  load();
  if (g_radioOff) {
    radioOff();
    notice("EV NET Wi-Fi off (WIFIOFF 0 turns it back on)");
    return;
  }
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(g_hostname.c_str());
  WiFi.setAutoReconnect(false); // the state machine decides what to join
  WiFi.setSleep(false);         // latency matters more than a few mA here
  if (!g_routerSsid.length() && !g_apSsid.length()) {
    g_state = State::Offline;
    g_attemptMs = millis();
    notice("EV NET no credentials — send WIFI <ssid> <psk> (router) and/or WIFIAP <ssid> <psk> (master hotspot)");
    return;
  }
  pickTarget();
}

void loop() {
  stationLoop();
  linkLoop();
  if (g_servicesUp) {
    g_http.handleClient();
    ArduinoOTA.handle();
  }
}

void setMotion(bool moving) { g_motion = moving; }

Stream* client() { return (g_client && g_client.connected()) ? &g_client : nullptr; }
bool clientConnected() { return g_client && g_client.connected(); }

void print(const char* line) {
  if (g_client && g_client.connected()) g_client.println(line);
}

const char* hostname() { return g_hostname.c_str(); }
bool updating() { return g_updating; }

const char* statusSuffix() {
  if (g_state == State::Disabled) { g_statusBuf[0] = 0; return g_statusBuf; }
  snprintf(g_statusBuf, sizeof g_statusBuf, " wifi=%s rssi=%d", stateName(g_state),
           WiFi.status() == WL_CONNECTED ? (int)WiFi.RSSI() : 0);
  return g_statusBuf;
}

static bool setCreds(const char* which, char* save, LineSink reply, String& ssidOut, String& pskOut,
                     const char* ssidKey, const char* pskKey) {
  char* ssid = strtok_r(nullptr, " ", &save);
  if (!ssid) { char b[64]; snprintf(b, sizeof b, "ERR %s needs <ssid> [psk] or 0", which); reply(b); return true; }
  if (!strcmp(ssid, "0")) {
    ssidOut = ""; pskOut = "";
    g_prefs.remove(ssidKey); g_prefs.remove(pskKey);
    char b[48]; snprintf(b, sizeof b, "OK %s forgotten", which); reply(b);
  } else {
    // The psk is the rest of the line (may contain spaces); SSIDs with
    // spaces are not supported on the wire — use the hotspot or rename.
    char* psk = save && *save ? save : nullptr;
    size_t pl = psk ? strlen(psk) : 0;
    if (strlen(ssid) > 32) { reply("ERR ssid longer than 32 bytes"); return true; }
    if (pl && (pl < 8 || pl > 63)) { reply("ERR psk must be 8-63 characters (or empty for an open network)"); return true; }
    ssidOut = ssid; pskOut = psk ? psk : "";
    g_prefs.putString(ssidKey, ssidOut);
    g_prefs.putString(pskKey, pskOut);
    char b[80]; snprintf(b, sizeof b, "OK %s %s", which, ssid); reply(b);
  }
  // Re-evaluate what to join: new router creds win over the hotspot.
  stopServices();
  if (g_state != State::Disabled) pickTarget();
  return true;
}

bool radioEnabled() { return !g_radioOff; }

bool handleCommand(const char* cmd, char* save, LineSink reply) {
  if (!strcmp(cmd, "WIFIOFF")) {
    char* v = strtok_r(nullptr, " ", &save);
    if (!v || (strcmp(v, "0") && strcmp(v, "1"))) { reply("ERR WIFIOFF needs 1 (off) or 0 (on)"); return true; }
    bool off = v[0] == '1';
    if (off != g_radioOff) {
      g_radioOff = off;
      g_prefs.putBool("off", off);
      if (off) radioOff(); else radioOn();
      notice(off ? "EV NET Wi-Fi off" : "EV NET Wi-Fi on");
    }
    reply(off ? "OK WIFIOFF 1" : "OK WIFIOFF 0");
    return true;
  }
  if (!strcmp(cmd, "WIFI")) return setCreds("WIFI", save, reply, g_routerSsid, g_routerPsk, "rssid", "rpsk");
  if (!strcmp(cmd, "WIFIAP")) return setCreds("WIFIAP", save, reply, g_apSsid, g_apPsk, "assid", "apsk");
  if (!strcmp(cmd, "HOSTNAME")) {
    char* h = strtok_r(nullptr, " ", &save);
    String name = h ? String(h) : String("");
    if (!validHostname(name)) { reply("ERR HOSTNAME needs 1-32 chars of a-z 0-9 -"); return true; }
    g_hostname = name;
    g_prefs.putString("host", g_hostname);
    char b[64]; snprintf(b, sizeof b, "OK HOSTNAME %s (applies after REBOOT)", h); reply(b);
    return true;
  }
  if (!strcmp(cmd, "OTAPASS")) {
    char* p = save && *save ? save : nullptr;
    if (!p || strlen(p) < 6 || strlen(p) > 63) { reply("ERR OTAPASS needs 6-63 characters"); return true; }
    g_otaPass = p;
    g_prefs.putString("ota", g_otaPass);
    reply("OK OTAPASS (applies after REBOOT)");
    return true;
  }
  if (!strcmp(cmd, "NET")) {
    char b[240];
    snprintf(b, sizeof b, "NET state=%s ssid=%s ip=%s rssi=%d host=%s router=%s hotspot=%s client=%d port=%u",
             stateName(g_state), WiFi.status() == WL_CONNECTED ? WiFi.SSID().c_str() : "-",
             WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "-",
             WiFi.status() == WL_CONNECTED ? (int)WiFi.RSSI() : 0, g_hostname.c_str(),
             g_routerSsid.length() ? g_routerSsid.c_str() : "-", g_apSsid.length() ? g_apSsid.c_str() : "-",
             clientConnected() ? 1 : 0, (unsigned)PAX_LINK_PORT);
    reply(b);
    return true;
  }
  if (!strcmp(cmd, "REBOOT")) {
    reply("OK REBOOT");
    delay(100);
    ESP.restart();
    return true;
  }
  return false;
}

} // namespace paxnet
