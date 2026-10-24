#!/usr/bin/env python3
"""
Exercises the Wi-Fi flavour of Esp32ServoHardware: a fake standalone board
listening on a real TCP socket, speaking the esp32-servo line protocol.

Checks:
  * host[:port] parsing and the TCP handshake (HELLO -> CFG/ENA/STOP/NET)
  * CFG carries the longer Wi-Fi watchdog (wd_ms=3000)
  * HELLO host= and the NET reply land in the snapshot / net_status()
  * push_wifi() emits WIFIAP then WIFI lines
  * the board closing the socket (it re-joins a new network) is detected and
    the reader loop reconnects on its own
  * NetService in role "esp32" answers net.status from the board and relays a
    master's net.join push as WIFI/WIFIAP + net.ack

Run:  python3 test_esp32_wifi.py
"""
import asyncio
import json
import socket
import sys
import threading
import time
import types

# gpiozero/pyserial are not needed, but the module imports serial lazily in
# the usb path only; keep a stub so an import somewhere else cannot trip.
sys.modules.setdefault("serial", types.ModuleType("serial"))

import paternoster_agent as agent  # noqa: E402

agent.ESP32_HELLO_TIMEOUT_S = 1.0
agent.ESP32_WIFI_STATUS_TIMEOUT_S = 0.6
agent.ESP32_RECONNECT_S = 0.2
agent.SERVO_ENABLE_SETTLE_S = 0.01

checks = 0


def check(cond, what):
    global checks
    checks += 1
    if not cond:
        print(f"FAIL: {what}")
        sys.exit(1)
    print(f"ok: {what}")


def wait_for(pred, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


class FakeBoard(threading.Thread):
    """A pax-esp32 on Wi-Fi: one TCP client at a time, status 20 Hz."""

    def __init__(self):
        super().__init__(daemon=True)
        self.srv = socket.socket()
        self.srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(2)
        self.port = self.srv.getsockname()[1]
        self.sent: list = []
        self.conn = None
        self.accepted = 0
        self.lock = threading.Lock()
        self.alive = True
        self.start()

    def emit(self, line):
        with self.lock:
            c = self.conn
        if c:
            try:
                c.sendall((line + "\n").encode())
            except OSError:
                pass

    def drop(self):
        with self.lock:
            c, self.conn = self.conn, None
        if c:
            c.close()

    def run(self):
        threading.Thread(target=self._status_loop, daemon=True).start()
        while self.alive:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            self.accepted += 1
            with self.lock:
                self.conn = c
            buf = b""
            while self.alive:
                try:
                    data = c.recv(1024)
                except OSError:
                    break
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    self.handle(raw.decode().strip())
            with self.lock:
                if self.conn is c:
                    self.conn = None

    def _status_loop(self):
        while self.alive:
            self.emit("ST run=0 hz=0 dir=1 ena=1 s=0 h=0 aa=0 ab=0 pos=0.0 jog=0 arm=0 hold=00 up=1 wifi=router rssi=-61")
            time.sleep(0.05)

    def handle(self, line):
        if not line:
            return
        self.sent.append(line)
        cmd = line.split()[0]
        if cmd == "HELLO":
            self.emit("HELLO pax-esp32 fw=1.2 baud=460800 host=pax-esp32-1a2b wifi=1")
        elif cmd == "NET":
            self.emit("NET state=router ssid=Lab ip=192.168.1.42 rssi=-61 host=pax-esp32-1a2b router=Lab hotspot=PAX-Setup-1A2B client=1 port=8766")
        elif cmd == "PING":
            self.emit("OK PING")
        else:
            self.emit(f"OK {cmd}")


board = FakeBoard()

# ---- handshake over TCP -------------------------------------------------------
hw = agent.Esp32ServoHardware(link="wifi", port=f"127.0.0.1:{board.port}", max_pps=8000)
check(hw.wifi and hw._wifi_target() == ("127.0.0.1", board.port), "host:port parsed")
check(wait_for(lambda: hw.link_ok), "TCP handshake completes and linkOk is True")
cfg = next(s for s in board.sent if s.startswith("CFG "))
check("wd_ms=600" in cfg, f"CFG carries the Wi-Fi watchdog budget ({cfg.split('wd_ms=')[1]})")
check("NET" in board.sent, "NET requested after HELLO")
check(wait_for(lambda: hw.net_status().get("state") == "router"), "NET reply parsed into net_status()")
snap = hw.servo_snapshot()
check(snap["link"] == "wifi" and snap["port"] == f"127.0.0.1:{board.port}", "snapshot reports link and target")
check(snap["esp32Host"] == "pax-esp32-1a2b" and snap["esp32Wifi"] == "router" and snap["esp32Rssi"] == -61
      and snap["esp32Ip"] == "192.168.1.42", "snapshot carries host / wifi state / rssi / ip")

# ---- credential push ------------------------------------------------------------
board.sent.clear()
check(hw.push_wifi("Lab2", "hunter22", "PAX-Setup-1A2B", "hotspotpw"), "push_wifi accepted while linked")
check(wait_for(lambda: "WIFIAP PAX-Setup-1A2B hotspotpw" in board.sent and "WIFI Lab2 hunter22" in board.sent),
      "WIFIAP and WIFI lines reach the board")
check(board.sent.index("WIFIAP PAX-Setup-1A2B hotspotpw") < board.sent.index("WIFI Lab2 hunter22"),
      "hotspot fallback stored before the router (board re-joins after WIFI)")

# ---- motion still works over the socket -------------------------------------
board.sent.clear()
hw.forward(0.5)
check(wait_for(lambda: "RUN 1 4000" in board.sent), "forward(0.5) -> RUN 1 4000 over TCP")
hw.stop()
check(wait_for(lambda: "STOP" in board.sent), "stop -> STOP over TCP")

# ---- board drops the socket (re-joining Wi-Fi) ---------------------------------
accepted_before = board.accepted
board.drop()
check(wait_for(lambda: not hw.link_ok, 2.0), "closed socket detected as link loss")
check(wait_for(lambda: hw.link_ok and board.accepted > accepted_before, 4.0), "reader loop reconnects and re-handshakes")

# ---- NetService role esp32 -----------------------------------------------------
frames: list = []


class FakeWs:
    def __init__(self):
        self.out: list = []

    async def send(self, raw):
        self.out.append(json.loads(raw))


async def net_part():
    loop = asyncio.get_running_loop()
    args = types.SimpleNamespace(role="esp32", master="127.0.0.1:8765", port=8767, name="Hall 2", no_net=False)
    svc = agent.NetService(args, frames.append, loop)
    check(svc.esp32_role, "NetService recognises role esp32")
    ws = FakeWs()
    await svc.handle(ws, {"type": "net.status"})
    st = next(f for f in frames if f["type"] == "net.status")
    check(st["role"] == "esp32" and st["mode"] == "router" and st["ssid"] == "Lab" and st["hostname"] == "pax-esp32-1a2b"
          and st["signal"] == 78, f"net.status built from the board ({st['mode']}, {st['signal']} %)")
    board.sent.clear()
    await svc.handle(ws, {"type": "net.join", "fromMaster": True, "ssid": "NewRouter", "psk": "longenough",
                          "apSsid": "PAX-Setup-1A2B", "apPsk": "hotspotpw"})
    check(ws.out and ws.out[-1]["type"] == "net.ack" and ws.out[-1]["ok"] and ws.out[-1]["hostname"] == "pax-esp32-1a2b",
          "master push acked with the board's hostname")
    check(wait_for(lambda: "WIFI NewRouter longenough" in board.sent and "WIFIAP PAX-Setup-1A2B hotspotpw" in board.sent),
          "pushed credentials forwarded to the board")
    await svc.handle(ws, {"type": "net.scan"})
    check(ws.out[-1]["type"] == "net.result" and not ws.out[-1]["ok"], "scan refused with a pointer to the master")


asyncio.run(net_part())

hw._close_motor()
board.alive = False
board.srv.close()
print(f"\nall {checks} checks passed")
