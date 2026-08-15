import { type NextRequest, NextResponse } from "next/server"
import { createHash, randomBytes } from "crypto"

/**
 * Server-side proxy to a printer's PrusaLink HTTP API (Prusa MINI, MK3.9, MK4,
 * XL, and the standalone PrusaLink Pi image).
 *
 * Why a proxy instead of calling PrusaLink straight from the browser:
 *  - Mixed content: the app is HTTPS but a LAN printer speaks plain HTTP, so
 *    the browser blocks the request. A server-side fetch is not subject to that.
 *  - CORS: PrusaLink sends no CORS headers; our own server has no CORS.
 *  - Auth: current PrusaLink firmware uses HTTP Digest (username "maker" +
 *    password), which fetch() can't negotiate on the client. We do the digest
 *    handshake here, and also accept a legacy X-Api-Key for older firmware.
 *
 * This route must run somewhere that can actually reach the printer's LAN IP
 * (i.e. self-hosted on the same network). On a cloud deployment a private
 * 192.168.x.x address is unreachable and requests will time out.
 */

// Always run on the server at request time (never cached/prerendered).
export const dynamic = "force-dynamic"

// PrusaLink's fixed digest username.
const DIGEST_USER = "maker"

type Body = {
  ip?: string
  port?: number
  apiKey?: string
  action?: "status"
  /** How many tools to read (toolchangers expose tool0…toolN). */
  tools?: number
}

/** Build the PrusaLink base URL. Default port is 80 (plain HTTP on the LAN). */
function baseUrl(ip: string, port?: number): string {
  const host = ip.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")
  if (/:\d+$/.test(host)) return `http://${host}`
  return `http://${host}${port && port > 0 && port !== 80 ? `:${port}` : ""}`
}

function md5(s: string): string {
  return createHash("md5").update(s).digest("hex")
}

/** Parse the key=value pairs out of a `WWW-Authenticate: Digest …` header. */
function parseDigestChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  // Match key="quoted value" or key=bareValue.
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(header)) !== null) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").trim()
  }
  return out
}

/** Build an `Authorization: Digest …` header for the given challenge. */
function buildDigestAuth(method: string, uri: string, challenge: Record<string, string>, user: string, pass: string): string {
  const realm = challenge.realm ?? "Printer API"
  const nonce = challenge.nonce ?? ""
  const opaque = challenge.opaque
  // The server may offer a comma-separated qop list; we implement "auth".
  const qop = (challenge.qop ?? "").split(",").map((s) => s.trim()).includes("auth") ? "auth" : ""
  const ha1 = md5(`${user}:${realm}:${pass}`)
  const ha2 = md5(`${method}:${uri}`)
  const nc = "00000001"
  const cnonce = randomBytes(8).toString("hex")
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`)

  const parts = [
    `username="${user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ]
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`)
  }
  if (opaque) parts.push(`opaque="${opaque}"`)
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`)
  return `Digest ${parts.join(", ")}`
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

/**
 * GET a PrusaLink path, handling auth. First tries X-Api-Key (legacy). If the
 * printer answers 401 with a Digest challenge, retries once with a computed
 * digest response using username "maker" + the supplied secret as password.
 * Returns the parsed JSON, or null when the request fails/!ok.
 */
async function apiGet(base: string, path: string, secret: string, ms: number): Promise<any | null> {
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
        res = await fetchWithTimeout(url, { method: "GET", headers: { Accept: "application/json", Authorization: auth } }, ms)
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

/** Klipper-style heater name for a tool index, so temps key identically. */
function heaterName(i: number): string {
  return i === 0 ? "extruder" : `extruder${i}`
}

/** Normalize PrusaLink/OctoPrint state strings to the Klipper vocabulary. */
function normalizeState(raw: string | undefined): string {
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

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { ip, port } = body
  if (!ip || !ip.trim()) {
    return NextResponse.json({ ok: false, error: "Missing printer IP" }, { status: 400 })
  }
  const secret = (body.apiKey ?? "").trim()
  const tools = Math.max(1, body.tools ?? 1)
  const base = baseUrl(ip, port)
  const TIMEOUT = 8000

  const temps: Record<string, { actual: number; target: number }> = {}
  let printState = "unknown"
  let gotTemps = false

  // 1) Temps + state. Prefer the OctoPrint-compatible /api/printer because it
  //    exposes every tool (tool0…toolN) for multi-tool machines like the XL.
  const printer = await apiGet(base, "/api/printer", secret, TIMEOUT)
  if (printer && typeof printer === "object") {
    const t = printer.temperature ?? {}
    for (let i = 0; i < tools; i++) {
      const tool = t[`tool${i}`]
      if (tool) temps[heaterName(i)] = { actual: Number(tool.actual) || 0, target: Number(tool.target) || 0 }
    }
    if (Object.keys(temps).length > 0) gotTemps = true
    printState = normalizeState(printer.state?.text)
  }

  // 1b) Fallback for newer firmware where /api/printer is unavailable: the v1
  //     status endpoint gives a single nozzle temp + state.
  if (!gotTemps) {
    const status = await apiGet(base, "/api/v1/status", secret, TIMEOUT)
    const p = status?.printer
    if (p && typeof p === "object") {
      temps[heaterName(0)] = { actual: Number(p.temp_nozzle) || 0, target: Number(p.target_nozzle) || 0 }
      gotTemps = true
      if (printState === "unknown") printState = normalizeState(p.state)
    }
  }

  // If neither endpoint answered, the printer is unreachable or the password is
  // wrong. Report a clear, honest error instead of a fake "connected".
  if (!gotTemps) {
    return NextResponse.json(
      { ok: false, error: "Could not reach PrusaLink (check the IP, password, and that PrusaLink is enabled)" },
      { status: 502 },
    )
  }

  // 2) Filament + progress (best-effort). The OctoPrint-compatible /api/job
  //    gives both the job's total filament length and completion, from which we
  //    derive a monotonic "filament used" value the weight tracker can consume.
  let filamentUsedMm: number | undefined
  const job = await apiGet(base, "/api/job", secret, TIMEOUT)
  if (job && typeof job === "object") {
    const completionRaw = Number(job.progress?.completion)
    if (Number.isFinite(completionRaw)) {
      // OctoPrint reports 0–100; some builds report 0–1. Normalize to a fraction.
      const frac = completionRaw > 1 ? completionRaw / 100 : completionRaw
      // Filament may be { tool0: { length } , … } or a flat { length }.
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
    if (printState === "unknown") printState = normalizeState(typeof job.state === "string" ? job.state : undefined)
  }

  // Active tool is not exposed by these endpoints; default to 0.
  return NextResponse.json({ ok: true, connected: true, temps, printState, filamentUsedMm, activeTool: 0 })
}
