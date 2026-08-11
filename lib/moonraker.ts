import type { Printer } from "./types"
import { klipperHeaterName } from "./printer-commands"

/**
 * Client-side helpers that talk to our own /api/moonraker proxy, which in turn
 * talks to the printer's Moonraker HTTP API. Kept separate from the pure
 * command-string builders in printer-commands.ts so those stay testable and
 * network-free.
 *
 * Real networking is Klipper/Moonraker-specific. A printer is "linkable" only
 * when it is a Klipper machine with an IP set.
 */

export type HeaterReading = { actual: number; target: number }
export type MoonrakerStatus = {
  connected: boolean
  /** Live readings keyed by Klipper heater name (extruder, extruder1, …). */
  temps: Record<string, HeaterReading>
  error?: string
}

/** Whether we can send/read real commands for this printer over Moonraker. */
export function isKlipperLinked(printer: Printer): boolean {
  return printer.firmware === "klipper" && !!printer.ip?.trim()
}

/** Heater names to poll for a printer, one per toolhead (extruder, extruder1…). */
export function heaterNames(printer: Printer): string[] {
  const count = printer.kind === "toolchanger" ? Math.max(1, printer.toolheads) : 1
  return Array.from({ length: count }, (_, i) => klipperHeaterName(i))
}

function connectionPayload(printer: Printer) {
  return { ip: printer.ip, port: printer.port, apiKey: printer.apiKey }
}

/** Query live connection + temperatures. Never throws; returns a status object. */
export async function fetchMoonrakerStatus(printer: Printer): Promise<MoonrakerStatus> {
  try {
    const res = await fetch("/api/moonraker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...connectionPayload(printer), action: "status", heaters: heaterNames(printer) }),
    })
    const json = await res.json()
    if (!res.ok || !json.ok) {
      return { connected: false, temps: {}, error: json?.error ?? `Error ${res.status}` }
    }
    return { connected: true, temps: json.temps ?? {} }
  } catch (err) {
    return { connected: false, temps: {}, error: err instanceof Error ? err.message : "Request failed" }
  }
}
