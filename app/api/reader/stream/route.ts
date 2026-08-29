import type { NextRequest } from "next/server"
import { subscribe } from "@/lib/server/reader-hub"
import { isValidReaderToken, type ReaderFrame } from "@/lib/reader-protocol"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/reader/stream?token=<pairing-token>
 *
 * Server-Sent Events stream for one wireless reader. Emits:
 *   event: tag       data: {"uid":"04A2..."}       — a tag was scanned
 *   event: presence  data: {"online":true}          — reader online/offline
 * plus periodic `: keepalive` comments so proxies don't drop the connection.
 *
 * The browser subscribes with the same token the reader was paired with; the
 * server bridges the reader's POSTs to this stream.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const token = searchParams.get("token")?.trim() ?? ""
  const encoder = new TextEncoder()

  if (!isValidReaderToken(token)) {
    return new Response("Invalid token", { status: 400 })
  }

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

      const onFrame = (frame: ReaderFrame) => {
        if (frame.kind === "tag") {
          safeEnqueue(`event: tag\ndata: ${JSON.stringify({ uid: frame.uid, at: frame.at })}\n\n`)
        } else {
          safeEnqueue(`event: presence\ndata: ${JSON.stringify({ online: frame.online, at: frame.at })}\n\n`)
        }
      }

      const unsubscribe = subscribe(token, onFrame)
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
