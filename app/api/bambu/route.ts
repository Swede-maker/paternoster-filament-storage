import { type NextRequest, NextResponse } from "next/server"

/**
 * Server-side proxy to a Bambu Lab printer's MQTT interface.
 *
 * LAN mode: mqtts://<ip>:8883, username `bblp`, password = the printer's access
 * code; topics `device/<serial>/request` (publish a `pushall`) and
 * `device/<serial>/report` (subscribe for the full state, including `print.ams`
 * with per-tray type/color/weight/uuid + the active tray).
 *
 * This only works when the server can reach the printer's LAN IP (self-hosted on
 * the same network). On a cloud/preview deployment that address is unreachable,
 * so we fall back to a deterministic SIMULATION with the same shape so the AMS /
 * RFID flows stay demoable. Access codes are used server-side only and never
 * logged or returned to the client.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Body = {
  ip?: string
  serial?: string
  accessCode?: string
  mode?: "lan" | "cloud"
  amsUnits?: number
  slotsPerAms?: number
  action?: "status"
  // Cloud mode only:
  region?: "global" | "china"
  token?: string
  uid?: string
}

type Tray = {
  amsIndex: number
  trayIndex: number
  globalIndex: number
  present: boolean
  material?: string
  color?: string
  colorName?: string
  brand?: string
  remainPct?: number
  capacityG?: number
  rfid?: string
}

/** Convert Bambu's 8-char RGBA hex (e.g. "FF6A13FF") to "#RRGGBB". */
function rgbaToHex(s: unknown): string | undefined {
  if (typeof s !== "string" || s.length < 6) return undefined
  return `#${s.slice(0, 6).toUpperCase()}`
}

/** Parse the printer's `print.ams` block into a flat tray list + active tray. */
function parseReport(report: any, amsUnits: number, slotsPerAms: number) {
  const print = report?.print ?? {}
  const amsRoot = print.ams ?? {}
  const units: any[] = Array.isArray(amsRoot.ams) ? amsRoot.ams : []
  const trays: Tray[] = []
  for (let u = 0; u < units.length; u++) {
    const unit = units[u]
    // Bambu reports each AMS unit's physical number in `id` (0-based). Prefer it
    // over the array position so slots map to the correct unit even when only a
    // subset of units is connected (e.g. AMS 3 alone → global slots 8–11, not
    // 0–3). Fall back to the array index if `id` is absent.
    const amsIndex = Number.isFinite(Number.parseInt(String(unit?.id), 10)) ? Number.parseInt(String(unit.id), 10) : u
    const trayList: any[] = Array.isArray(unit?.tray) ? unit.tray : []
    for (const t of trayList) {
      const trayIndex = Number.parseInt(String(t?.id ?? "0"), 10) || 0
      const present = !!t?.tray_type
      trays.push({
        amsIndex,
        trayIndex,
        globalIndex: amsIndex * slotsPerAms + trayIndex,
        present,
        material: typeof t?.tray_type === "string" && t.tray_type ? t.tray_type : undefined,
        color: rgbaToHex(t?.tray_color),
        brand: typeof t?.tray_sub_brands === "string" && t.tray_sub_brands ? t.tray_sub_brands : "Bambu",
        remainPct: typeof t?.remain === "number" ? t.remain : undefined,
        capacityG: t?.tray_weight ? Number.parseInt(String(t.tray_weight), 10) || undefined : undefined,
        rfid: typeof t?.tray_uuid === "string" && /[1-9a-f]/i.test(t.tray_uuid) ? t.tray_uuid : undefined,
      })
    }
  }
  const trayNowRaw = amsRoot.tray_now
  const trayNow = Number.parseInt(String(trayNowRaw ?? "255"), 10)
  const activeTray = Number.isFinite(trayNow) && trayNow < 250 ? trayNow : null
  const printState = typeof print.gcode_state === "string" ? print.gcode_state : undefined
  return { trays, activeTray, printState }
}

const SIM_COLORS = [
  { hex: "#1C1C1E", name: "Black", material: "PLA" },
  { hex: "#E02424", name: "Red", material: "PLA" },
  { hex: "#2563EB", name: "Blue", material: "PETG" },
  { hex: "#22C55E", name: "Green", material: "PLA" },
]

/**
 * Deterministic simulation used when a real printer can't be reached (preview).
 * The active tray's remaining % slowly ticks down over real time so live weight
 * tracking has something to subtract; RFID uids are stable per (serial, slot) so
 * ingesting them is idempotent across polls.
 */
function simulate(serial: string, amsUnits: number, slotsPerAms: number): { trays: Tray[]; activeTray: number; printState: string } {
  const trays: Tray[] = []
  const units = Math.max(1, amsUnits)
  const per = Math.max(1, Math.min(4, slotsPerAms))
  // A slow, monotonic decay so the active tray visibly consumes over minutes.
  const minutes = Date.now() / 60000
  for (let u = 0; u < units; u++) {
    for (let s = 0; s < per; s++) {
      const globalIndex = u * slotsPerAms + s
      const preset = SIM_COLORS[globalIndex % SIM_COLORS.length]
      const isActive = globalIndex === 0
      const base = 100 - ((globalIndex * 17) % 40)
      const remainPct = isActive ? Math.max(2, Math.round(base - (minutes % 90))) : base
      trays.push({
        amsIndex: u,
        trayIndex: s,
        globalIndex,
        present: true,
        material: preset.material,
        color: preset.hex,
        colorName: preset.name,
        brand: "Bambu",
        remainPct,
        capacityG: 1000,
        // Stable synthetic RFID per slot so re-reads upsert instead of duplicate.
        rfid: `SIM-${serial || "BBL"}-${globalIndex}`,
      })
    }
  }
  return { trays, activeTray: 0, printState: "RUNNING" }
}

/** How to reach the printer's MQTT: directly on the LAN, or via Bambu cloud. */
type MqttTarget =
  | { transport: "lan"; ip: string; accessCode: string }
  | { transport: "cloud"; region: "global" | "china"; uid: string; token: string }

/** Cloud MQTT broker host per account region. */
function cloudBroker(region: "global" | "china"): string {
  return region === "china" ? "cn.mqtt.bambulab.com" : "us.mqtt.bambulab.com"
}

/** Read one full report over MQTT, or reject on timeout. */
async function readOverMqtt(
  target: MqttTarget,
  serial: string,
  amsUnits: number,
  slotsPerAms: number,
  ms: number,
) {
  // Import mqtt lazily so a bundling/load problem with this Node-only package
  // can't crash the whole route module at import time (which would make EVERY
  // request fail with "Could not reach the app server"). If it can't load, this
  // throws and the caller falls back to the simulation.
  const mqtt = (await import("mqtt")).default
  return new Promise<{ trays: Tray[]; activeTray: number | null; printState?: string }>((resolve, reject) => {
    // LAN: connect straight to the printer with `bblp` + access code.
    // Cloud: connect to the regional broker with `u_<uid>` + account token.
    const url =
      target.transport === "lan"
        ? `mqtts://${target.ip.replace(/^mqtts?:\/\//, "").replace(/\/+$/, "")}:8883`
        : `mqtts://${cloudBroker(target.region)}:8883`
    const client = mqtt.connect(url, {
      username: target.transport === "lan" ? "bblp" : `u_${target.uid}`,
      password: target.transport === "lan" ? target.accessCode : target.token,
      // The LAN printer presents a self-signed cert; the cloud broker's cert is
      // valid but we keep verification relaxed for resilience across regions.
      rejectUnauthorized: false,
      reconnectPeriod: 0,
      connectTimeout: ms,
      protocolVersion: 4,
    })
    const reportTopic = `device/${serial}/report`
    const requestTopic = `device/${serial}/request`
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      try {
        client.end(true)
      } catch {}
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error("timeout"))), ms)

    client.on("connect", () => {
      client.subscribe(reportTopic, () => {
        client.publish(requestTopic, JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }))
      })
    })
    client.on("message", (_topic, payload) => {
      try {
        const report = JSON.parse(payload.toString())
        if (report?.print?.ams) {
          clearTimeout(timer)
          const parsed = parseReport(report, amsUnits, slotsPerAms)
          done(() => resolve(parsed))
        }
      } catch {
        // Ignore partial/non-JSON frames; wait for the next one until timeout.
      }
    })
    client.on("error", (err) => {
      clearTimeout(timer)
      done(() => reject(err))
    })
  })
}

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const serial = body.serial?.trim() ?? ""
  const amsUnits = Math.max(1, body.amsUnits ?? 1)
  const slotsPerAms = Math.max(1, body.slotsPerAms ?? 4)
  const mode = body.mode === "cloud" ? "cloud" : "lan"

  // Build the MQTT target for whichever mode we're in, validating just the
  // fields that mode needs. A `null` target means we lack the info to try a
  // real connection and should serve the simulation instead.
  let target: MqttTarget | null = null
  if (mode === "cloud") {
    const token = body.token?.trim() ?? ""
    const uid = body.uid?.trim() ?? ""
    const region = body.region === "china" ? "china" : "global"
    if (!serial) return NextResponse.json({ ok: false, error: "Missing serial" }, { status: 400 })
    if (token && uid) target = { transport: "cloud", region, uid, token }
  } else {
    const accessCode = body.accessCode?.trim() ?? ""
    const ip = body.ip?.trim() ?? ""
    if (!serial || !accessCode) {
      return NextResponse.json({ ok: false, error: "Missing serial or access code" }, { status: 400 })
    }
    if (ip) target = { transport: "lan", ip, accessCode }
  }

  if (target) {
    try {
      // Cloud round-trips (auth + broker hop) need a bit longer than LAN.
      const timeout = target.transport === "cloud" ? 9000 : 5000
      const parsed = await readOverMqtt(target, serial, amsUnits, slotsPerAms, timeout)
      return NextResponse.json({ ok: true, connected: true, simulated: false, ...parsed })
    } catch {
      // Fall through to the simulation so the UI still has data in preview.
    }
  }

  const sim = simulate(serial, amsUnits, slotsPerAms)
  return NextResponse.json({ ok: true, connected: true, simulated: true, ...sim })
}
