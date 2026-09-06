import type { NextRequest } from "next/server"
import { sendAndAwait } from "@/lib/server/pi-relay"
import type { NetResultEvent, NetScanEvent } from "@/lib/node-protocol"
import { parseTarget, relayError } from "../_target"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/net/scan  { host, port }
 *
 * Triggers a Wi-Fi rescan on the Pi and returns the list. A rescan takes a few
 * seconds on a Pi Zero, hence the generous timeout.
 */
export async function POST(req: NextRequest) {
  let body: { host?: unknown; port?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 })
  }
  const target = parseTarget(body)
  if (target instanceof Response) return target

  try {
    const ev = await sendAndAwait<NetScanEvent | NetResultEvent>(
      target.host,
      target.port,
      { type: "net.scan" },
      ["net.scan", "net.result"],
      20000,
    )
    if (ev.type === "net.result") {
      // The agent answered with a failure (nmcli missing, sudo refused, ...).
      return Response.json({ ok: false, error: ev.error ?? "Scan failed" }, { status: 502 })
    }
    return Response.json({ ok: true, networks: ev.networks })
  } catch (err) {
    return relayError(err)
  }
}
