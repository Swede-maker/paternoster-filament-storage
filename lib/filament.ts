import type { FilamentMaterial, Printer, Spool } from "./types"

export const MATERIALS: FilamentMaterial[] = [
  "PLA",
  "PETG",
  "ABS",
  "ASA",
  "TPU",
  "PC",
  "Nylon",
  "PVA",
  "HIPS",
  "PLA-CF",
  "PETG-CF",
  "Other",
]

export const COMMON_BRANDS = [
  "Generic",
  "Prusament",
  "Polymaker",
  "Overture",
  "Sunlu",
  "eSun",
  "Hatchbox",
  "ColorFabb",
  "Fillamentum",
  "MatterHackers",
]

/** A palette of common filament colors for quick selection. */
export const COLOR_PRESETS: { name: string; hex: string }[] = [
  { name: "Black", hex: "#1c1c1e" },
  { name: "White", hex: "#f4f4f5" },
  { name: "Silver", hex: "#b8bcc2" },
  { name: "Gray", hex: "#6b7280" },
  { name: "Red", hex: "#e02424" },
  { name: "Orange", hex: "#f97316" },
  { name: "Yellow", hex: "#facc15" },
  { name: "Green", hex: "#22c55e" },
  { name: "Teal", hex: "#14b8a6" },
  { name: "Blue", hex: "#2563eb" },
  { name: "Sky", hex: "#38bdf8" },
  { name: "Purple", hex: "#8b5cf6" },
  { name: "Magenta", hex: "#d946ef" },
  { name: "Pink", hex: "#ec4899" },
  { name: "Brown", hex: "#92400e" },
  { name: "Gold", hex: "#d4af37" },
]

export const MAX_PRINTERS = 10

/**
 * Typical hotend temperature (°C) by material, used to prefill the optional
 * nozzle-temp field when adding a spool. These are mid-range starting points;
 * the user can always override. Unknown materials fall back to 210.
 */
const NOZZLE_TEMP_PRESETS: Record<string, number> = {
  PLA: 210,
  PETG: 240,
  ABS: 245,
  ASA: 245,
  TPU: 225,
  PC: 270,
  Nylon: 260,
  PVA: 200,
  HIPS: 240,
  "PLA-CF": 220,
  "PETG-CF": 250,
}

/** Suggested nozzle temperature for a material name (case-insensitive). */
export function nozzleTempFor(material: string): number {
  if (!material) return 210
  const hit = Object.keys(NOZZLE_TEMP_PRESETS).find((k) => k.toLowerCase() === material.toLowerCase())
  return hit ? NOZZLE_TEMP_PRESETS[hit] : 210
}

/** Target carousel speed found/assumed by calibration, in seconds per shelf. */
export const DEFAULT_SEC_PER_SHELF = 3.5
/** Bounds the manual speed slider (fast … slow), in seconds per shelf. */
export const MIN_SEC_PER_SHELF = 1.5
export const MAX_SEC_PER_SHELF = 8

/**
 * Convert a real-world carousel speed (seconds per shelf) into the on-screen
 * per-shelf animation duration (ms). Scaled so the 3.5 s target maps to the
 * app's original 420 ms feel, and clamped so extreme speeds stay watchable.
 */
export function secPerShelfToStepMs(secPerShelf: number | undefined): number {
  const sec = secPerShelf && secPerShelf > 0 ? secPerShelf : DEFAULT_SEC_PER_SHELF
  return Math.round(Math.min(1200, Math.max(150, sec * 120)))
}

/** Default soft start/stop ramp intensity (%) for a new/uncalibrated carousel. */
export const DEFAULT_RAMP_PCT = 40
/** How much the ends of a move can be slowed at full ramp (2.5x base delay). */
const RAMP_MAX_STRENGTH = 1.5

/**
 * Per-step animation delay (ms) for a soft start/stop ramp. Given the base
 * per-shelf time and where we are within a multi-shelf move (`stepIndex` of
 * `totalSteps`), slow the first and last steps and run full speed through the
 * middle — an ease-in/ease-out velocity profile. `rampPct` (0–100) sets how
 * pronounced the easing is; 0 (or a single-shelf move) returns the base time.
 */
export function rampStepMs(baseMs: number, stepIndex: number, totalSteps: number, rampPct: number): number {
  if (totalSteps <= 1 || rampPct <= 0) return baseMs
  const p = (stepIndex + 0.5) / totalSteps // 0..1 position across the move
  const strength = Math.max(0, Math.min(1, rampPct / 100)) * RAMP_MAX_STRENGTH
  // sin(pi*p) is 0 at the ends and 1 in the middle, so (1 - sin) slows the ends.
  const shape = 1 - Math.sin(Math.PI * p)
  return Math.round(baseMs * (1 + strength * shape))
}

/**
 * A calibration-derived soft start/stop ramp: faster carousels (fewer
 * seconds/shelf) get more easing to avoid jerk, slower ones get less. Mapped
 * across the speed slider's bounds and clamped to a sensible 25–70% band.
 */
export function autoRampPct(secPerShelf: number): number {
  const span = MAX_SEC_PER_SHELF - MIN_SEC_PER_SHELF
  const t = Math.max(0, Math.min(1, (secPerShelf - MIN_SEC_PER_SHELF) / span)) // 0 fast … 1 slow
  return Math.round(70 - t * (70 - 25))
}

/** Total number of loadable slots for a printer based on its kind. */
export function printerSlotCount(p: Pick<Printer, "kind" | "amsUnits" | "slotsPerAms" | "toolheads">): number {
  switch (p.kind) {
    case "single":
      return 1
    case "ams":
      return Math.max(1, p.amsUnits) * Math.max(1, p.slotsPerAms)
    case "toolchanger":
      return Math.max(1, p.toolheads)
    default:
      return 1
  }
}

/** Returns true when a color is light enough that it needs dark text on top. */
export function isLightColor(hex: string): boolean {
  const c = hex.replace("#", "")
  if (c.length < 6) return false
  const r = Number.parseInt(c.slice(0, 2), 16)
  const g = Number.parseInt(c.slice(2, 4), 16)
  const b = Number.parseInt(c.slice(4, 6), 16)
  // Perceived luminance
  const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return l > 0.7
}

export function newId(prefix = "id"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`
}

export function formatGrams(g: number): string {
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`
  return `${Math.round(g)} g`
}

/** De-duplicated union of the built-in list and the user's saved custom names. */
function mergeUnique(builtin: string[], custom: string[] = []): string[] {
  const seen = new Set(builtin.map((b) => b.toLowerCase()))
  const extra = custom.filter((c) => c && !seen.has(c.toLowerCase()))
  return [...builtin, ...extra]
}

export function allMaterials(custom: string[] = []): string[] {
  return mergeUnique(MATERIALS, custom)
}

export function allBrands(custom: string[] = []): string[] {
  return mergeUnique(COMMON_BRANDS, custom)
}

/** Fraction of filament remaining (0–1) relative to the spool's full weight. */
export function spoolFill(spool: Pick<Spool, "grams" | "capacity">): number {
  const cap = spool.capacity && spool.capacity > 0 ? spool.capacity : spool.grams
  if (!cap || cap <= 0) return 1
  return Math.max(0, Math.min(1, spool.grams / cap))
}

/** "220 / 500 g" when a full-spool weight is known, else just the remaining. */
export function formatRemaining(spool: Pick<Spool, "grams" | "capacity">): string {
  if (spool.capacity && spool.capacity > 0 && Math.round(spool.capacity) !== Math.round(spool.grams)) {
    return `${Math.round(spool.grams)} / ${Math.round(spool.capacity)} g`
  }
  return formatGrams(spool.grams)
}
