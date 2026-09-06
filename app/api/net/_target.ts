import "server-only"
import { isAllowedTarget } from "@/lib/server/pi-relay"

/**
 * Every /api/net route addresses a Pi the same way /api/pi/command does:
 * `{ host, port }` (host may be a LAN IP or a `.local` name). Shared parsing so
 * the SSRF guard and error shapes stay identical across routes.
 */
export function parseTarget(src: { host?: unknown; ip?: unknown; port?: unknown }): {
  host: string
  port: number
} | Response {
  const raw = typeof src.host === "string" ? src.host : typeof src.ip === "string" ? src.ip : ""
  const host = raw.trim()
  const port = Number(src.port ?? 8765)
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Response.json({ ok: false, error: "Bad host/port" }, { status: 400 })
  }
  if (!isAllowedTarget(host)) {
    return Response.json({ ok: false, error: "Target not allowed" }, { status: 403 })
  }
  return { host, port }
}

export function relayError(err: unknown): Response {
  const msg = err instanceof Error ? err.message : "Relay error"
  const status = msg === "Pi not connected" ? 503 : msg.startsWith("Timed out") ? 504 : 500
  return Response.json({ ok: false, error: msg }, { status })
}
