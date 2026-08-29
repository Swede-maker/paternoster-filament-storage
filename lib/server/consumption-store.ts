import "server-only"
import { db } from "@/lib/db"
import type { PersistedState } from "@/lib/types"
import type { Decrement } from "./consumption"
import { dayKey, upsertConsumptionBucket } from "@/lib/statistics"

/**
 * Persist server-computed filament consumption to the shared system document,
 * atomically and independently of any browser.
 *
 * This is the write half of the Pi-side tracker: the poller computes grams from
 * live printer readings, and this applies them straight to the database so the
 * record advances even when no device has the app open.
 *
 * Atomicity matters because a browser may be saving at the same moment. We wrap
 * the read-modify-write in a single better-sqlite3 transaction and RE-READ the
 * latest row inside it, then apply the decrement *relative* to whatever is
 * currently stored. Because a decrement is a subtraction (not an absolute
 * overwrite), applying it to the freshest data is always correct — we never
 * clobber a concurrent edit to other fields. The version bump lets open browsers
 * notice the change and reconcile.
 */

interface StateRow {
  data: string
  version: number
}

/** A snapshot of a spool's remaining grams so a browser reconcile can tell that
 *  the value changed (used as the merge baseline on the client). */
export interface ConsumptionResult {
  version: number
  /** Total grams applied across all spools this write. */
  totalGrams: number
}

/**
 * Apply a batch of spool decrements. Returns the new version + total grams
 * applied, or null when there was nothing to write (no row, or no positive
 * decrement survived). Never throws to the caller's critical path — the poller
 * treats a thrown error as "skip this tick".
 */
export function applyConsumption(decrements: Decrement[]): ConsumptionResult | null {
  const positive = decrements.filter((d) => d.grams > 0)
  if (positive.length === 0) return null

  const txn = db.transaction((): ConsumptionResult | null => {
    const row = db.prepare("SELECT data, version FROM system_state WHERE id = 1").get() as StateRow | undefined
    if (!row) return null

    let state: PersistedState
    try {
      state = JSON.parse(row.data) as PersistedState
    } catch {
      return null // corrupt row — leave it for the app to recover, don't overwrite
    }

    const spools = state.spools ?? {}
    let applied = 0

    // Merge decrements by spool so several trays hitting the same spool combine,
    // keeping the printer identity (a loaded spool prints on one printer at a
    // time) so per-printer statistics stay attributable.
    const byspool = new Map<string, { grams: number; printerId: string; printerName: string }>()
    for (const d of positive) {
      const prev = byspool.get(d.spoolId)
      byspool.set(d.spoolId, {
        grams: (prev?.grams ?? 0) + d.grams,
        printerId: d.printerId ?? prev?.printerId ?? "",
        printerName: d.printerName ?? prev?.printerName ?? "",
      })
    }

    const today = dayKey()
    let log = Array.isArray(state.consumptionLog) ? state.consumptionLog : []

    for (const [spoolId, entry] of byspool) {
      const spool = spools[spoolId]
      if (!spool) continue // spool was deleted/unloaded since the poll — skip
      const before = typeof spool.grams === "number" ? spool.grams : 0
      const after = Math.max(0, before - entry.grams)
      if (after === before) continue
      spool.grams = after
      // Count only the grams that actually came off the spool toward the tally,
      // so hitting an already-empty spool doesn't inflate the lifetime total.
      const usedG = before - after
      applied += usedG
      // Record the day's consumption for the Statistik charts (accurate, written
      // even with no browser open). Attributed to the printer + this spool's
      // material/color.
      if (entry.printerId) {
        log = upsertConsumptionBucket(log, {
          day: today,
          printerId: entry.printerId,
          printerName: entry.printerName,
          material: spool.material,
          color: spool.color,
          colorName: spool.colorName,
          grams: usedG,
        })
      }
    }

    if (applied <= 0) return null

    state.consumptionLog = log

    // Advance the lifetime/resettable usage counter (tolerate older docs).
    const usage = state.usage ?? { currentG: 0, since: Date.now(), archived: [] }
    usage.currentG = (usage.currentG ?? 0) + applied
    state.usage = usage

    const json = JSON.stringify(state)
    const updated = db
      .prepare(
        `UPDATE system_state
           SET data = @data, version = version + 1, updated_at = datetime('now')
         WHERE id = 1
         RETURNING version`,
      )
      .get({ data: json }) as { version: number }

    return { version: updated?.version ?? row.version + 1, totalGrams: applied }
  })

  return txn()
}
