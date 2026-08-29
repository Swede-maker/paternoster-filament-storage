import type { ConsumptionBucket, StorageSnapshot } from "./types"

/**
 * Pure helpers for the Statistik tab. Kept free of React and `server-only` so
 * both the server-side consumption writer and the client charts share the exact
 * same bucketing + aggregation logic.
 */

/** Local calendar day as YYYY-MM-DD (not UTC — days should match the wall clock). */
export function dayKey(d: Date | number = new Date()): string {
  const date = typeof d === "number" ? new Date(d) : d
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** Parse a YYYY-MM-DD day key back to a Date at local midnight. */
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

/** Composite identity of a consumption bucket: one row per day+printer+material+color. */
function bucketKey(b: Pick<ConsumptionBucket, "day" | "printerId" | "material" | "color">): string {
  return `${b.day}|${b.printerId}|${b.material}|${b.color}`
}

/**
 * Add grams into the matching daily bucket (creating it if absent), returning a
 * new array. Oldest buckets are trimmed past `cap` so the synced document stays
 * small. Callers pass whole-number-ish gram deltas; we keep one decimal.
 */
export function upsertConsumptionBucket(
  log: ConsumptionBucket[],
  entry: ConsumptionBucket,
  cap = 5000,
): ConsumptionBucket[] {
  if (!(entry.grams > 0)) return log
  const key = bucketKey(entry)
  const next = [...log]
  const idx = next.findIndex((b) => bucketKey(b) === key)
  if (idx >= 0) {
    next[idx] = { ...next[idx], grams: Math.round((next[idx].grams + entry.grams) * 10) / 10 }
  } else {
    next.push({ ...entry, grams: Math.round(entry.grams * 10) / 10 })
  }
  // Trim oldest-first (by day) when over the cap.
  if (next.length > cap) {
    next.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    return next.slice(next.length - cap)
  }
  return next
}

/** A from/to day range, inclusive, expressed as YYYY-MM-DD keys. */
export interface DayRange {
  from: string
  to: string
}

/** Build the range for a named preset relative to `now`. */
export function presetRange(
  preset: "7d" | "30d" | "month" | "year" | "all",
  now: Date = new Date(),
): DayRange {
  const to = dayKey(now)
  if (preset === "all") return { from: "0000-01-01", to }
  if (preset === "month") return { from: dayKey(new Date(now.getFullYear(), now.getMonth(), 1)), to }
  if (preset === "year") return { from: dayKey(new Date(now.getFullYear(), 0, 1)), to }
  const days = preset === "7d" ? 6 : 29
  const start = new Date(now)
  start.setDate(start.getDate() - days)
  return { from: dayKey(start), to }
}

/** Whether a day key falls inside an inclusive range. */
export function inRange(day: string, range: DayRange): boolean {
  return day >= range.from && day <= range.to
}

/** Filter buckets by day range and (optionally) a single printer id. */
export function filterBuckets(
  log: ConsumptionBucket[],
  range: DayRange,
  printerId?: string | null,
): ConsumptionBucket[] {
  return log.filter(
    (b) => inRange(b.day, range) && (!printerId || printerId === "all" || b.printerId === printerId),
  )
}

/** Sum grams grouped by an arbitrary key selector, sorted descending by grams. */
export function sumBy<K extends string>(
  buckets: ConsumptionBucket[],
  key: (b: ConsumptionBucket) => K,
  label?: (b: ConsumptionBucket) => string,
): { key: K; label: string; grams: number }[] {
  const map = new Map<K, { label: string; grams: number }>()
  for (const b of buckets) {
    const k = key(b)
    const prev = map.get(k)
    map.set(k, { label: label ? label(b) : k, grams: (prev?.grams ?? 0) + b.grams })
  }
  return [...map.entries()]
    .map(([k, v]) => ({ key: k, label: v.label, grams: Math.round(v.grams * 10) / 10 }))
    .sort((a, b) => b.grams - a.grams)
}

/** Total grams across a set of buckets. */
export function totalGrams(buckets: ConsumptionBucket[]): number {
  return Math.round(buckets.reduce((s, b) => s + b.grams, 0) * 10) / 10
}

/**
 * Daily totals across the range (one point per day that has data), for a line
 * or area chart. Days with no consumption are omitted; the chart connects them.
 */
export function dailyTotals(buckets: ConsumptionBucket[]): { day: string; grams: number }[] {
  const map = new Map<string, number>()
  for (const b of buckets) map.set(b.day, (map.get(b.day) ?? 0) + b.grams)
  return [...map.entries()]
    .map(([day, grams]) => ({ day, grams: Math.round(grams * 10) / 10 }))
    .sort((a, b) => (a.day < b.day ? -1 : 1))
}

/** Storage snapshots filtered to a range, oldest-first for the time chart. */
export function snapshotsInRange(snaps: StorageSnapshot[], range: DayRange): StorageSnapshot[] {
  return snaps.filter((s) => inRange(s.day, range)).sort((a, b) => (a.day < b.day ? -1 : 1))
}
