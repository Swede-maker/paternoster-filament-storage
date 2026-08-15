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
  return (
    printer.firmware === "bambu" &&
    !!printer.serial?.trim() &&
    !!printer.accessCode?.trim() &&
    (printer.bambuMode !== "lan" || !!printer.ip?.trim())
  )
}

function connectionPayload(printer: Printer) {
  return {
    ip: printer.ip,
    serial: printer.serial,
    accessCode: printer.accessCode,
    mode: printer.bambuMode ?? "lan",
    amsUnits: Math.max(1, printer.amsUnits),
    slotsPerAms: Math.max(1, printer.slotsPerAms),
  }
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
