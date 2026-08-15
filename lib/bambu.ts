import type { Printer } from "./types"

/**
 * Client-side helpers that talk to our own /api/bambu proxy, which in turn talks
 * to a Bambu Lab printer over MQTT (LAN mode: mqtts://<ip>:8883 with user `bblp`
 * + access code + serial). The proxy reads the printer's AMS tray + RFID data
 * and current print state.
 *
 * Like the Moonraker proxy, a real connection only works when the app is
 * self-hosted on the printer's LAN. On a hosted preview the LAN IP is
 * unreachable, so the proxy returns a deterministic *simulation* with the same
 * shape so the AMS/RFID flows remain demoable.
 */

/** One AMS tray as reported by the printer (or simulated). */
export type BambuAmsTray = {
  /** AMS unit index (0-based). */
  amsIndex: number
  /** Tray index within its AMS unit (0–3). */
  trayIndex: number
  /** Flattened slot index across all AMS units (amsIndex*4 + trayIndex). */
  globalIndex: number
  /** Whether a spool is present in this tray. */
  present: boolean
  /** Material type, e.g. "PLA", "PETG". */
  material?: string
  /** Hex color "#RRGGBB" derived from the tray's RGBA. */
  color?: string
  colorName?: string
  brand?: string
  /** Remaining filament percentage (0–100), when the printer reports it. */
  remainPct?: number
  /** Nominal full-spool weight in grams (tray_weight). */
  capacityG?: number
  /** RFID tag UID (tray_uuid). Empty/absent for third-party spools. */
  rfid?: string
}

export type BambuStatus = {
  connected: boolean
  /** Print state, e.g. "RUNNING", "IDLE", "FINISH", "PAUSE". */
  printState?: string
  /** Global index of the currently active tray, or null when none/external. */
  activeTray?: number | null
  trays: BambuAmsTray[]
  /** True when the data came from the simulation fallback, not a real printer. */
  simulated?: boolean
  error?: string
}

/** Whether we can read real AMS/RFID data for this printer over MQTT. */
export function isBambuLinked(printer: Printer): boolean {
  if (printer.firmware !== "bambu" || !printer.serial?.trim()) return false
  if (printer.bambuMode === "cloud") {
    // Cloud needs an account token + uid (obtained by signing in).
    return !!printer.bambuToken?.trim() && !!printer.bambuUid?.trim()
  }
  // LAN needs an access code and the printer's IP.
  return !!printer.accessCode?.trim() && !!printer.ip?.trim()
}

function connectionPayload(printer: Printer) {
  return {
    ip: printer.ip,
    serial: printer.serial,
    accessCode: printer.accessCode,
    mode: printer.bambuMode ?? "lan",
    region: printer.bambuRegion ?? "global",
    token: printer.bambuToken,
    uid: printer.bambuUid,
    amsUnits: Math.max(1, printer.amsUnits),
    slotsPerAms: Math.max(1, printer.slotsPerAms),
  }
}

// ---------------------------------------------------------------------------
// Bambu cloud sign-in helpers (talk to /api/bambu/cloud-login).
// ---------------------------------------------------------------------------

export type BambuRegion = "global" | "china"

/** A completed cloud sign-in: the tokens needed to stay connected. */
export type BambuTokens = {
  token: string
  uid: string
  /** Present when the account supports silent refresh. */
  refreshToken?: string
  /** Epoch-ms hint of when `token` stops working. */
  expiresAt?: number
}

/** Result of a cloud login step. */
export type BambuLoginResult =
  | ({ ok: true } & BambuTokens)
  | { ok: true; needVerify: true }
  | { ok: true; needTfa: true; tfaKey: string }
  | { ok: false; error: string }

export type BambuCloudDevice = {
  serial: string
  name: string
  model: string
  online: boolean
}

async function postCloud(payload: Record<string, unknown>): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch("/api/bambu/cloud-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const raw = await res.text()
    // Happy path: the route always answers with JSON, even for failures.
    let json: any = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {
      json = null
    }
    if (json && typeof json === "object") return json

    // Non-JSON response — translate the status into an actionable message so
    // the user knows whether it's a missing route, a server crash, etc.
    if (res.status === 404) {
      return {
        ok: false,
        error:
          "Sign-in endpoint not found (404). This deployment is running an older build — rebuild and redeploy the app to enable cloud sign-in.",
      }
    }
    if (res.status >= 500) {
      return { ok: false, error: `The app server errored (${res.status}). Check the server logs.` }
    }
    return { ok: false, error: `Unexpected response from the app server (${res.status}).` }
  } catch (err) {
    console.log("[v0] Bambu cloud sign-in request failed:", err)
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        ok: false,
        error:
          "Sign-in timed out. The app server may not be able to reach Bambu's cloud — check the server's internet access.",
      }
    }
    const msg = err instanceof Error ? err.message : "Request failed"
    // A bare fetch TypeError means the browser got no response at all.
    if (msg === "Failed to fetch" || msg === "Load failed" || msg === "NetworkError when attempting to fetch resource.") {
      return {
        ok: false,
        error:
          "Could not reach the app server at /api/bambu/cloud-login. Make sure the app is running and has been rebuilt/redeployed with the latest code.",
      }
    }
    return { ok: false, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** Step 1: sign in with email + password. May require a follow-up code. */
export async function bambuCloudLogin(region: BambuRegion, email: string, password: string): Promise<BambuLoginResult> {
  return (await postCloud({ action: "login", region, email, password })) as BambuLoginResult
}

/** Step 2a: complete an email-verification-code login. */
export async function bambuCloudVerify(
  region: BambuRegion,
  email: string,
  password: string,
  code: string,
): Promise<BambuLoginResult> {
  return (await postCloud({ action: "verify", region, email, password, code })) as BambuLoginResult
}

/** Step 2b: complete a 2FA (authenticator) login. */
export async function bambuCloudTfa(region: BambuRegion, tfaKey: string, code: string): Promise<BambuLoginResult> {
  return (await postCloud({ action: "tfa", region, tfaKey, code })) as BambuLoginResult
}

/** List the printers bound to the signed-in account. */
export async function bambuCloudDevices(
  region: BambuRegion,
  token: string,
): Promise<{ ok: true; devices: BambuCloudDevice[] } | { ok: false; error: string }> {
  const json = await postCloud({ action: "devices", region, token })
  if (json?.ok && Array.isArray(json.devices)) return { ok: true, devices: json.devices as BambuCloudDevice[] }
  return { ok: false, error: json?.error ?? "Could not list devices" }
}

/** Silently exchange a refresh token for a fresh access token. */
export async function bambuCloudRefresh(
  region: BambuRegion,
  refreshToken: string,
): Promise<{ ok: true; tokens: BambuTokens } | { ok: false; error: string }> {
  const json = await postCloud({ action: "refresh", region, refreshToken })
  if (json?.ok && typeof json.token === "string") {
    return {
      ok: true,
      tokens: {
        token: json.token,
        uid: String(json.uid ?? ""),
        refreshToken: json.refreshToken,
        expiresAt: json.expiresAt,
      },
    }
  }
  return { ok: false, error: json?.error ?? "Token refresh failed" }
}

/** Query the printer's AMS/RFID + print state. Never throws. */
export async function fetchBambuStatus(printer: Printer): Promise<BambuStatus> {
  // Guard against a hung request (e.g. a route that never responds) so the UI
  // gets a clear timeout instead of spinning forever.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const res = await fetch("/api/bambu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...connectionPayload(printer), action: "status" }),
      signal: controller.signal,
    })
    // Read the body as text first so a non-JSON error page (e.g. an HTML 500)
    // produces a legible message instead of an opaque JSON-parse failure.
    const raw = await res.text()
    let json: any = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {
      const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 120)
      return {
        connected: false,
        trays: [],
        error: `Server error ${res.status}${snippet ? `: ${snippet}` : ""}`,
      }
    }
    if (!res.ok || !json?.ok) {
      return { connected: false, trays: [], error: json?.error ?? `Error ${res.status}` }
    }
    return {
      connected: true,
      printState: json.printState,
      activeTray: json.activeTray ?? null,
      trays: Array.isArray(json.trays) ? json.trays : [],
      simulated: json.simulated === true,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { connected: false, trays: [], error: "Printer request timed out" }
    }
    // A TypeError from fetch ("Failed to fetch") means the request never reached
    // the app server — usually a crashed API route or the app being offline.
    const msg = err instanceof Error ? err.message : "Request failed"
    return {
      connected: false,
      trays: [],
      error: msg === "Failed to fetch" ? "Could not reach the app server (/api/bambu)" : msg,
    }
  } finally {
    clearTimeout(timer)
  }
}
