# PAX — Paternoster Filament Manager

A self-hosted web app for managing 3D-printer filament: spool inventory, a motorized
Paternoster carousel (Raspberry Pi), and live status for Klipper (Moonraker),
Prusa (PrusaLink), and Bambu Lab printers.

Everything you set up is stored in a **single local SQLite file** (`paternoster.db`) on
the machine that runs the app. There is **no external database and no required API key** to
run it. Any device on your network opens the app in a browser and shares the same data.

The server (your Pi) tracks filament usage **in the background** — as long as the app is
running it keeps polling your printers and deducting filament from the active spool, even
when no phone or computer has the app open. See [Background filament tracking](#background-filament-tracking).

---

## 1. Requirements

Install these once on the machine that will run the app (a PC, a home server, or a
Raspberry Pi 4/5):

- **Node.js 20 or newer** — https://nodejs.org (LTS is fine)
- **pnpm** — the package manager. After installing Node, run:
  ```bash
  sudo npm install -g pnpm
  ```
- **git** — https://git-scm.com
  ```bash
  sudo apt-get update && sudo apt-get install -y git
  ```
- A **C/C++ build toolchain** (needed to compile the SQLite module):
  - **Raspberry Pi / Debian / Ubuntu:** `sudo apt-get install -y build-essential python3`
  - **macOS:** `xcode-select --install`
  - **Windows:** install "Desktop development with C++" from the Visual Studio Build Tools

---

## 2. Download and install

```bash
# 1. Download the code
git clone https://github.com/Swede-maker/paternoster-filament-storage.git pax
cd pax

# 2. Install dependencies (also compiles the SQLite module automatically)
pnpm install

# 3. Build the production app
pnpm build

# 4. Start it
pnpm start
```

The app now runs at **http://localhost:3000**.

To open it from your phone or another computer on the same network, use the host
machine's IP address instead, e.g. `http://192.168.1.50:3000`.

---

## 3. First run

On first launch you'll see **"Set up your storage"** — pick your storage type, name it,
and click **Build machine**. From then on, all your printers, spools, usage totals, and
history are saved automatically to `paternoster.db`.

---

## Background filament tracking

Filament consumption is tracked by the **server**, not the browser. When the app starts,
the Pi launches a background poller (every 5 seconds) that connects to each linked printer
over your LAN — Klipper (Moonraker), Prusa (PrusaLink), and Bambu Lab — and subtracts the
filament used from the spool that is currently printing.

Because this runs on the Pi itself:

- **You do not need the app open** on any phone or computer for weights to update. As long
  as the Pi is powered on and the app is running, tracking continues.
- **A sleeping or powered-off viewing device does not stop tracking.** Only the printer
  needs to be reachable for its own consumption to be recorded.
- When a printer is **off or unreachable**, there is simply nothing to consume; tracking
  resumes automatically the next time it comes online (usage counters are cumulative, so no
  data is lost).
- Any browser you open will catch up to the server's totals within a few seconds.

There is nothing to configure — it starts on its own with the app. To keep it running
around the clock, run the app as a background service (see
[Keeping it running in the background](#5-keeping-it-running-in-the-background-optional)).

---

## 4. Updating to a new version (without losing your setup)

Your data lives in `paternoster.db`, which is **not** part of the code and is never
overwritten by an update. To update:

```bash
cd pax
cp paternoster.db paternoster.db.backup   # optional but recommended
git pull
pnpm install                              # auto-rebuilds the SQLite module
pnpm build
pnpm start                                # or restart your service
```

Your printers and spools reappear automatically because the same database file is reused.

> **Do not** delete the folder or run `git clean -fdx` — those remove `paternoster.db`.
> To move to a fresh folder, copy `paternoster.db` into the new one first.

---

## 5. Keeping it running in the background (optional)

`pnpm start` stops when you close the terminal. To keep it running, use a process manager
such as [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start "pnpm start" --name pax
pm2 save
pm2 startup        # follow the printed instruction to auto-start on boot
```

---

## 6. Configuration (optional)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PATERNOSTER_DB_PATH` | `./paternoster.db` | Absolute path to the database file. Set this to store your data outside the app folder so updates can never touch it. |
| `PORT` | `3000` | Port the web server listens on. |

Example — store data in a fixed location and run on port 8080:

```bash
PATERNOSTER_DB_PATH=/home/pi/pax-data/paternoster.db PORT=8080 pnpm start
```

> **Tip:** setting `PATERNOSTER_DB_PATH` to a path outside the repo is the safest setup —
> you can then delete and re-clone the whole project and your data stays intact.

---

## 7. Troubleshooting

**It shows the setup screen again after an update, or "Could not load your data".**
The compiled SQLite module got out of sync with your Node version. Fix it with:

```bash
pnpm rebuild better-sqlite3
```

then restart. Your data is safe — this only rebuilds the module, it does not touch
`paternoster.db`. (This normally happens automatically during `pnpm install`.)

**Another device can't reach it.**
Make sure you're using the host machine's LAN IP (not `localhost`) and that its firewall
allows the port.

**A printer shows "Not reachable".**
Confirm the printer's IP is correct and that the machine running PAX is on the same
network. Klipper needs Moonraker; Prusa needs PrusaLink enabled on the printer.
