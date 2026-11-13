import type { NextRequest } from "next/server"
import { cameraTargetFor, probeCamera, subscribeCamera } from "@/lib/server/bambu-camera"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const BOUNDARY = "paxframe"

/**
 * GET /api/bambu/camera?printerId=<id>            → MJPEG live view
 * GET /api/bambu/camera?printerId=<id>&probe=1    → JSON status (protocol, ffmpeg, errors)
 *
 * Only the printer id travels in the URL; the IP and access code are read from
 * the server's stored state so they never appear in the browser or logs.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const printerId = searchParams.get("printerId")?.trim() ?? ""
  if (!printerId) return Response.json({ ok: false, error: "Missing printerId" }, { status: 400 })

  const target = cameraTargetFor(printerId)
  const probe = await probeCamera(target)

  if (searchParams.has("probe")) {
    return Response.json(probe, { headers: { "Cache-Control": "no-store" } })
  }
  if (!probe.ok || !target) {
    return new Response(probe.ok ? "Camera unavailable" : probe.error, { status: 503 })
  }

  const enc = new TextEncoder()
  let unsubscribe: (() => void) | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let busy = false
      unsubscribe = subscribeCamera(target, probe.kind, (jpeg) => {
        // Drop frames for a slow client rather than buffering without bound.
        if (busy || (controller.desiredSize ?? 1) <= 0) return
        busy = true
        try {
          controller.enqueue(
            enc.encode(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
          )
          controller.enqueue(new Uint8Array(jpeg))
          controller.enqueue(enc.encode("\r\n"))
        } catch {
          unsubscribe?.()
        } finally {
          busy = false
        }
      })
      req.signal.addEventListener("abort", () => {
        unsubscribe?.()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
    cancel() {
      unsubscribe?.()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
