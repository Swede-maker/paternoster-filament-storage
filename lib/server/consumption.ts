import "server-only"
import type { Printer, Spool } from "@/lib/types"
import { lengthToGrams, spoolDiameter, spoolDensity } from "@/lib/filament"
import type { MoonrakerBody, BambuBody } from "./printer-status"

/**
 * Pure filament-consumption math, ported verbatim from the browser's
 * `useLiveConsumption` so the Pi computes exactly the same grams — the only
 * difference is where the running "previous reading" is held (a per-printer
 * tracker object here instead of a React ref).
 *
 * Consumption always targets ONLY the spool actively printing; idle loaded
 * spools are never touched.
 */

/** Per-printer running state the poller carries between polls. */
export interface ConsumptionTracker {
  /** Last cumulative filament_used (mm) seen for Klipper/Prusa. */
  prevMm: number | null
  /** Last remaining-% seen per Bambu tray, keyed by global slot index. */
  prevRemain: Record<number, number>
}

/** A fresh tracker for a newly-seen printer. */
export function newTracker(): ConsumptionTracker {
  return { prevMm: null, prevRemain: {} }
}

/** One spool decrement to apply. */
export interface Decrement {
  spoolId: string
  grams: number
  /** Which printer extruded this filament, for per-printer statistics. */
  printerId: string
  printerName: string
}

/**
 * Klipper (Moonraker) and Prusa (PrusaLink) both report cumulative mm of
 * filament used. Each increase becomes grams off the active tool's spool. A
 * counter reset (new print, or server restart) just re-baselines — never
 * consumes. Mutates `tracker.prevMm`.
 */
export function consumeFromMm(
  reading: Pick<MoonrakerBody, "connected" | "filamentUsedMm" | "activeTool">,
  printer: Printer,
  spools: Record<string, Spool>,
  defaultDiameter: number,
  tracker: ConsumptionTracker,
): Decrement | null {
  if (!reading.connected || typeof reading.filamentUsedMm !== "number") return null
  const mm = reading.filamentUsedMm
  if (tracker.prevMm === null || mm < tracker.prevMm) {
    tracker.prevMm = mm // first read, or a new print reset the counter
    return null
  }
  const delta = mm - tracker.prevMm
  tracker.prevMm = mm
  if (delta <= 0) return null
  const slot = printer.kind === "toolchanger" ? reading.activeTool ?? 0 : 0
  const id = printer.loaded[slot]
  const spool = id ? spools[id] : null
  if (!spool) return null
  const grams = lengthToGrams(delta, spoolDiameter(spool, defaultDiameter), spoolDensity(spool))
  return grams > 0 ? { spoolId: spool.id, grams, printerId: printer.id, printerName: printer.name } : null
}

/**
 * Bambu: each downward step in a tray's remaining-% becomes grams against that
 * spool's full-spool capacity. Mutates `tracker.prevRemain`. Returns every
 * decrement to apply this poll (usually zero or one).
 */
export function consumeFromBambu(
  status: Pick<BambuBody, "connected" | "trays">,
  printer: Printer,
  spools: Record<string, Spool>,
  tracker: ConsumptionTracker,
): Decrement[] {
  const out: Decrement[] = []
  if (!status.connected || !Array.isArray(status.trays)) return out
  for (const tray of status.trays) {
    if (!tray.present || typeof tray.remainPct !== "number") continue
    const prev = tracker.prevRemain[tray.globalIndex]
    tracker.prevRemain[tray.globalIndex] = tray.remainPct
    if (prev === undefined || tray.remainPct >= prev) continue
    const id = printer.loaded[tray.globalIndex]
    const spool = id ? spools[id] : null
    if (!spool) continue
    const cap = spool.capacity && spool.capacity > 0 ? spool.capacity : tray.capacityG ?? 1000
    const grams = ((prev - tray.remainPct) / 100) * cap
    if (grams > 0) out.push({ spoolId: spool.id, grams, printerId: printer.id, printerName: printer.name })
  }
  return out
}
