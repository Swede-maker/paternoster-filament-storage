import type { NextRequest } from "next/server"
import { sendCommand, isAllowedTarget } from "@/lib/server/pi-relay"
import type { NodeCommand } from "@/lib/node-protocol"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Validate an untrusted body into a known NodeCommand (or null). */
function parseCommand(body: unknown): NodeCommand | null {
  if (!body || typeof body !== "object") return null
  const type = (body as { type?: unknown }).type
  switch (type) {
    case "hello":
    case "home":
    case "stop":
      return { type }
    case "goto": {
      const shelf = (body as { shelf?: unknown }).shelf
      if (typeof shelf !== "number" || !Number.isInteger(shelf) || shelf < 0) return null
      return { type: "goto", shelf }
    }
    case "config": {
      const shelves = (body as { shelves?: unknown }).shelves
      if (typeof shelves !== "number" || !Number.isInteger(shelves) || shelves <= 0) return null
      return { type: "config", shelves }
    }
    default:
      return null
  }
}

/**
 * POST /api/pi/command
 * Body: { ip: string, port: number, command: NodeCommand }
 *
 * Forwards a validated command to the Pi via the shared server relay. Any
 * device can call this — the server owns the single socket to the Pi — so a
 * phone that can't reach the Pi's LAN IP directly can still drive the carousel.
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 })
  }

  const ip = typeof (body as { ip?: unknown }).ip === "string" ? ((body as { ip: string }).ip).trim() : ""
  const port = Number((body as { port?: unknown }).port)
  const command = parseCommand((body as { command?: unknown }).command)

  if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Response.json({ ok: false, error: "Bad ip/port" }, { status: 400 })
  }
  if (!isAllowedTarget(ip)) {
    return Response.json({ ok: false, error: "Target not allowed" }, { status: 403 })
  }
  if (!command) {
    return Response.json({ ok: false, error: "Unknown command" }, { status: 400 })
  }

  const delivered = sendCommand(ip, port, command)
  if (!delivered) {
    // 503: the relay isn't currently connected to the Pi.
    return Response.json({ ok: false, error: "Pi not connected" }, { status: 503 })
  }
  return Response.json({ ok: true })
}
