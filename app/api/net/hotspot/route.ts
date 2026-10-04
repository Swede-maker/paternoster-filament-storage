import type { NextRequest } from "next/server"
import { sendCommand } from "@/lib/server/pi-relay"
import { validatePsk } from "@/lib/net"
import { parseTarget } from "../_target"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/net/hotspot  { host, port, psk }
 *
 * Change the master's hotspot password. The Pi pushes the new key to every
 * registered slave first, then rewrites its own `pax-ap` profile (bouncing the
 * hotspot if it is live). Outcome arrives on the SSE stream as
 * `net.result { op: "set-ap-psk", acked, failed }`.
 */
export async function POST(req: NextRequest) {
  let body: { host?: unknown; port?: unknown; psk?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 })
  }
  const target = parseTarget(body)
  if (target instanceof Response) return target

  if (typeof body.psk !== "string" || body.psk === "") {
    return Response.json({ ok: false, error: "A hotspot password is required" }, { status: 400 })
  }
  const pskError = validatePsk(body.psk)
  if (pskError) return Response.json({ ok: false, error: pskError }, { status: 400 })

  const delivered = sendCommand(target.host, target.port, { type: "net.set-ap-psk", psk: body.psk })
  if (!delivered) return Response.json({ ok: false, error: "Pi not connected" }, { status: 503 })
  return Response.json({ ok: true, accepted: true }, { status: 202 })
}
