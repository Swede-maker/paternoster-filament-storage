import type { NextRequest } from "next/server"
import { sendCommand } from "@/lib/server/pi-relay"
import { validatePsk, validateSsid } from "@/lib/net"
import { parseTarget } from "../_target"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/net/join  { host, port, ssid, psk }
 *
 * Saves the router on the Pi and connects. Fire-and-forget by design: on a
 * master this first pushes the credentials to every slave and then switches
 * networks — which drops the very socket we would await on. The outcome
 * arrives on the SSE stream as `net.result {op:"join"}` followed by a fresh
 * `net.status` once the relay has reconnected to the Pi on its new address.
 */
export async function POST(req: NextRequest) {
  let body: { host?: unknown; port?: unknown; ssid?: unknown; psk?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 })
  }
  const target = parseTarget(body)
  if (target instanceof Response) return target

  const ssidErr = validateSsid(body.ssid)
  if (ssidErr) return Response.json({ ok: false, error: ssidErr }, { status: 400 })
  const pskErr = validatePsk(body.psk)
  if (pskErr) return Response.json({ ok: false, error: pskErr }, { status: 400 })

  const delivered = sendCommand(target.host, target.port, {
    type: "net.join",
    ssid: body.ssid as string,
    psk: typeof body.psk === "string" ? body.psk : "",
  })
  if (!delivered) return Response.json({ ok: false, error: "Pi not connected" }, { status: 503 })
  return Response.json({ ok: true, accepted: true }, { status: 202 })
}
