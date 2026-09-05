import type { AmsUnit, FilamentMaterial, Printer, Spool } from "./types"

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

/**
 * Typical solid density (g/cm³) by material, used to convert firmware-reported
 * filament length into consumed mass for live weight tracking. Mid-range
 * published values; the user can override per spool. Unknown → PLA (1.24).
 */
export const MATERIAL_DENSITY: Record<string, number> = {
  PLA: 1.24,
  PETG: 1.27,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.21,
  PC: 1.2,
  Nylon: 1.14,
  PVA: 1.23,
  HIPS: 1.04,
  "PLA-CF": 1.29,
  "PETG-CF": 1.3,
}

/** Fallback density (g/cm³) when a material isn't in the table. */
export const DEFAULT_DENSITY = 1.24
/** Default filament diameter (mm). */
export const DEFAULT_DIAMETER = 1.75

/** Density (g/cm³) for a material name (case-insensitive), with fallback. */
export function densityFor(material: string): number {
  if (!material) return DEFAULT_DENSITY
  const hit = Object.keys(MATERIAL_DENSITY).find((k) => k.toLowerCase() === material.toLowerCase())
  return hit ? MATERIAL_DENSITY[hit] : DEFAULT_DENSITY
}

/**
 * Convert a filament length (mm) into mass (g) for a solid cylinder of the given
 * diameter (mm) and density (g/cm³). Volume = π·r²·L; mm³→cm³ divides by 1000.
 */
export function lengthToGrams(mm: number, diameterMm = DEFAULT_DIAMETER, density = DEFAULT_DENSITY): number {
  const r = diameterMm / 2 / 10 // mm → cm
  const lengthCm = mm / 10
  const volumeCm3 = Math.PI * r * r * lengthCm
  return volumeCm3 * density
}

/** Effective density for a spool: its explicit value, else material default. */
export function spoolDensity(spool: Pick<Spool, "density" | "material">): number {
  return spool.density && spool.density > 0 ? spool.density : densityFor(spool.material)
}

/** Effective diameter for a spool: its explicit value, else the default. */
export function spoolDiameter(spool: Pick<Spool, "diameter">, fallback = DEFAULT_DIAMETER): number {
  return spool.diameter && spool.diameter > 0 ? spool.diameter : fallback
}

/**
 * Motor speed is expressed ONLY as a PWM duty cycle (0..1) — the unit the
 * BTS7960 driver actually understands.
 *
 * The old seconds-per-shelf model and its conversion curves are gone. They
 * described speed as a duration, which meant the app held two competing ideas of
 * how fast the carousel turns, and the curve clamped away the low duties (it
 * bottomed out at 25%) that a heavy carousel needs to stop coasting past the
 * sensor flag. Nothing derives position from elapsed time: the carousel knows
 * where it is from homing plus shelf-sensor pulses.
 */

/** Lowest duty the PWM slider can request. */
export const MIN_PWM_DUTY = 0.05
/** Duty used when the operator has not set one yet. */
export const DEFAULT_PWM_DUTY = 0.45

/** The duty a move runs at. */
export function moveDutyFor(node: { pwmDuty?: number }): number {
  const duty = typeof node.pwmDuty === "number" && node.pwmDuty > 0 ? node.pwmDuty : DEFAULT_PWM_DUTY
  return Math.round(Math.max(MIN_PWM_DUTY, Math.min(1, duty)) * 100) / 100
}

/** Homing duty as a fraction of the move duty, when not set explicitly. */
export const HOMING_DUTY_RATIO = 0.65

/**
 * The duty homing runs at.
 *
 * An explicit `homingDuty` wins. Otherwise it falls back to a fraction of the
 * move duty, so dialling the carousel down also slows homing — without that
 * coupling, homing would keep flying past the index flag at the old speed.
 *
 * The override exists because the ratio is only a guess at the relationship
 * between two different searches: a move counts shelf flags whose spacing is
 * known, while homing hunts a single index flag from an unknown start. On a
 * heavy carousel the fraction that suits moves is still too fast to catch the
 * index flag, and homing overshoot is the worst kind — every subsequent
 * position is measured from it.
 */
export function homingDutyFor(node: { pwmDuty?: number; homingDuty?: number }): number {
  const explicit = node.homingDuty
  const duty =
    typeof explicit === "number" && explicit > 0 ? explicit : moveDutyFor(node) * HOMING_DUTY_RATIO
  return Math.round(Math.max(MIN_PWM_DUTY, Math.min(1, duty)) * 100) / 100
}

/**
 * Default slow-approach duty for the final/target shelf.
 *
 * This is the speed the carousel crawls at as it arrives, so the target flag is
 * caught gently instead of overshot. 0.25 matches the agent's MIN_DUTY — the
 * slowest duty that still reliably turns the motor.
 */
export const DEFAULT_APPROACH_DUTY = 0.25

/**
 * The duty the final approach onto the target shelf runs at.
 *
 * An explicit `approachDuty` wins; otherwise it falls back to the default crawl.
 * It is capped at the move duty — approaching FASTER than the cruise would be
 * pointless and would defeat the gentle-arrival purpose — and floored at
 * MIN_PWM_DUTY so the slider can go as slow as the motor allows.
 */
export function approachDutyFor(node: { pwmDuty?: number; approachDuty?: number }): number {
  const explicit = node.approachDuty
  const duty = typeof explicit === "number" && explicit > 0 ? explicit : DEFAULT_APPROACH_DUTY
  const capped = Math.min(duty, moveDutyFor(node))
  return Math.round(Math.max(MIN_PWM_DUTY, Math.min(1, capped)) * 100) / 100
}

/**
 * Weight compensation — keeps the carousel's real speed roughly constant as
 * spools are added or removed.
 *
 * The three duty sliders (move, homing, approach) are the operator's BASE
 * values, tuned for whatever load the carousel had at the time. Every kilogram
 * added afterwards makes the same duty turn a little slower. Two knobs define
 * the curve: every `loadCompKg` of load adds `loadCompPct` percent of duty. The
 * boost is applied to all three duties at the moment they are sent to the Pi,
 * and it tracks the live load so it falls again when the carousel gets lighter.
 */
export const MIN_LOAD_COMP_KG = 0.5
export const MAX_LOAD_COMP_KG = 10
export const MIN_LOAD_COMP_PCT = 1
export const MAX_LOAD_COMP_PCT = 10
/** Percent per step assumed for nodes saved before the step was adjustable. */
export const DEFAULT_LOAD_COMP_PCT = 1
/** Never let compensation push a duty past this (as a fraction). */
const MAX_BOOSTED_DUTY = 1

/**
 * Boost in whole percent for a carousel carrying `loadGrams`, or 0 when
 * compensation is off. Linear: (load / kgPerStep) * pctPerStep, rounded so the
 * value the operator reads on screen is exactly what is added to the duty.
 */
export function loadBoostPctFor(node: { loadCompKg?: number; loadCompPct?: number }, loadGrams: number): number {
  const kg = node.loadCompKg
  if (typeof kg !== "number" || kg <= 0 || !Number.isFinite(loadGrams) || loadGrams <= 0) return 0
  const kgPerStep = Math.max(MIN_LOAD_COMP_KG, Math.min(MAX_LOAD_COMP_KG, kg))
  const pctPerStep = Math.max(
    MIN_LOAD_COMP_PCT,
    Math.min(MAX_LOAD_COMP_PCT, node.loadCompPct ?? DEFAULT_LOAD_COMP_PCT),
  )
  return Math.round((loadGrams / 1000 / kgPerStep) * pctPerStep)
}

/** A base duty (0..1) with the load boost added, capped at 100%. */
export function boostDuty(baseDuty: number, boostPct: number): number {
  const boosted = baseDuty + boostPct / 100
  return Math.round(Math.max(MIN_PWM_DUTY, Math.min(MAX_BOOSTED_DUTY, boosted)) * 100) / 100
}

/** Default soft START ramp intensity (%) for a new carousel. */
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
 * Normalised AMS units for a printer. When the printer carries the richer
 * `ams` array (mixed, named units) that is the source of truth; otherwise we
 * synthesise a uniform layout from the legacy `amsUnits`/`slotsPerAms` fields so
 * every consumer can treat AMS printers the same way.
 */
export function printerAmsUnits(
  p: Pick<Printer, "ams" | "amsUnits" | "slotsPerAms">,
): AmsUnit[] {
  if (p.ams && p.ams.length > 0) {
    return p.ams.map((u, i) => ({
      id: u.id || `ams-${i + 1}`,
      name: u.name?.trim() || `AMS ${i + 1}`,
      slots: Math.max(1, Math.floor(u.slots)),
    }))
  }
  const count = Math.max(1, p.amsUnits)
  const per = Math.max(1, p.slotsPerAms)
  return Array.from({ length: count }, (_, i) => ({
    id: `ams-${i + 1}`,
    name: `AMS ${i + 1}`,
    slots: per,
  }))
}

/** Total number of loadable slots for a printer based on its kind. */
export function printerSlotCount(
  p: Pick<Printer, "kind" | "ams" | "amsUnits" | "slotsPerAms" | "toolheads">,
): number {
  switch (p.kind) {
    case "single":
      return 1
    case "ams":
      return printerAmsUnits(p).reduce((sum, u) => sum + u.slots, 0)
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
