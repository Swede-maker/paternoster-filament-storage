import type { NextRequest } from "next/server"
import { cachedNet, sendAndAwait } from "@/lib/server/pi-relay"
import type { NetStatusEvent } from "@/lib/node-protocol"
import { parseTarget, relayError } from "../_target"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/net/status?host=&port=&fresh=1
 *
 * Returns the Pi's network snapshot. By default answers from the relay's cache
 * (instant; also works while the Pi is mid-switch and unreachable). `fresh=1`
 * asks the Pi for a new one and waits up to 6 s.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const target = parseTarget({ host: sp.get("host"), port: sp.get("port") ?? undefined })
  if (target instanceof Response) return target

  const cached = cachedNet(target.host, target.port)
  if (sp.get("fresh") !== "1" && cached.status) {
    return Response.json({
      ok: true,
      cached: true,
      status: JSON.parse(cached.status),
      slaves: cached.slaves ? JSON.parse(cached.slaves).slaves : undefined,
    })
  }

  try {
    const status = await sendAndAwait<NetStatusEvent>(target.host, target.port, { type: "net.status" }, ["net.status"], 6000)
    const after = cachedNet(target.host, target.port)
    return Response.json({
      ok: true,
      cached: false,
      status,
      slaves: after.slaves ? JSON.parse(after.slaves).slaves : undefined,
    })
  } catch (err) {
    if (cached.status) {
      // Better a stale picture than none.
      return Response.json({ ok: true, cached: true, stale: true, status: JSON.parse(cached.status) })
    }
    return relayError(err)
  }
}
