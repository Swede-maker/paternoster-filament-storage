import "server-only"
import { createHash, randomBytes } from "node:crypto"

/**
 * Server-side printer status readers.
 *
 * This is the single source of truth for *reading* live state from a printer.
 * Both the API routes (browser-driven polling for display) and the server-side
 * consumption poller (the Pi tracking filament even with no browser open) call
 * these functions, so behavior can never drift between the two paths.
 *
 * Everything here must be able to reach the printer's LAN IP, so it only does
 * real work when the app is self-hosted on the printer's network (e.g. the Pi).
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A probe returns the JSON body the client expects plus the HTTP status the
 *  route should send. The poller ignores `status` and reads `body` directly. */
export interface Probe<T> {
  status: number
  body: T
}

/** fetch() with a hard timeout so an unreachable printer fails fast. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" })
  } finally {
    clearTimeout(t)
  }
}

// ---------------------------------------------------------------------------
// Moonraker (Klipper / Mainsail)
// ---------------------------------------------------------------------------

export interface MoonrakerProbeInput {
  ip?: string
  port?: number
  apiKey?: string
  heaters?: string[]
}

export interface MoonrakerBody {
  ok: boolean
  connected?: boolean
  temps?: Record<string, { actual: number; target: number }>
  printState?: string
  filamentUsedMm?: number
  activeTool?: number
  error?: string
}

/** Build the Moonraker base URL from an IP/host and optional port. */
function moonrakerBase(ip: string, port?: number): string {
  const host = ip.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")
  if (/:\d+$/.test(host)) return `http://${host}`
  return `http://${host}:${port && port > 0 ? port : 7125}`
}

export async function probeMoonraker(input: MoonrakerProbeInput): Promise<Probe<MoonrakerBody>> {
  const { ip, port, apiKey } = input
  if (!ip || !ip.trim()) {
    return { status: 400, body: { ok: false, error: "Missing printer IP" } }
  }

  const base = moonrakerBase(ip, port)
  const headers: Record<string, string> = {}
  if (apiKey && apiKey.trim()) headers["X-Api-Key"] = apiKey.trim()

  try {
    const heaters = Array.isArray(input.heaters) && input.heaters.length ? input.heaters : ["extruder"]
    const heaterQuery = heaters.map((h) => `${encodeURIComponent(h)}=temperature,target`).join("&")
    const query = `${heaterQuery}&print_stats&gcode_move&toolhead`
    const url = `${base}/printer/objects/query?${query}`
    // 8s: a busy Klipper host (mid-print, homing, mesh) can be briefly slow.
    const res = await fetchWithTimeout(url, { method: "GET", headers }, 8000)
    if (!res.ok) {
      return { status: 502, body: { ok: false, error: `Moonraker responded ${res.status}` } }
    }
    const json = (await res.json()) as { result?: { status?: Record<string, any> } }
    const status = json.result?.status ?? {}
    const temps: Record<string, { actual: number; target: number }> = {}
    for (const h of heaters) {
      const s = status[h]
      if (s) temps[h] = { actual: s.temperature ?? 0, target: s.target ?? 0 }
    }

    const printStats = status["print_stats"] ?? {}
    const printState: string = typeof printStats.state === "string" ? printStats.state : "unknown"
    const filamentUsedMm: number = typeof printStats.filament_used === "number" ? printStats.filament_used : 0

    const toolhead = status["toolhead"] ?? {}
    const activeName: string = typeof toolhead.extruder === "string" ? toolhead.extruder : "extruder"
    const activeTool = activeName === "extruder" ? 0 : Number.parseInt(activeName.replace("extruder", ""), 10) || 0

    return { status: 200, body: { ok: true, connected: true, temps, printState, filamentUsedMm, activeTool } }
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError" ? "Printer did not respond (timeout)" : "Could not reach printer"
    return { status: 504, body: { ok: false, error: message } }
  }
}

// ---------------------------------------------------------------------------
// PrusaLink (Prusa MINI / MK3.9 / MK4 / XL)
// ---------------------------------------------------------------------------

const DIGEST_USER = "maker"

export interface PrusaLinkProbeInput {
  ip?: string
  port?: number
  apiKey?: string
  tools?: number
}

function prusaBase(ip: string, port?: number): string {
  const host = ip.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")
  if (/:\d+$/.test(host)) return `http://${host}`
  return `http://${host}${port && port > 0 && port !== 80 ? `:${port}` : ""}`
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex")
}

function parseDigestChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(header)) !== null) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").trim()
  }
  return out
}

function buildDigestAuth(
  method: string,
  uri: string,
  challenge: Record<string, string>,
  user: string,
  pass: string,
): string {
  const realm = challenge.realm ?? "Printer API"
  const nonce = challenge.nonce ?? ""
  const opaque = challenge.opaque
  const qop = (challenge.qop ?? "").split(",").map((s) => s.trim()).includes("auth") ? "auth" : ""
  const ha1 = md5(`${user}:${realm}:${pass}`)
  const ha2 = md5(`${method}:${uri}`)
  const nc = "00000001"
  const cnonce = randomBytes(8).toString("hex")
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`)

  const parts = [
    `username="${user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ]
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  if (opaque) parts.push(`opaque="${opaque}"`)
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`)
  return `Digest ${parts.join(", ")}`
}

async function prusaApiGet(base: string, path: string, secret: string, ms: number): Promise<any | null> {
  const url = `${base}${path}`
  const headers: Record<string, string> = { Accept: "application/json" }
  if (secret) headers["X-Api-Key"] = secret

  let res: Response
  try {
    res = await fetchWithTimeout(url, { method: "GET", headers }, ms)
  } catch {
    return null
  }

  if (res.status === 401 && secret) {
    const www = res.headers.get("www-authenticate") ?? ""
    if (/digest/i.test(www)) {
      const challenge = parseDigestChallenge(www)
      const auth = buildDigestAuth("GET", path, challenge, DIGEST_USER, secret)
      try {
        res = await fetchWithTimeout(
          url,
          { method: "GET", headers: { Accept: "application/json", Authorization: auth } },
          ms,
        )
      } catch {
        return null
      }
    }
  }

  if (!res.ok) return null
  try {
    return await res.json()
  } catch {
    return null
  }
}

function prusaHeaterName(i: number): string {
  return i === 0 ? "extruder" : `extruder${i}`
}

function normalizePrusaState(raw: string | undefined): string {
  const s = (raw ?? "").toLowerCase()
  if (!s) return "unknown"
  if (s.includes("print")) return "printing"
  if (s.includes("pause")) return "paused"
  if (s.includes("finish") || s.includes("complete")) return "complete"
  if (s.includes("cancel") || s.includes("abort")) return "cancelled"
  if (s.includes("error") || s.includes("attention")) return "error"
  if (s.includes("operational") || s.includes("idle") || s.includes("ready") || s.includes("stopped")) return "standby"
  return s
}

export async function probePrusaLink(input: PrusaLinkProbeInput): Promise<Probe<MoonrakerBody>> {
  const { ip, port } = input
  if (!ip || !ip.trim()) {
    return { status: 400, body: { ok: false, error: "Missing printer IP" } }
  }
  const secret = (input.apiKey ?? "").trim()
  const tools = Math.max(1, input.tools ?? 1)
  const base = prusaBase(ip, port)
  const TIMEOUT = 8000

  const temps: Record<string, { actual: number; target: number }> = {}
  let printState = "unknown"
  let gotTemps = false

  const printer = await prusaApiGet(base, "/api/printer", secret, TIMEOUT)
  if (printer && typeof printer === "object") {
    const t = printer.temperature ?? {}
    for (let i = 0; i < tools; i++) {
      const tool = t[`tool${i}`]
      if (tool) temps[prusaHeaterName(i)] = { actual: Number(tool.actual) || 0, target: Number(tool.target) || 0 }
    }
    if (Object.keys(temps).length > 0) gotTemps = true
    printState = normalizePrusaState(printer.state?.text)
  }

  if (!gotTemps) {
    const status = await prusaApiGet(base, "/api/v1/status", secret, TIMEOUT)
    const p = status?.printer
    if (p && typeof p === "object") {
      temps[prusaHeaterName(0)] = { actual: Number(p.temp_nozzle) || 0, target: Number(p.target_nozzle) || 0 }
      gotTemps = true
      if (printState === "unknown") printState = normalizePrusaState(p.state)
    }
  }

  if (!gotTemps) {
    return {
      status: 502,
      body: {
        ok: false,
        error: "Could not reach PrusaLink (check the IP, password, and that PrusaLink is enabled)",
      },
    }
  }

  let filamentUsedMm: number | undefined
  const job = await prusaApiGet(base, "/api/job", secret, TIMEOUT)
  if (job && typeof job === "object") {
    const completionRaw = Number(job.progress?.completion)
    if (Number.isFinite(completionRaw)) {
      const frac = completionRaw > 1 ? completionRaw / 100 : completionRaw
      const filament = job.job?.filament
      let totalLen = 0
      if (filament && typeof filament === "object") {
        if (typeof filament.length === "number") {
          totalLen = filament.length
        } else {
          for (const v of Object.values<any>(filament)) {
            if (v && typeof v.length === "number") totalLen += v.length
          }
        }
      }
      if (totalLen > 0) filamentUsedMm = totalLen * Math.min(1, Math.max(0, frac))
    }
    if (printState === "unknown") printState = normalizePrusaState(typeof job.state === "string" ? job.state : undefined)
  }

  return { status: 200, body: { ok: true, connected: true, temps, printState, filamentUsedMm, activeTool: 0 } }
}

// ---------------------------------------------------------------------------
// Bambu Lab (MQTT: LAN or cloud)
// ---------------------------------------------------------------------------

export interface BambuTray {
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

export interface BambuBody {
  ok: boolean
  connected?: boolean
  simulated?: boolean
  trays?: BambuTray[]
  activeTray?: number | null
  printState?: string
  error?: string
}

export interface BambuProbeInput {
  ip?: string
  serial?: string
  accessCode?: string
  mode?: "lan" | "cloud"
  amsUnits?: number
  slotsPerAms?: number
  region?: "global" | "china"
  token?: string
  uid?: string
}

function rgbaToHex(s: unknown): string | undefined {
  if (typeof s !== "string" || s.length < 6) return undefined
  return `#${s.slice(0, 6).toUpperCase()}`
}

function parseReport(report: any, slotsPerAms: number) {
  const print = report?.print ?? {}
  const amsRoot = print.ams ?? {}
  const units: any[] = Array.isArray(amsRoot.ams) ? amsRoot.ams : []
  const trays: BambuTray[] = []
  for (let u = 0; u < units.length; u++) {
    const unit = units[u]
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

function simulate(serial: string, amsUnits: number, slotsPerAms: number) {
  const trays: BambuTray[] = []
  const units = Math.max(1, amsUnits)
  const per = Math.max(1, Math.min(4, slotsPerAms))
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
        rfid: `SIM-${serial || "BBL"}-${globalIndex}`,
      })
    }
  }
  return { trays, activeTray: 0, printState: "RUNNING" }
}

type MqttTarget =
  | { transport: "lan"; ip: string; accessCode: string }
  | { transport: "cloud"; region: "global" | "china"; uid: string; token: string }

function cloudBroker(region: "global" | "china"): string {
  return region === "china" ? "cn.mqtt.bambulab.com" : "us.mqtt.bambulab.com"
}

async function readOverMqtt(target: MqttTarget, serial: string, slotsPerAms: number, ms: number) {
  const mqtt = (await import("mqtt")).default
  return new Promise<{ trays: BambuTray[]; activeTray: number | null; printState?: string }>((resolve, reject) => {
    const url =
      target.transport === "lan"
        ? `mqtts://${target.ip.replace(/^mqtts?:\/\//, "").replace(/\/+$/, "")}:8883`
        : `mqtts://${cloudBroker(target.region)}:8883`
    const client = mqtt.connect(url, {
      username: target.transport === "lan" ? "bblp" : `u_${target.uid}`,
      password: target.transport === "lan" ? target.accessCode : target.token,
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
          const parsed = parseReport(report, slotsPerAms)
          done(() => resolve(parsed))
        }
      } catch {
        // Ignore partial/non-JSON frames; wait for the next until timeout.
      }
    })
    client.on("error", (err) => {
      clearTimeout(timer)
      done(() => reject(err))
    })
  })
}

export async function probeBambu(input: BambuProbeInput): Promise<Probe<BambuBody>> {
  const serial = input.serial?.trim() ?? ""
  const amsUnits = Math.max(1, input.amsUnits ?? 1)
  const slotsPerAms = Math.max(1, input.slotsPerAms ?? 4)
  const mode = input.mode === "cloud" ? "cloud" : "lan"

  let target: MqttTarget | null = null
  if (mode === "cloud") {
    const token = input.token?.trim() ?? ""
    const uid = input.uid?.trim() ?? ""
    const region = input.region === "china" ? "china" : "global"
    if (!serial) return { status: 400, body: { ok: false, error: "Missing serial" } }
    if (token && uid) target = { transport: "cloud", region, uid, token }
  } else {
    const accessCode = input.accessCode?.trim() ?? ""
    const ip = input.ip?.trim() ?? ""
    if (!serial || !accessCode) {
      return { status: 400, body: { ok: false, error: "Missing serial or access code" } }
    }
    if (ip) target = { transport: "lan", ip, accessCode }
  }

  if (target) {
    try {
      const timeout = target.transport === "cloud" ? 9000 : 5000
      const parsed = await readOverMqtt(target, serial, slotsPerAms, timeout)
      return { status: 200, body: { ok: true, connected: true, simulated: false, ...parsed } }
    } catch {
      // Fall through to the simulation so the UI still has data in preview.
    }
  }

  const sim = simulate(serial, amsUnits, slotsPerAms)
  return { status: 200, body: { ok: true, connected: true, simulated: true, ...sim } }
}
