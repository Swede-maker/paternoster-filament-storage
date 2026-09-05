import type { NextRequest } from "next/server"
import { loadSystemState } from "@/app/actions/system-state"
import { apiSpoolList, checkApiToken, stateFromPersisted } from "@/lib/printer-api"
import { CORS_HEADERS, tokenFromRequest, unauthorized } from "../_shared"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/printers/spools
 *
 * Live list of filament spools an external printer UI can load from. Slots are
 * addressed by node + shelf + slot so a printer can turn around and POST the
 * same coordinates to /api/printers/dispense. Optional shared-token auth.
 */
export async function GET(req: NextRequest) {
  const { data } = await loadSystemState()
  if (!data) {
    return Response.json({ spools: [], count: 0 }, { headers: CORS_HEADERS })
  }
  const state = stateFromPersisted(data)
  if (!checkApiToken(state.apiToken, tokenFromRequest(req))) return unauthorized()

  const spools = apiSpoolList(state)
  return Response.json({ spools, count: spools.length }, { headers: CORS_HEADERS })
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
