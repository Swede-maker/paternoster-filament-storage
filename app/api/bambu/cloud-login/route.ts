import { type NextRequest, NextResponse } from "next/server"

// Node runtime: this route makes outbound HTTPS calls to Bambu's cloud API.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Region = "global" | "china"

/** Base REST host for the account region. */
function apiBase(region: Region): string {
  return region === "china" ? "https://api.bambulab.cn" : "https://api.bambulab.com"
}

const UA = "bambu-network-agent/01.09.05.01"

/**
 * POST /api/bambu/cloud-login
 *
 * Actions (JSON body `{ action, region, ... }`):
 *  - "login"   { email, password }            → begins sign-in. May return
 *                                               { needVerify } / { needTfa }.
 *  - "verify"  { email, password, code }       → completes an email-code login.
 *  - "tfa"     { tfaKey, code }                → completes a 2FA login.
 *  - "devices" { token }                       → lists the account's printers.
 *  - "refresh" { refreshToken }                → silently mints a fresh access
 *                                               token so the printer stays
 *                                               linked without re-entering the
 *                                               password.
 *
 * Successful logins/refreshes return { token, uid, refreshToken?, expiresAt? }
 * where expiresAt is an epoch-ms hint of when the access token stops working.
 *
 * Never throws: always returns JSON so the client can render a clear message.
 */
export async function POST(req: NextRequest) {
  let body: any = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 })
  }

  const region: Region = body.region === "china" ? "china" : "global"
  const action: string = typeof body.action === "string" ? body.action : "login"

  // Bound every upstream call so a hung request can't hang the route.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 12000)

  try {
    if (action === "login" || action === "verify" || action === "tfa") {
      return await handleLogin(action, region, body, ac.signal)
    }
    if (action === "devices") {
      return await handleDevices(region, body, ac.signal)
    }
    if (action === "refresh") {
      return await handleRefresh(region, body, ac.signal)
    }
    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 })
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return NextResponse.json({ ok: false, error: "Bambu cloud request timed out" }, { status: 200 })
    }
    const msg = err instanceof Error ? err.message : "Request failed"
    return NextResponse.json({ ok: false, error: `Bambu cloud error: ${msg}` }, { status: 200 })
  } finally {
    clearTimeout(timer)
  }
}

async function handleLogin(
  action: "login" | "verify" | "tfa",
  region: Region,
  body: any,
  signal: AbortSignal,
): Promise<NextResponse> {
  const url = `${apiBase(region)}/v1/user-service/user/login`

  // Build the payload for the requested step.
  let payload: Record<string, unknown>
  if (action === "tfa") {
    // 2FA completion goes through a different endpoint below; handled separately.
    return await handleTfa(region, body, signal)
  } else if (action === "verify") {
    const code = String(body.code ?? "").trim()
    if (!code) return NextResponse.json({ ok: false, error: "Enter the verification code" }, { status: 200 })
    payload = {
      account: String(body.email ?? "").trim(),
      password: String(body.password ?? ""),
      code,
      apiError: "",
    }
  } else {
    const email = String(body.email ?? "").trim()
    const password = String(body.password ?? "")
    if (!email || !password) {
      return NextResponse.json({ ok: false, error: "Email and password are required" }, { status: 200 })
    }
    payload = { account: email, password, apiError: "" }
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA,
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  })

  const raw = await res.text()
  let json: any = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    return NextResponse.json(
      { ok: false, error: `Unexpected response from Bambu (${res.status})` },
      { status: 200 },
    )
  }

  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: json?.error ?? json?.message ?? `Sign-in failed (${res.status})` },
      { status: 200 },
    )
  }

  // Bambu returns an accessToken directly, OR a challenge that needs a second
  // step: `loginType` is "verifyCode" (email code) or "tfa" (authenticator).
  const accessToken: string = json?.accessToken ?? ""
  const loginType: string = json?.loginType ?? ""

  if (!accessToken && loginType === "verifyCode") {
    // Trigger the email code to be sent, then ask the user for it.
    await sendVerifyCode(region, String(body.email ?? "").trim(), signal).catch(() => {})
    return NextResponse.json({ ok: true, needVerify: true }, { status: 200 })
  }
  if (!accessToken && loginType === "tfa") {
    return NextResponse.json({ ok: true, needTfa: true, tfaKey: json?.tfaKey ?? "" }, { status: 200 })
  }
  if (!accessToken) {
    return NextResponse.json({ ok: false, error: "Sign-in did not return a token" }, { status: 200 })
  }

  return NextResponse.json(tokenResponse(accessToken, json), { status: 200 })
}

/**
 * Build the standard success payload from an access token plus the raw login
 * response. Captures the refresh token and an expiry hint (from `expiresIn`
 * seconds, or the JWT `exp` claim) so the client can refresh before it lapses.
 */
function tokenResponse(accessToken: string, raw: any) {
  const refreshToken: string = raw?.refreshToken ?? raw?.refresh_token ?? ""
  const expiresInSec: number = Number(raw?.expiresIn ?? raw?.expires_in ?? 0)
  const expiresAt =
    expiresInSec > 0 ? Date.now() + expiresInSec * 1000 : decodeExpFromJwt(accessToken)
  return {
    ok: true as const,
    token: accessToken,
    uid: decodeUidFromJwt(accessToken),
    refreshToken: refreshToken || undefined,
    expiresAt: expiresAt || undefined,
  }
}

/**
 * Exchange a refresh token for a new access token. Bambu returns a fresh
 * accessToken (and usually a rotated refreshToken) so the link survives without
 * the user re-entering their password.
 */
async function handleRefresh(region: Region, body: any, signal: AbortSignal): Promise<NextResponse> {
  const refreshToken = String(body.refreshToken ?? "").trim()
  if (!refreshToken) return NextResponse.json({ ok: false, error: "Missing refresh token" }, { status: 200 })

  const res = await fetch(`${apiBase(region)}/v1/user-service/user/refreshtoken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA, Accept: "application/json" },
    body: JSON.stringify({ refreshToken }),
    signal,
  })
  const raw = await res.text()
  let json: any = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    return NextResponse.json({ ok: false, error: `Unexpected refresh response (${res.status})` }, { status: 200 })
  }
  const accessToken: string = json?.accessToken ?? json?.token ?? ""
  if (!res.ok || !accessToken) {
    return NextResponse.json(
      { ok: false, error: json?.error ?? json?.message ?? `Token refresh failed (${res.status})` },
      { status: 200 },
    )
  }
  // Bambu may or may not rotate the refresh token; keep the old one if absent.
  const merged = { ...json, refreshToken: json?.refreshToken ?? json?.refresh_token ?? refreshToken }
  return NextResponse.json(tokenResponse(accessToken, merged), { status: 200 })
}

/** Ask Bambu to email a verification code to the account. */
async function sendVerifyCode(region: Region, email: string, signal: AbortSignal): Promise<void> {
  if (!email) return
  await fetch(`${apiBase(region)}/v1/user-service/user/sendemail/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ email, type: "codeLogin" }),
    signal,
  })
}

/** Complete a 2FA (authenticator app) login. */
async function handleTfa(region: Region, body: any, signal: AbortSignal): Promise<NextResponse> {
  const tfaKey = String(body.tfaKey ?? "").trim()
  const code = String(body.code ?? "").trim()
  if (!tfaKey || !code) {
    return NextResponse.json({ ok: false, error: "Enter the 2FA code" }, { status: 200 })
  }
  // The 2FA endpoint lives on the bambulab.com/.cn web host, not the api host.
  const host = region === "china" ? "https://bambulab.cn" : "https://bambulab.com"
  const res = await fetch(`${host}/api/sign-in/tfa`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ tfaKey, tfaCode: code }),
    signal,
  })
  const raw = await res.text()
  let json: any = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    /* fall through */
  }
  // The token is returned either in the JSON body or as a `token` Set-Cookie.
  let token: string = json?.accessToken ?? json?.token ?? ""
  if (!token) {
    const setCookie = res.headers.get("set-cookie") ?? ""
    const m = setCookie.match(/token=([^;]+)/)
    if (m) token = decodeURIComponent(m[1])
  }
  if (!token) {
    return NextResponse.json({ ok: false, error: "2FA verification failed" }, { status: 200 })
  }
  return NextResponse.json(tokenResponse(token, json ?? {}), { status: 200 })
}

/** List the printers bound to the account. */
async function handleDevices(region: Region, body: any, signal: AbortSignal): Promise<NextResponse> {
  const token = String(body.token ?? "").trim()
  if (!token) return NextResponse.json({ ok: false, error: "Not signed in" }, { status: 200 })

  const res = await fetch(`${apiBase(region)}/v1/iot-service/api/user/bind`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": UA,
      Accept: "application/json",
    },
    signal,
  })
  const raw = await res.text()
  let json: any = null
  try {
    json = raw ? JSON.parse(raw) : null
  } catch {
    return NextResponse.json({ ok: false, error: `Unexpected device-list response (${res.status})` }, { status: 200 })
  }
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, error: json?.error ?? json?.message ?? `Could not list devices (${res.status})` },
      { status: 200 },
    )
  }
  const devices = Array.isArray(json?.devices)
    ? json.devices.map((d: any) => ({
        serial: String(d.dev_id ?? ""),
        name: String(d.name ?? d.dev_id ?? "Bambu printer"),
        model: String(d.dev_product_name ?? d.dev_model_name ?? ""),
        online: d.online === true,
      }))
    : []
  return NextResponse.json({ ok: true, devices }, { status: 200 })
}

/** Extract the numeric user id from a Bambu JWT (its `username` claim is `u_<uid>`). */
function decodeUidFromJwt(jwt: string): string {
  try {
    const part = jwt.split(".")[1]
    if (!part) return ""
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/")
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : ""
    const payload = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"))
    const username: string = payload?.username ?? ""
    if (username.startsWith("u_")) return username.slice(2)
    return String(payload?.uid ?? "")
  } catch {
    return ""
  }
}

/** Read the `exp` (seconds) claim from a JWT and return it as epoch-ms, or 0. */
function decodeExpFromJwt(jwt: string): number {
  try {
    const part = jwt.split(".")[1]
    if (!part) return 0
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/")
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : ""
    const payload = JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"))
    const exp = Number(payload?.exp ?? 0)
    return exp > 0 ? exp * 1000 : 0
  } catch {
    return 0
  }
}
