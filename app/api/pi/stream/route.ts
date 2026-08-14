import type { NextRequest } from "next/server"
import { subscribe, isAllowedTarget, type RelayFrame } from "@/lib/server/pi-relay"

// The relay keeps a long-lived socket to the Pi; this route streams it to the
// browser via SSE. Must run on the Node.js runtime (the `ws` package needs it)
// and never be statically cached.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/pi/stream?ip=<ip>&port=<port>&shelves=<n>
 *
 * Server-Sent Events stream of relay frames for one Pi endpoint:
 *   event: link   data: {"status":"online"}
 *   event: pi     data: <raw Pi event JSON>
 * Plus periodic `: keepalive` comments so proxies don't drop the connection.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const ip = searchParams.get("ip")?.trim() ?? ""
  const port = Number(searchParams.get("port") ?? "")
  const shelves = Number(searchParams.get("shelves") ?? "0")

  if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return new Response("Bad ip/port", { status: 400 })
  }
  if (!isAllowedTarget(ip)) {
    return new Response("Target not allowed (LAN addresses only)", { status: 403 })
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const safeEnqueue = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }

      const onFrame = (frame: RelayFrame) => {
        if (frame.kind === "link") {
          safeEnqueue(`event: link\ndata: ${JSON.stringify({ status: frame.status })}\n\n`)
        } else {
          // Pi event payloads are already JSON strings; forward verbatim.
          safeEnqueue(`event: pi\ndata: ${frame.data}\n\n`)
        }
      }

      const unsubscribe = subscribe(ip, port, Number.isFinite(shelves) ? shelves : 0, onFrame)

      // Keepalive comment every 20s.
      const keepalive = setInterval(() => safeEnqueue(`: keepalive\n\n`), 20000)

      const cleanup = () => {
        if (closed) return
        closed = true
        clearInterval(keepalive)
        unsubscribe()
        try {
          controller.close()
        } catch {
          // already closed
        }
      }

      req.signal.addEventListener("abort", cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
