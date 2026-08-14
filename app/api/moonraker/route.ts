import { type NextRequest, NextResponse } from "next/server"

/**
 * Server-side proxy to a printer's Moonraker HTTP API (Klipper / Mainsail).
 *
 * Why a proxy instead of calling Moonraker straight from the browser:
 *  - Mixed content: the app is served over HTTPS but a LAN printer speaks plain
 *    HTTP, so the browser blocks the request. A server-side fetch is not subject
 *    to that rule.
 *  - CORS: Moonraker only allows configured origins; our own server has no CORS.
 *
 * This route must run somewhere that can actually reach the printer's LAN IP
 * (i.e. self-hosted on the same network). On a cloud deployment a private
 * 192.168.x.x address is unreachable and requests will time out.
 */

// Always run this on the server at request time (never cached/prerendered).
export const dynamic = "force-dynamic"

type Body = {
  ip?: string
  port?: number
  apiKey?: string
  action?: "status"
  /** Heater object names to read, e.g. ["extruder","extruder1"]. */
  heaters?: string[]
}

/** Build the Moonraker base URL from an IP/host and optional port. */
function baseUrl(ip: string, port?: number): string {
  const host = ip.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")
  // If the user already included a port in the host, respect it.
  if (/:\d+$/.test(host)) return `http://${host}`
  return `http://${host}:${port && port > 0 ? port : 7125}`
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

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { ip, port, apiKey } = body
  if (!ip || !ip.trim()) {
    return NextResponse.json({ ok: false, error: "Missing printer IP" }, { status: 400 })
  }

  const base = baseUrl(ip, port)
  const headers: Record<string, string> = {}
  if (apiKey && apiKey.trim()) headers["X-Api-Key"] = apiKey.trim()

  try {
    // Status + live temperatures (read-only). This route never sends commands.
    const heaters = Array.isArray(body.heaters) && body.heaters.length ? body.heaters : ["extruder"]
    // e.g. extruder=temperature,target&extruder1=temperature,target
    // Also read print_stats (filament_used mm + state) for live weight tracking
    // and gcode_move/toolhead to know which extruder is currently active.
    const heaterQuery = heaters.map((h) => `${encodeURIComponent(h)}=temperature,target`).join("&")
    const query = `${heaterQuery}&print_stats&gcode_move&toolhead`
    const url = `${base}/printer/objects/query?${query}`
    const res = await fetchWithTimeout(url, { method: "GET", headers }, 5000)
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `Moonraker responded ${res.status}` }, { status: 502 })
    }
    const json = (await res.json()) as {
      result?: {
        status?: Record<string, any>
      }
    }
    const status = json.result?.status ?? {}
    const temps: Record<string, { actual: number; target: number }> = {}
    for (const h of heaters) {
      const s = status[h]
      if (s) temps[h] = { actual: s.temperature ?? 0, target: s.target ?? 0 }
    }

    const printStats = status["print_stats"] ?? {}
    const printState: string = typeof printStats.state === "string" ? printStats.state : "unknown"
    const filamentUsedMm: number = typeof printStats.filament_used === "number" ? printStats.filament_used : 0

    // Which extruder is active. Klipper exposes the active extruder name on
    // `toolhead.extruder` (e.g. "extruder", "extruder1"). Derive its index.
    const toolhead = status["toolhead"] ?? {}
    const activeName: string = typeof toolhead.extruder === "string" ? toolhead.extruder : "extruder"
    const activeTool = activeName === "extruder" ? 0 : Number.parseInt(activeName.replace("extruder", ""), 10) || 0

    return NextResponse.json({ ok: true, connected: true, temps, printState, filamentUsedMm, activeTool })
  } catch (err) {
    const message = err instanceof Error && err.name === "AbortError" ? "Printer did not respond (timeout)" : "Could not reach printer"
    return NextResponse.json({ ok: false, error: message }, { status: 504 })
  }
}
