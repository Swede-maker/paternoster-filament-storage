import type { AppState, Dryer, DryerChamber, DryerTimer } from "./types"

export const MAX_DRYER_CHAMBERS = 12
export const MAX_CHAMBER_CAPACITY = 12

export function dryerCapacity(d: Dryer): number {
  return d.chambers.reduce((sum, c) => sum + c.capacity, 0)
}

export function dryerOccupancy(d: Dryer): number {
  return d.chambers.reduce((sum, c) => sum + c.spoolIds.length, 0)
}

/** Free places in a chamber after subtracting spools already queued for it. */
export function chamberRoom(c: DryerChamber, queued = 0): number {
  return Math.max(0, c.capacity - c.spoolIds.length - queued)
}

export type TimerStatus = "none" | "running" | "done"

export function timerStatus(t: DryerTimer | undefined, now: number): TimerStatus {
  if (!t) return "none"
  return now < t.startedAt + t.durationMin * 60_000 ? "running" : "done"
}

export function timerRemainingMs(t: DryerTimer, now: number): number {
  return Math.max(0, t.startedAt + t.durationMin * 60_000 - now)
}

export function formatDuration(ms: number): string {
  const totalMin = Math.ceil(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function getDryers(state: AppState): Dryer[] {
  return state.settings.dryers ?? []
}

export function withDryers(state: AppState, dryers: Dryer[]): AppState {
  return { ...state, settings: { ...state.settings, dryers } }
}

/** Where a spool currently sits in a dryer, if anywhere. */
export function findSpoolInDryer(
  state: AppState,
  spoolId: string,
): { dryer: Dryer; chamber: DryerChamber; chamberIndex: number } | null {
  for (const dryer of getDryers(state)) {
    const chamberIndex = dryer.chambers.findIndex((c) => c.spoolIds.includes(spoolId))
    if (chamberIndex >= 0) return { dryer, chamber: dryer.chambers[chamberIndex], chamberIndex }
  }
  return null
}

/** Remove the given spools from every dryer (and from any awaiting-load list). */
export function stripSpoolsFromDryers(dryers: Dryer[], ids: Set<string>): Dryer[] {
  let changed = false
  const next = dryers.map((d) => {
    const touches =
      d.chambers.some((c) => c.spoolIds.some((s) => ids.has(s))) || (d.awaitingLoad ?? []).some((s) => ids.has(s))
    if (!touches) return d
    changed = true
    const chambers = d.chambers.map((c) => {
      const spoolIds = c.spoolIds.filter((s) => !ids.has(s))
      // An emptied chamber has nothing left to dry.
      return spoolIds.length === 0 ? { ...c, spoolIds, timer: undefined } : { ...c, spoolIds }
    })
    const awaitingLoad = (d.awaitingLoad ?? []).filter((s) => !ids.has(s))
    return { ...d, chambers, awaitingLoad }
  })
  return changed ? next : dryers
}

/**
 * Put a picked spool into a dryer chamber, waiting for the operator to place
 * it. Falls back to any chamber of the same dryer with room; returns the
 * dryers unchanged when the dryer is full or gone.
 */
export function addSpoolToDryer(dryers: Dryer[], dryerId: string, chamberId: string | undefined, spoolId: string): Dryer[] {
  const cleaned = stripSpoolsFromDryers(dryers, new Set([spoolId]))
  return cleaned.map((d) => {
    if (d.id !== dryerId) return d
    let idx = d.chambers.findIndex((c) => c.id === chamberId && chamberRoom(c) > 0)
    if (idx < 0) idx = d.chambers.findIndex((c) => chamberRoom(c) > 0)
    if (idx < 0) return d
    const chambers = d.chambers.map((c, i) => (i === idx ? { ...c, spoolIds: [...c.spoolIds, spoolId] } : c))
    return { ...d, chambers, awaitingLoad: [...(d.awaitingLoad ?? []), spoolId] }
  })
}

/**
 * A spool can only be in one place. When a spool lands in a storage slot or a
 * printer, drop it from any dryer it was in (this is how "take out of the
 * dryer and store it" commits, whatever path stored it).
 */
export function reconcileDryers(state: AppState): AppState {
  const dryers = getDryers(state)
  if (!dryers.some((d) => d.chambers.some((c) => c.spoolIds.length > 0))) return state
  const inDryers = new Set<string>()
  for (const d of dryers) for (const c of d.chambers) for (const s of c.spoolIds) inDryers.add(s)
  const placed = new Set<string>()
  for (const n of state.nodes) for (const row of n.slots) for (const s of row) if (s && inDryers.has(s)) placed.add(s)
  for (const p of state.printers) for (const s of p.loaded) if (s && inDryers.has(s)) placed.add(s)
  for (const s of inDryers) if (!state.spools[s]) placed.add(s)
  if (placed.size === 0) return state
  return withDryers(state, stripSpoolsFromDryers(dryers, placed))
}
