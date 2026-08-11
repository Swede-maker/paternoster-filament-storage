"use client"

import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"
import { Field, Input, Label, Select } from "./ui/field"
import { PresetCombobox } from "./preset-combobox"
import { SpoolDisc } from "./spool"
import {
  COLOR_PRESETS,
  allMaterials,
  allBrands,
  isLightColor,
  spoolFill,
  formatRemaining,
  formatGrams,
  nozzleTempFor,
} from "@/lib/filament"
import type { FilamentMaterial } from "@/lib/types"

export interface SpoolDraft {
  material: FilamentMaterial
  brand: string
  color: string
  colorName: string
  grams: number
  /** Full-spool weight (grams) used as the 100% reference. */
  capacity: number
  /** Optional recommended nozzle temperature (°C); enables toolchanger preheat. */
  nozzleTemp?: number
  /** Optional storage container / dry box this spool sits in (see Settings). */
  containerId?: string
}

export function emptyDraft(defaultGrams = 1000): SpoolDraft {
  return {
    material: "PLA",
    brand: "Generic",
    color: "#e02424",
    colorName: "Red",
    grams: defaultGrams,
    capacity: defaultGrams,
    nozzleTemp: nozzleTempFor("PLA"),
  }
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Change the material and re-suggest the nozzle temp, but only when the user
 * hasn't hand-tuned it (current temp still matches the old material's preset,
 * or is empty). This keeps a manual override sticky across material edits.
 */
function withMaterial(value: SpoolDraft, material: FilamentMaterial): Partial<SpoolDraft> {
  const untouched = value.nozzleTemp == null || value.nozzleTemp === nozzleTempFor(value.material)
  return untouched ? { material, nozzleTemp: nozzleTempFor(material) } : { material }
}

/** Full editor for a spool's attributes. Controlled via value/onChange. */
export function SpoolForm({
  value,
  onChange,
}: {
  value: SpoolDraft
  onChange: (d: SpoolDraft) => void
}) {
  const { state, dispatch } = useStore()
  const set = (patch: Partial<SpoolDraft>) => onChange({ ...value, ...patch })

  const materials = allMaterials(state.settings.customMaterials)
  const brands = allBrands(state.settings.customBrands)
  const containers = state.settings.containers ?? []

  // Normalize free-typed hex input to `#RRGGBB`.
  function setHex(raw: string) {
    let v = raw.replace(/[^#0-9a-fA-F]/g, "")
    if (!v.startsWith("#")) v = "#" + v
    v = "#" + v.slice(1).slice(0, 6)
    set({ color: v })
  }

  const validHex = HEX_RE.test(value.color)
  const isPreset = COLOR_PRESETS.some((c) => c.hex.toLowerCase() === value.color.toLowerCase())
  const pickerValue = validHex ? value.color : "#000000"
  const fill = spoolFill(value)

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <SpoolDisc color={validHex ? value.color : "#1c1c1e"} size={72} fill={fill} boxed={!!value.containerId} />
        <div className="min-w-0">
          <p
            className="truncate text-lg font-semibold"
            style={{ color: isLightColor(value.color) ? "#d4d4d8" : validHex ? value.color : "#d4d4d8" }}
          >
            {value.material || "Material"} · {value.colorName || "Unnamed"}
          </p>
          <p className="text-sm text-muted-foreground">
            {value.brand} · {formatRemaining(value)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Material / type">
          <PresetCombobox
            value={value.material}
            onChange={(v) => set(withMaterial(value, v))}
            options={materials}
            onSaveNew={(v) => {
              dispatch({ type: "ADD_PRESET", kind: "material", value: v })
              set(withMaterial(value, v))
            }}
            placeholder="e.g. PLA or your own"
            ariaLabel="Material or type"
          />
        </Field>
        <Field label="Brand">
          <PresetCombobox
            value={value.brand}
            onChange={(v) => set({ brand: v })}
            options={brands}
            onSaveNew={(v) => {
              dispatch({ type: "ADD_PRESET", kind: "brand", value: v })
              set({ brand: v })
            }}
            placeholder="Manufacturer"
            ariaLabel="Brand"
          />
        </Field>
      </div>

      <div>
        <Label>Color</Label>
        <div className="flex flex-wrap gap-2">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c.hex}
              type="button"
              title={c.name}
              onClick={() => set({ color: c.hex, colorName: c.name })}
              className={cn(
                "h-9 w-9 rounded-full border-2 transition-transform hover:scale-110",
                value.color.toLowerCase() === c.hex.toLowerCase() ? "border-primary" : "border-black/40",
              )}
              style={{ backgroundColor: c.hex }}
              aria-label={c.name}
            />
          ))}
        </div>

        {/* Custom hex color: swatch/native picker + text field */}
        <div className="mt-3 flex items-center gap-2">
          <label
            className="relative h-11 w-12 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 border-black/40"
            style={{ backgroundColor: validHex ? value.color : "transparent" }}
            title="Pick a custom color"
          >
            <input
              type="color"
              value={pickerValue}
              onChange={(e) => set({ color: e.target.value })}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              aria-label="Custom color picker"
            />
          </label>
          <Input
            value={value.color}
            onChange={(e) => setHex(e.target.value)}
            placeholder="#RRGGBB"
            spellCheck={false}
            className={cn("font-mono uppercase", !validHex && "border-warning focus-visible:ring-warning")}
            aria-label="Hex color"
          />
          {isPreset && validHex ? (
            <span className="shrink-0 text-xs text-muted-foreground">Preset</span>
          ) : validHex ? (
            <span className="shrink-0 text-xs text-primary">Custom</span>
          ) : null}
        </div>
        {!validHex && <p className="mt-1 text-xs text-warning">Enter a 6-digit hex like #1e88e5.</p>}
      </div>

      <Field label="Color name">
        <Input
          value={value.colorName}
          onChange={(e) => set({ colorName: e.target.value })}
          placeholder="e.g. Galaxy Red"
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Full spool weight (grams)">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={5000}
            value={value.capacity}
            onChange={(e) => {
              const cap = Math.max(1, Number.parseInt(e.target.value) || 0)
              // Keep remaining within the new full weight.
              set({ capacity: cap, grams: Math.min(value.grams, cap) })
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">Weight of a brand-new spool (the 100% mark).</p>
        </Field>
        <Field label="Remaining (grams)">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={value.capacity}
            value={value.grams}
            onChange={(e) =>
              set({ grams: Math.max(0, Math.min(value.capacity, Number.parseInt(e.target.value) || 0)) })
            }
          />
          <p className="mt-1 text-xs text-muted-foreground">{Math.round(fill * 100)}% left on the spool.</p>
        </Field>
      </div>

      <Field label="Nozzle temperature (optional)">
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            min={150}
            max={350}
            value={value.nozzleTemp ?? ""}
            onChange={(e) => {
              const raw = e.target.value.trim()
              set({ nozzleTemp: raw === "" ? undefined : Math.max(0, Number.parseInt(raw) || 0) })
            }}
            placeholder={`e.g. ${nozzleTempFor(value.material)}`}
          />
          <span className="text-sm text-muted-foreground">°C</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Used to auto-preheat a Marlin/Klipper toolchanger when this spool is loaded.
        </p>
      </Field>

      <Field label="Storage container / dry box (optional)">
        <Select
          value={value.containerId ?? ""}
          onChange={(e) => set({ containerId: e.target.value || undefined })}
          aria-label="Storage container"
        >
          <option value="">No container (bare spool)</option>
          {containers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} (+{formatGrams(c.weightGrams)})
            </option>
          ))}
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">
          {containers.length === 0
            ? "Set up dry boxes in Settings → Storage containers to select one here."
            : "The container's weight is added when balancing the carousel."}
        </p>
      </Field>
    </div>
  )
}
