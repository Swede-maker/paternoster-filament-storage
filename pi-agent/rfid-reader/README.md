# PAX wireless RFID reader

Turn an **ESP32** or **Raspberry Pi** into a wireless RFID/NFC reader for the PAX
filament system. This solves the iPhone problem: iPhones (and desktops) can't
read NFC from a web page, so instead the hardware reader reads the tag and
**pushes** it to the app. Any browser then receives the scan.

## How it works

```
  [ RFID tag ]
       |  (tap)
       v
  ESP32 / Raspberry Pi  --- HTTP POST /api/reader/scan --->  PAX app server
                                                                  |
                                            Server-Sent Events (SSE) fan-out
                                                                  v
                              Any browser waiting on the Scan tab (iPhone, iPad, desktop)
```

The reader always **connects out** to the app — the browser never connects to
the reader. That's what makes it work everywhere: no HTTPS mixed-content, no TLS
on the device, no CORS, no local-network permission prompts. The **pairing
token** is both the shared secret and the channel id: the reader posts with it,
the browser listens on it, and matching tokens is the whole contract (the server
keeps no token database).

## Pairing (in the app)

1. Open **Settings → RFID / QR tags → Wireless readers**.
2. Click **Pair a reader**, give it a name, pick ESP32 or Raspberry Pi.
3. Expand the reader row to copy its **POST endpoint** and **pairing token**.

The reader row shows a live **online/offline** lamp once the device starts
pinging.

## Using it

On the **Scan** tab (or any "scan a tag" dialog), a **Wireless reader** banner
appears whenever a reader is paired. When it reads "ready", tap a tag on the
hardware reader and the app resolves it exactly like a phone-NFC or QR scan —
opening the bound spool, or offering to bind the tag if it's new.

## ESP32 setup

See [`esp32-reader.ino`](./esp32-reader.ino). Hardware: ESP32 + PN532 (I2C mode).
Fill in Wi‑Fi, `APP_HOST`, and `READER_TOKEN`, install the **Adafruit PN532** and
**ArduinoJson** libraries, and flash. Watch the Serial Monitor at 115200 baud.

For an `https://` app host, switch to `WiFiClientSecure` (a comment in the sketch
explains the one-line `setInsecure()` option and how to pin a CA instead).

## Raspberry Pi setup

See [`pi_reader.py`](./pi_reader.py). Supports **PN532** (I2C), **MFRC522** (SPI),
a **USB keyboard-wedge** reader, and a **mock** mode for testing with no hardware.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt   # uncomment the extra for your reader

python3 pi_reader.py \
  --app-host http://192.168.1.50:3000 \
  --token   PASTE_TOKEN_FROM_APP \
  --reader  pn532 \
  --name    "Bench Pi reader"
```

Run on boot with [`pax-reader.service`](./pax-reader.service).

### Test without hardware

```bash
python3 pi_reader.py --app-host http://localhost:3000 --token <TOKEN> --reader mock
# then type a UID and press Enter — it appears in the app instantly.
```

You can also test with nothing but `curl`:

```bash
curl -X POST http://localhost:3000/api/reader/scan \
  -H 'Content-Type: application/json' \
  -d '{"token":"<TOKEN>","uid":"04A2B3C4D5"}'
```

## Security notes

- The token is a bearer capability — **keep it secret**. Anyone with it can
  inject scans or observe them. Remove the reader in the app to revoke it
  (mint a new one to rotate).
- Endpoints only accept LAN-style deployments well; for internet-exposed
  deployments put the app behind HTTPS and treat the token like a password.
