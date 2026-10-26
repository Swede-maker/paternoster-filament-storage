/*
 * PAX servo controller — Wi-Fi link, hotspot fallback and OTA
 * ============================================================
 *
 * Lets the controller run as a STANDALONE SLAVE: no Raspberry Pi on this
 * carousel. The master Pi reaches it over Wi-Fi with exactly the same
 * newline protocol it would speak over USB, so paternoster_agent.py runs a
 * second instance pointed at this board (`--esp32-link wifi`) and keeps every
 * decision (shelves, ramps, homing, pairing) where it already lives.
 *
 *   TCP :8766      the line protocol (one client at a time; a new client
 *                  replaces the old one). Motors stop when the client drops,
 *                  exactly like the serial watchdog.
 *   mDNS           <hostname>.local (default pax-esp32-<last 4 of MAC>)
 *   HTTP :80       GET /        status page + firmware upload form
 *                  GET /status  JSON
 *                  POST /update firmware .bin (Update.h), password protected
 *   ArduinoOTA     :3232 so `pio run -t upload --upload-port <host>` works
 *
 * Station manager (mirrors the Pi slaves' paxnet.py behaviour):
 *   boot → try the router profile (45 s) → fall back to the master Pi's
 *   hotspot → while on the hotspot, retry the router every 60 s.
 *
 * Credentials live in NVS and arrive over the link (any port):
 *   WIFI <ssid> <psk>       router        (psk may be empty for open networks)
 *   WIFIAP <ssid> <psk>     master hotspot fallback
 *   WIFI 0 / WIFIAP 0       forget
 *   HOSTNAME <name>         mDNS name (a–z 0–9 -), applied on reboot
 *   OTAPASS <password>      OTA / web-upload password (default "pax-esp32")
 *   NET                     -> NET state=router|ap|offline|disabled ssid=…
 *                              ip=… rssi=… host=… client=0|1
 *   REBOOT
 *
 * The master agent pushes WIFI/WIFIAP automatically whenever the operator
 * saves new router credentials in the app, so after the first `WIFI …` typed
 * on the USB console this board never needs the cable again.
 */
#pragma once

#include <Arduino.h>

namespace paxnet {

typedef void (*LineSink)(const char* line);

// Load NVS settings and start the station manager. `sink` receives notices
// (EV …) for mirroring onto the serial ports.
void begin(const char* fwVersion, LineSink sink);

// Call every loop(): Wi-Fi state machine, client accept, HTTP/OTA servicing.
void loop();

// The active TCP client as a Stream (nullptr if none). Lines read from it
// are protocol commands like any serial port.
Stream* client();
bool clientConnected();

// Mirror one protocol line to the TCP client (no-op if none).
void print(const char* line);

// Handle WIFI/WIFIAP/HOSTNAME/OTAPASS/NET/REBOOT. `reply` receives the OK/ERR
// line. Returns false if `cmd` is not a network command.
bool handleCommand(const char* cmd, char* save, LineSink reply);

// Short form for the ST line, e.g. " wifi=router rssi=-61".
const char* statusSuffix();

// mDNS hostname in use.
const char* hostname();

// True while an OTA upload is in progress: callers should keep motors off.
bool updating();

// Tell the Wi-Fi manager the motors are moving. While set, it defers joins,
// reconnects and service restarts: WiFi.begin / MDNS.begin can block loop()
// long enough to starve the UART reader and trip the link watchdog mid-move.
void setMotion(bool moving);

// False after WIFIOFF 1 (persisted): the radio stays off until WIFIOFF 0.
bool radioEnabled();

} // namespace paxnet
