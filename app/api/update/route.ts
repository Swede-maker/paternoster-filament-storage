import type { NextRequest } from "next/server"
import { getUpdateStatus, requestUpdate } from "@/lib/server/updater"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET  /api/update            current status + last known remote check
 * GET  /api/update?check=1    also contact GitHub (cached 5 min; &force=1 bypasses)
 * POST /api/update            start the update (handled by the root pax-update service)
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams
  const status = await getUpdateStatus({ check: params.has("check"), force: params.has("force") })
  return Response.json(status)
}

export async function POST() {
  const result = await requestUpdate()
  if (!result.ok) return Response.json(result, { status: result.status ?? 500 })
  return Response.json({ ok: true }, { status: 202 })
}
