import "server-only"
import { db } from "@/lib/db"
import type { PersistedState, Printer, Spool } from "@/lib/types"
import { DEFAULT_DIAMETER } from "@/lib/filament"
import { probeMoonraker, probePrusaLink, probeBambu } from "./printer-status"
import { consumeFromMm, consumeFromBambu, newTracker, type ConsumptionTracker, type Decrement } from "./consumption"
import { applyConsumption } from "./consumption-store"

/**
 * The Pi-side filament consumption poller.
 *
 * This is what makes weight tracking work with NO browser open: as long as the
 * server process (the Raspberry Pi) is running, it polls every linked printer
 * over the LAN and subtracts filament from the actively-printing spool, writing
 * straight to the shared database. Open browsers pick the change up through the
 * existing version-based sync.
 *
 * It reuses the exact same readers as the API routes and the exact same math as
 * the old in-browser tracker, so results are identical — only the location of
 * the running "previous reading" moved (an in-memory tracker here instead of a
 * React ref).
 */

const POLL_MS = 5000

// --- Link predicates (kept in sync with lib/moonraker, lib/prusalink, lib/bambu) ---

function isKlipperLinked(p: Printer): boolean {
  return p.firmware === "klipper" && !!p.ip?.trim()
}

function isPrusaLinked(p: Printer): boolean {
  return p.firmware === "prusalink" && !!p.ip?.trim()
}

function isBambuLinked(p: Printer): boolean {
  if (p.firmware !== "bambu" || !p.serial?.trim()) return false
  if (p.bambuMode === "cloud") return !!p.bambuToken?.trim() && !!p.bambuUid?.trim()
  return !!p.accessCode?.trim() && !!p.ip?.trim()
}

function heaterNames(p: Printer): string[] {
  const count = p.kind === "toolchanger" ? Math.max(1, p.toolheads) : 1
  return Array.from({ length: count }, (_, i) => (i === 0 ? "extruder" : `extruder${i}`))
}

function toolCount(p: Printer): number {
  return p.kind === "toolchanger" ? Math.max(1, p.toolheads) : 1
}

// --- Snapshot read (read-only; the atomic write lives in consumption-store) ---

interface Snapshot {
  printers: Printer[]
  spools: Record<string, Spool>
  defaultDiameter: number
}

function readSnapshot(): Snapshot | null {
  const row = db.prepare("SELECT data FROM system_state WHERE id = 1").get() as { data: string } | undefined
  if (!row) return null
  try {
    const s = JSON.parse(row.data) as PersistedState
    return {
      printers: Array.isArray(s.printers) ? s.printers : [],
      spools: s.spools ?? {},
      defaultDiameter: s.settings?.defaultDiameter ?? DEFAULT_DIAMETER,
    }
  } catch {
    return null
  }
}

// Per-printer running state, held for the life of the process.
const trackers = new Map<string, ConsumptionTracker>()

function trackerFor(printerId: string): ConsumptionTracker {
  let t = trackers.get(printerId)
  if (!t) {
    t = newTracker()
    trackers.set(printerId, t)
  }
  return t
}

async function pollOnce(): Promise<void> {
  const snap = readSnapshot()
  if (!snap) return
  const { printers, spools, defaultDiameter } = snap
  const decrements: Decrement[] = []

  await Promise.all(
    printers.map(async (printer) => {
      const tracker = trackerFor(printer.id)
      try {
        if (isKlipperLinked(printer)) {
          const { body } = await probeMoonraker({
            ip: printer.ip,
            port: printer.port,
            apiKey: printer.apiKey,
            heaters: heaterNames(printer),
          })
          const dec = consumeFromMm(body, printer, spools, defaultDiameter, tracker)
          if (dec) decrements.push(dec)
        } else if (isPrusaLinked(printer)) {
          const { body } = await probePrusaLink({
            ip: printer.ip,
            port: printer.port,
            apiKey: printer.apiKey,
            tools: toolCount(printer),
          })
          const dec = consumeFromMm(body, printer, spools, defaultDiameter, tracker)
          if (dec) decrements.push(dec)
        } else if (isBambuLinked(printer)) {
          const { body } = await probeBambu({
            ip: printer.ip,
            serial: printer.serial,
            accessCode: printer.accessCode,
            mode: printer.bambuMode,
            region: printer.bambuRegion,
            token: printer.bambuToken,
            uid: printer.bambuUid,
            amsUnits: printer.amsUnits,
            slotsPerAms: printer.slotsPerAms,
          })
          // Only real readings move weights. A simulated fallback (no LAN reach,
          // e.g. a hosted preview) must never tick down real inventory.
          if (!body.simulated) {
            for (const d of consumeFromBambu(body, printer, spools, tracker)) decrements.push(d)
          }
        }
      } catch (err) {
        // One unreachable printer must not stop the others or the whole poll.
        console.log(`[v0] consumption poll: printer ${printer.id} read failed:`, err)
      }
    }),
  )

  // Forget trackers for printers that were deleted, so the map can't grow forever.
  for (const id of [...trackers.keys()]) {
    if (!printers.some((p) => p.id === id)) trackers.delete(id)
  }

  if (decrements.length > 0) {
    const res = applyConsumption(decrements)
    if (res) console.log(`[v0] server-side consumption applied: -${res.totalGrams.toFixed(2)}g (version ${res.version})`)
  }
}

/**
 * Start the poller exactly once per process. Guarded on globalThis so dev
 * hot-reloads / double invocation can't spawn multiple loops. A single tick is
 * never allowed to overlap the next (an 8s printer timeout > the 5s interval),
 * so a slow printer just skips a beat instead of piling up.
 */
export function startConsumptionPoller(): void {
  const g = globalThis as unknown as { __paxConsumptionPoller?: NodeJS.Timeout }
  if (g.__paxConsumptionPoller) return

  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await pollOnce()
    } catch (err) {
      console.log("[v0] consumption poll tick error:", err)
    } finally {
      running = false
    }
  }

  const interval = setInterval(tick, POLL_MS)
  // Don't hold the process open on shutdown just for the poller.
  if (typeof interval.unref === "function") interval.unref()
  g.__paxConsumptionPoller = interval

  console.log("[v0] Filament consumption poller started (every 5s, server-side)")
  // First read shortly after boot to baseline the trackers without consuming.
  setTimeout(() => void tick(), 2000)
}
