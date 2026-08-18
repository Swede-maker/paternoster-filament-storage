import { type NextRequest, NextResponse } from "next/server"
import { probeBambu } from "@/lib/server/printer-status"

/**
 * Server-side proxy to a Bambu Lab printer's MQTT interface.
 *
 * The actual read logic (LAN + cloud MQTT, report parsing, and the preview
 * simulation) lives in `lib/server/printer-status.ts` so the same code powers
 * both this browser-facing route and the Pi's background consumption poller.
 * This route is a thin HTTP wrapper.
 *
 * Real connections only work when the server can reach the printer's LAN IP (or
 * Bambu cloud). On a cloud/preview deployment the LAN address is unreachable, so
 * the reader falls back to a deterministic SIMULATION with the same shape.
 * Access codes/tokens are used server-side only and never logged or returned.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Body = {
  ip?: string
  serial?: string
  accessCode?: string
  mode?: "lan" | "cloud"
  amsUnits?: number
  slotsPerAms?: number
  action?: "status"
  region?: "global" | "china"
  token?: string
  uid?: string
}

export async function POST(req: NextRequest) {
  let body: Body
  try {
    body = (await req.json()) as Body
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 })
  }

  const { status, body: result } = await probeBambu({
    ip: body.ip,
    serial: body.serial,
    accessCode: body.accessCode,
    mode: body.mode,
    amsUnits: body.amsUnits,
    slotsPerAms: body.slotsPerAms,
    region: body.region,
    token: body.token,
    uid: body.uid,
  })
  return NextResponse.json(result, { status })
}
