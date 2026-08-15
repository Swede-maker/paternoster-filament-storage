import type { Printer } from "./types"
import type { MoonrakerStatus } from "./moonraker"

/**
 * Client-side helpers that talk to our own /api/prusalink proxy, which in turn
 * talks to a Prusa printer's PrusaLink HTTP API (MINI, MK3.9/PrusaLink, MK4,
 * XL, and the standalone PrusaLink Pi image).
 *
 * PrusaLink deliberately reuses the same status *shape* as Moonraker
 * (`MoonrakerStatus`) — live per-tool nozzle temperatures plus a monotonically
 * increasing filament-used value — so all of the downstream temperature display
 * and live weight-consumption logic works identically regardless of firmware.
 *
 * A printer is "linkable" over PrusaLink only when it is a `prusalink` machine
 * with an IP set.
 */

/** Whether we can read real temps/telemetry for this printer over PrusaLink. */
export function isPrusaLinked(printer: Printer): boolean {
  return printer.firmware === "prusalink" && !!printer.ip?.trim()
}

/** Number of tools to read (toolchangers like the XL expose tool0…toolN). */
function toolCount(printer: Printer): number {
  return printer.kind === "toolchanger" ? Math.max(1, printer.toolheads) : 1
}

function connectionPayload(printer: Printer) {
  // `apiKey` doubles as the PrusaLink password (username "maker") on current
  // firmware, or the legacy X-Api-Key on older firmware — the proxy tries both.
  return { ip: printer.ip, port: printer.port, apiKey: printer.apiKey }
}

/** Query live connection + temperatures. Never throws; returns a status object. */
export async function fetchPrusaLinkStatus(printer: Printer): Promise<MoonrakerStatus> {
  try {
    const res = await fetch("/api/prusalink", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...connectionPayload(printer), action: "status", tools: toolCount(printer) }),
    })
    const json = await res.json()
    if (!res.ok || !json.ok) {
      return { connected: false, temps: {}, error: json?.error ?? `Error ${res.status}` }
    }
    return {
      connected: true,
      temps: json.temps ?? {},
      printState: json.printState,
      filamentUsedMm: typeof json.filamentUsedMm === "number" ? json.filamentUsedMm : undefined,
      activeTool: typeof json.activeTool === "number" ? json.activeTool : undefined,
    }
  } catch (err) {
    return { connected: false, temps: {}, error: err instanceof Error ? err.message : "Request failed" }
  }
}
