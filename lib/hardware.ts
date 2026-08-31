import type { AppState, HardwareCategory } from "./types"

/**
 * Built-in slot colors for hardware boxes. These are always offered in the color
 * picker; the user's saved presets (settings.hardwareColorPresets) are shown in
 * addition to these. Kept to a small, distinct set so boxes stay recognizable.
 */
export const DEFAULT_HARDWARE_COLORS: { name: string; hex: string }[] = [
  { name: "Steel Blue", hex: "#4a72a8" },
  { name: "Zinc", hex: "#8a8f98" },
  { name: "Brass", hex: "#b08d43" },
  { name: "Copper", hex: "#b06a4a" },
  { name: "Graphite", hex: "#3f4247" },
  { name: "Signal Red", hex: "#c0453f" },
  { name: "Forest", hex: "#4a8a5c" },
  { name: "Amber", hex: "#c99a3f" },
]

/** Alias kept for components that import the built-in swatch list by this name. */
export const HARDWARE_COLORS = DEFAULT_HARDWARE_COLORS

/** Built-in starter categories so a fresh install isn't empty. */
export const DEFAULT_HARDWARE_CATEGORIES = [
  "Bolts",
  "Nuts",
  "Washers",
  "Screws",
  "Threaded Inserts",
  "Springs",
  "Bearings",
  "Electronics",
]

/** All color presets to show: built-ins first, then the user's saved ones. */
export function hardwareColors(state: AppState): { name: string; hex: string }[] {
  const saved = state.settings.hardwareColorPresets ?? []
  const seen = new Set(DEFAULT_HARDWARE_COLORS.map((c) => c.hex.toLowerCase()))
  return [...DEFAULT_HARDWARE_COLORS, ...saved.filter((c) => !seen.has(c.hex.toLowerCase()))]
}

/** All category names to offer: user's saved categories, else the defaults. */
export function hardwareCategoryNames(state: AppState): string[] {
  const saved = (state.settings.hardwareCategories ?? []).map((c) => c.name)
  if (saved.length > 0) return saved
  return DEFAULT_HARDWARE_CATEGORIES
}

/** Resolve a color name for a hex, falling back to the hex itself. */
export function colorNameFor(state: AppState, hex: string): string {
  const match = hardwareColors(state).find((c) => c.hex.toLowerCase() === hex.toLowerCase())
  return match?.name ?? hex
}

/** Parse comma/space separated tags into a clean, de-duplicated list. */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)) {
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/** Make a HardwareCategory record with a fresh id. */
export function makeCategory(name: string): HardwareCategory {
  return { id: `hcat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: name.trim() }
}
