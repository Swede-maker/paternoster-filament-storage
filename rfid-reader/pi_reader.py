#!/usr/bin/env python3
"""
PAX wireless RFID reader — Raspberry Pi agent
=============================================

Reads NFC/RFID tags and POSTs each UID to the PAX web app so any browser
(including iPhones, which can't read NFC on the web) can receive scans by
pressing "Wireless reader" on the Scan tab.

Like the ESP32 firmware, this reaches OUT to the app over HTTP — nothing
connects to the Pi — so there are no HTTPS/mixed-content/CORS problems.

SUPPORTED READERS
  --reader pn532   PN532 over I2C (Adafruit)         [default]
  --reader rc522   MFRC522 over SPI
  --reader usb     A USB HID "keyboard-wedge" reader (reads a line from stdin)
  --reader mock    No hardware; type a UID + Enter to simulate a scan (testing)

QUICK START
  python3 -m venv .venv && source .venv/bin/activate
  pip install -r requirements.txt          # installs only what your reader needs
  python3 pi_reader.py \
      --app-host http://192.168.1.50:3000 \
      --token   PASTE_TOKEN_FROM_APP \
      --reader  pn532 \
      --name    "Bench Pi reader"

  Get the token from the app: Settings -> RFID / QR tags -> Wireless readers ->
  your reader -> Pairing token.

Run it on boot with the provided systemd unit (pax-reader.service).
"""

import argparse
import sys
import time
import threading

try:
    import requests
except ImportError:
    print("Missing dependency: pip install requests", file=sys.stderr)
    sys.exit(1)


PING_INTERVAL_S = 20.0
SAME_TAG_COOLDOWN_S = 1.5


def post(app_host: str, token: str, name: str, uid: str = "", event: str = "tag") -> int:
    """POST a scan (or ping) to the app. Returns HTTP status (or -1 on error)."""
    url = app_host.rstrip("/") + "/api/reader/scan"
    payload = {"token": token, "event": event, "name": name}
    if uid:
        payload["uid"] = uid
    try:
        r = requests.post(url, json=payload, timeout=5)
        # Body is { ok, listeners } — listeners>0 means a browser is waiting.
        try:
            data = r.json()
        except Exception:
            data = {}
        if event == "tag":
            print(f"[scan] uid={uid} -> {r.status_code} listeners={data.get('listeners', '?')}")
        return r.status_code
    except requests.RequestException as e:
        print(f"[http] POST failed: {e}", file=sys.stderr)
        return -1


def keepalive_loop(app_host: str, token: str, name: str, stop: threading.Event) -> None:
    """Background presence pings so the app shows the reader as online."""
    post(app_host, token, name, event="ping")  # announce immediately
    while not stop.wait(PING_INTERVAL_S):
        post(app_host, token, name, event="ping")


# --------------------------------------------------------------------------
# Readers: each is a generator yielding uppercase-hex UID strings.
# --------------------------------------------------------------------------

def read_pn532():
    """PN532 over I2C via Adafruit CircuitPython. pip: adafruit-circuitpython-pn532"""
    import board
    import busio
    from adafruit_pn532.i2c import PN532_I2C

    i2c = busio.I2C(board.SCL, board.SDA)
    pn532 = PN532_I2C(i2c, debug=False)
    ic, ver, rev, support = pn532.firmware_version
    print(f"[pn532] found PN5{ic:02x} firmware {ver}.{rev}")
    pn532.SAM_configuration()
    while True:
        uid = pn532.read_passive_target(timeout=0.5)
        if uid is None:
            continue
        yield "".join(f"{b:02X}" for b in uid)


def read_rc522():
    """MFRC522 over SPI. pip: mfrc522 (pulls in RPi.GPIO)."""
    from mfrc522 import SimpleMFRC522  # type: ignore

    reader = SimpleMFRC522()
    print("[rc522] ready")
    while True:
        uid_int, _text = reader.read()  # blocks until a tag is present
        # SimpleMFRC522 returns the UID as an int; render as hex.
        yield format(uid_int, "X")
        time.sleep(0.2)


def read_usb():
    """USB HID 'keyboard-wedge' reader: each scan arrives as a line on stdin."""
    print("[usb] reading scans from stdin (each line = one tag)")
    for line in sys.stdin:
        code = line.strip()
        if code:
            yield code.upper()


def read_mock():
    """No hardware — type a UID and press Enter to simulate a scan."""
    print("[mock] type a UID + Enter to simulate a scan (Ctrl-C to quit)")
    for line in sys.stdin:
        code = line.strip()
        if code:
            yield code.upper()


READERS = {
    "pn532": read_pn532,
    "rc522": read_rc522,
    "usb": read_usb,
    "mock": read_mock,
}


def main() -> None:
    ap = argparse.ArgumentParser(description="PAX wireless RFID reader agent")
    ap.add_argument("--app-host", required=True, help="PAX app origin, e.g. http://192.168.1.50:3000")
    ap.add_argument("--token", required=True, help="Pairing token from the app (keep secret)")
    ap.add_argument("--reader", choices=list(READERS), default="pn532")
    ap.add_argument("--name", default="Pi reader", help="Friendly reader name shown in the app")
    args = ap.parse_args()

    stop = threading.Event()
    t = threading.Thread(target=keepalive_loop, args=(args.app_host, args.token, args.name, stop), daemon=True)
    t.start()

    print(f"[pax] reader='{args.reader}' -> {args.app_host}  (name: {args.name})")
    last_uid = ""
    last_at = 0.0
    try:
        for uid in READERS[args.reader]():
            now = time.monotonic()
            # Debounce a tag held on the reader.
            if uid == last_uid and now - last_at < SAME_TAG_COOLDOWN_S:
                continue
            last_uid, last_at = uid, now
            post(args.app_host, args.token, args.name, uid=uid, event="tag")
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


if __name__ == "__main__":
    main()
