import { type NextRequest, NextResponse } from "next/server"
import { probePrusaLink } from "@/lib/server/printer-status"

/**
 * Server-side proxy to a printer's PrusaLink HTTP API (Prusa MINI, MK3.9, MK4,
 * XL, and the standalone PrusaLink Pi image).
 *
 * The actual read logic (including HTTP Digest auth) lives in
 * `lib/server/printer-status.ts` so the same code powers both this browser-facing
 * route and the Pi's background consumption poller. This route is a thin HTTP
 * wrapper.
 *
 * Must run somewhere that can reach the printer's LAN IP (self-hosted on the
 * same network). On a cloud deployment a private 192.168.x.x address is
 * unreachable and requests will time out.
 */

// Always run on the server at request time (never cached/prerendered).
export const dynamic = "force-dynamic"

type Body = {
  ip?: string
  port?: number
  apiKey?: string
  action?: "status"
  tools?: number
}

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { status, body: result } = await probePrusaLink({
    ip: body.ip,
    port: body.port,
    apiKey: body.apiKey,
    tools: body.tools,
  })
  return NextResponse.json(result, { status })
}
