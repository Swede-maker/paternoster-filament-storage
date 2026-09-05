import type { NextRequest } from "next/server"
import { loadSystemState, saveSystemState } from "@/app/actions/system-state"
import { checkApiToken, stateFromPersisted, validateDispenseTarget } from "@/lib/printer-api"
import type { DispenseRequest } from "@/lib/types"
import { CORS_HEADERS, badRequest, tokenFromRequest, unauthorized } from "../_shared"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Keep the persisted queue bounded (mirrors DISPENSE_CAP in the store). */
const DISPENSE_CAP = 200

/**
 * POST /api/printers/dispense
 *
 * Queue a filament-dispense request for a spool addressed by node + shelf +
 * slot. The request is written into the shared document as `pending`; an open
 * PAX screen then runs the normal guided pick (carousel rotation + take-out)
 * and advances the status. Poll GET /api/printers/dispense?id=<id> for status.
 *
 * Body: { nodeId: string, shelf: number, slot: number, printerId?, note? }
 */
export async function POST(req: NextRequest) {
  const { data } = await loadSystemState()
  if (!data) return badRequest("PAX is not set up yet")
  const snapshot = stateFromPersisted(data)
  if (!checkApiToken(snapshot.apiToken, tokenFromRequest(req))) return unauthorized()

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return badRequest("Body must be JSON")
  }
  const b = (body ?? {}) as Record<string, unknown>
  const nodeId = typeof b.nodeId === "string" ? b.nodeId : ""
  const shelf = typeof b.shelf === "number" ? b.shelf : Number.NaN
  const slot = typeof b.slot === "number" ? b.slot : Number.NaN
  if (!nodeId || Number.isNaN(shelf) || Number.isNaN(slot)) {
    return badRequest("nodeId (string), shelf (number) and slot (number) are required")
  }

  const check = validateDispenseTarget(snapshot, nodeId, shelf, slot)
  if (!check.ok) return badRequest(check.reason ?? "Invalid slot")

  const now = Date.now()
  const request: DispenseRequest = {
    id: (globalThis.crypto?.randomUUID?.() ?? `disp_${now}_${Math.random().toString(36).slice(2)}`),
    nodeId,
    shelf,
    slot,
    spoolId: check.spoolId ?? null,
    printerId: typeof b.printerId === "string" ? b.printerId : null,
    note: typeof b.note === "string" ? b.note.slice(0, 200) : undefined,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    source: "api",
  }

  // Append to the shared queue and persist the whole document. The version bump
  // makes every open PAX screen resync and pick this up.
  const existing = Array.isArray(data.dispenseRequests) ? data.dispenseRequests : []
  const next = { ...data, dispenseRequests: [...existing, request].slice(-DISPENSE_CAP) }
  await saveSystemState(next)

  return Response.json({ ok: true, request }, { status: 202, headers: CORS_HEADERS })
}

/**
 * GET /api/printers/dispense?id=<id>
 *
 * Return the status of a previously queued request. Without `id`, returns the
 * full current queue (handy for debugging from a browser).
 */
export async function GET(req: NextRequest) {
  const { data } = await loadSystemState()
  if (!data) return Response.json({ requests: [] }, { headers: CORS_HEADERS })
  const snapshot = stateFromPersisted(data)
  if (!checkApiToken(snapshot.apiToken, tokenFromRequest(req))) return unauthorized()

  const requests = Array.isArray(data.dispenseRequests) ? data.dispenseRequests : []
  const id = req.nextUrl.searchParams.get("id")
  if (id) {
    const found = requests.find((r) => r.id === id)
    if (!found) return Response.json({ error: "No request with that id" }, { status: 404, headers: CORS_HEADERS })
    return Response.json({ request: found }, { headers: CORS_HEADERS })
  }
  return Response.json({ requests }, { headers: CORS_HEADERS })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
