import type { NextRequest } from "next/server"
import { publishScan, publishPing } from "@/lib/server/reader-hub"
import { parseReaderPost } from "@/lib/reader-protocol"

// A wireless reader hits this endpoint; keep it dynamic and on Node.js.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Permissive CORS: readers are simple devices posting from the LAN. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

/**
 * POST /api/reader/scan
 * Body: { token: string, uid?: string, event?: "tag" | "ping", name?: string }
 *
 * Called by a wireless RFID reader (ESP32 / Pi). Publishes the scanned uid to
 * every browser subscribed to that token's SSE stream. The token is the shared
 * secret AND the channel id, so no per-reader server state is needed.
 *
 * Responds with `{ ok, listeners }` — `listeners` lets the firmware light a
 * "someone is waiting" LED (0 = read succeeded but no app is listening).
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400, headers: CORS })
  }

  const post = parseReaderPost(body)
  if (!post) {
    return Response.json({ ok: false, error: "Bad token or payload" }, { status: 400, headers: CORS })
  }

  const listeners =
    post.event === "ping" || !post.uid ? publishPing(post.token) : publishScan(post.token, post.uid)

  return Response.json({ ok: true, listeners }, { headers: CORS })
}
