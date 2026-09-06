import type { NextRequest } from "next/server"
import { sendCommand } from "@/lib/server/pi-relay"
import { isNetPin } from "@/lib/net"
import { parseTarget } from "../_target"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/net/mode  { host, port, mode: "auto" | "router" | "ap" }
 *
 * Also carries the two maintenance ops that share the same fire-and-forget
 * shape: `{ op: "forget" }` (drop the saved router) and
 * `{ op: "provision-slaves" }` (re-push router credentials to slaves).
 * Outcomes arrive on the SSE stream as `net.result`.
 */
export async function POST(req: NextRequest) {
  let body: { host?: unknown; port?: unknown; mode?: unknown; op?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 })
  }
  const target = parseTarget(body)
  if (target instanceof Response) return target

  let delivered: boolean
  if (body.op === "forget") {
    delivered = sendCommand(target.host, target.port, { type: "net.forget" })
  } else if (body.op === "provision-slaves") {
    delivered = sendCommand(target.host, target.port, { type: "net.provision-slaves" })
  } else {
    if (!isNetPin(body.mode)) {
      return Response.json({ ok: false, error: "mode must be auto, router or ap" }, { status: 400 })
    }
    delivered = sendCommand(target.host, target.port, { type: "net.mode", mode: body.mode })
  }

  if (!delivered) return Response.json({ ok: false, error: "Pi not connected" }, { status: 503 })
  return Response.json({ ok: true, accepted: true }, { status: 202 })
}
