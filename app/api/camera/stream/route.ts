import type { NextRequest } from "next/server"
import { isAllowedTarget } from "@/lib/server/pi-relay"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/camera/stream?ip=<host>&port=<port>
 *
 * Pipes the Pi's MJPEG webcam stream through the app server. A phone on the
 * hotspot or a remote browser often can't reach the Pi's port directly, and an
 * http:// image on an https:// page would be blocked as mixed content. When the
 * browser drops the <img>, the abort propagates upstream so the Pi stops the
 * camera.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const ip = searchParams.get("ip")?.trim() ?? ""
  const port = Number(searchParams.get("port") ?? "")

  if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Response.json({ ok: false, error: "Bad ip/port" }, { status: 400 })
  }
  if (!isAllowedTarget(ip)) {
    return Response.json({ ok: false, error: "Target not allowed" }, { status: 403 })
  }

  const host = ip.includes(":") ? `[${ip}]` : ip
  let upstream: Response
  try {
    upstream = await fetch(`http://${host}:${port}/stream`, { signal: req.signal, cache: "no-store" })
  } catch {
    return Response.json({ ok: false, error: "Camera unreachable" }, { status: 502 })
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "")
    return new Response(text || "Camera unavailable", { status: upstream.status || 502 })
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=paxframe",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
