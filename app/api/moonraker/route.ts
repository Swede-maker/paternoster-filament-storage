import { type NextRequest, NextResponse } from "next/server"
import { probeMoonraker } from "@/lib/server/printer-status"

/**
 * Server-side proxy to a printer's Moonraker HTTP API (Klipper / Mainsail).
 *
 * The actual read logic lives in `lib/server/printer-status.ts` so the exact
 * same code powers both this browser-facing route and the Pi's background
 * consumption poller (which tracks filament with no browser open). This route
 * is a thin HTTP wrapper.
 *
 * Must run somewhere that can reach the printer's LAN IP (self-hosted on the
 * same network). On a cloud deployment a private 192.168.x.x address is
 * unreachable and requests will time out.
 */

// Always run this on the server at request time (never cached/prerendered).
export const dynamic = "force-dynamic"

type Body = {
  ip?: string
  port?: number
  apiKey?: string
  action?: "status"
  heaters?: string[]
}

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { status, body: result } = await probeMoonraker({
    ip: body.ip,
    port: body.port,
    apiKey: body.apiKey,
    heaters: body.heaters,
  })
  return NextResponse.json(result, { status })
}
