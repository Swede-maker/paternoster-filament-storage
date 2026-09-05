import type { NextRequest } from "next/server"

/**
 * Shared bits for the printer-facing API. These endpoints are meant to be
 * called by 3D-printer UIs (Klipper macros, plugins) on the same LAN, from a
 * different origin than PAX, so every response is CORS-open. Security is the
 * optional shared token, not the origin.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-pax-token",
  "Access-Control-Max-Age": "86400",
}

/** Pull the shared token from the header (preferred) or a `?token=` query. */
export function tokenFromRequest(req: NextRequest): string | null {
  const header = req.headers.get("x-pax-token")
  if (header) return header
  return req.nextUrl.searchParams.get("token")
}

/** 401 with CORS headers so a browser-based printer UI can read the error. */
export function unauthorized() {
  return Response.json(
    { error: "Invalid or missing token. Send it in the x-pax-token header." },
    { status: 401, headers: CORS_HEADERS },
  )
}

/** 400 helper with CORS headers. */
export function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400, headers: CORS_HEADERS })
}
