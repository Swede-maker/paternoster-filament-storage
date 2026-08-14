"use client"

import { useState } from "react"
import { Barcode, Save } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"
import { Field, Input, Label, Select } from "./ui/field"
import { PresetCombobox } from "./preset-combobox"
import { SpoolDisc } from "./spool"
import { BarcodeScanner } from "./barcode-scanner"
import {
  COLOR_PRESETS,
  allMaterials,
  allBrands,
  isLightColor,
  spoolFill,
  formatRemaining,
  formatGrams,
  nozzleTempFor,
  densityFor,
  newId,
  DEFAULT_DIAMETER,
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
  /** Material density (g/cm³) for live weight tracking. Defaults from material. */
  density?: number
  /** Filament diameter (mm). Defaults to the system default (1.75). */
  diameter?: number
  /** How many identical spools to create (create/place flows). Defaults to 1. */
  quantity?: number
  /** Scanned barcode string, if the draft was populated/matched by a scan. */
  barcode?: string
}

export function emptyDraft(defaultGrams = 1000, defaultDiameter = DEFAULT_DIAMETER): SpoolDraft {
  return {
    material: "PLA",
    brand: "Generic",
    color: "#e02424",
    colorName: "Red",
    grams: defaultGrams,
    capacity: defaultGrams,
    nozzleTemp: nozzleTempFor("PLA"),
    density: densityFor("PLA"),
    diameter: defaultDiameter,
    quantity: 1,
  }
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Change the material and re-suggest the nozzle temp, but only when the user
 * hasn't hand-tuned it (current temp still matches the old material's preset,
 * or is empty). This keeps a manual override sticky across material edits.
 */
function withMaterial(value: SpoolDraft, material: FilamentMaterial): Partial<SpoolDraft> {
  const tempUntouched = value.nozzleTemp == null || value.nozzleTemp === nozzleTempFor(value.material)
  // Re-suggest density unless the user hand-tuned it away from the old default.
  const densityUntouched = value.density == null || value.density === densityFor(value.material)
  const patch: Partial<SpoolDraft> = { material }
  if (tempUntouched) patch.nozzleTemp = nozzleTempFor(material)
  if (densityUntouched) patch.density = densityFor(material)
  return patch
}

/** Full editor for a spool's attributes. Controlled via value/onChange. */
export function SpoolForm({
  value,
  onChange,
  showProfiles = false,
  showQuantity = false,
  showBarcode = false,
}: {
  value: SpoolDraft
  onChange: (d: SpoolDraft) => void
  /** Show the saved-profile picker + "Save as profile" action (create flows). */
  showProfiles?: boolean
  /** Show the quantity stepper (create/place flows that support batches). */
  showQuantity?: boolean
  /** Show the "Scan barcode" action and apply matched profiles (create flows). */
  showBarcode?: boolean
}) {
  const { state, dispatch } = useStore()
  const set = (patch: Partial<SpoolDraft>) => onChange({ ...value, ...patch })

  const materials = allMaterials(state.settings.customMaterials)
  const brands = allBrands(state.settings.customBrands)
  const containers = state.settings.containers ?? []
  const profiles = state.settings.filamentProfiles ?? []
  const barcodes = state.settings.barcodes ?? []
  const defaultDiameter = state.settings.defaultDiameter ?? DEFAULT_DIAMETER

  const [scannerOpen, setScannerOpen] = useState(false)
  const [scanNote, setScanNote] = useState<string | null>(null)

  /** Apply a saved profile's attributes to the current draft (keeps quantity). */
  function applyProfile(id: string) {
    const p = profiles.find((x) => x.id === id)
    if (!p) return
    set({
      material: p.material,
      brand: p.brand,
      color: p.color,
      colorName: p.colorName,
      capacity: p.capacity,
      grams: p.capacity,
      nozzleTemp: p.nozzleTemp,
      density: p.density ?? densityFor(p.material),
      diameter: p.diameter ?? defaultDiameter,
      containerId: p.containerId,
    })
  }

  /** Save the current draft as a reusable profile. */
  function saveProfile() {
    const name = value.colorName ? `${value.brand} ${value.material} · ${value.colorName}` : `${value.brand} ${value.material}`
    dispatch({
      type: "ADD_PROFILE",
      profile: {
        id: newId("profile"),
        name,
        material: value.material,
        brand: value.brand,
        color: value.color,
        colorName: value.colorName,
        capacity: value.capacity,
        nozzleTemp: value.nozzleTemp,
        density: value.density,
        diameter: value.diameter,
        containerId: value.containerId,
      },
    })
    setScanNote(`Saved profile "${name}".`)
  }

  /** Handle a scanned barcode: apply a mapped profile if one exists. */
  function onScan(code: string) {
    setScannerOpen(false)
    const mapping = barcodes.find((b) => b.code === code)
    if (mapping) {
      applyProfile(mapping.profileId)
      const p = profiles.find((x) => x.id === mapping.profileId)
      setScanNote(p ? `Applied "${p.name}" from barcode.` : "Applied barcode profile.")
    } else {
      setScanNote(`Barcode ${code} isn't linked to a profile yet — map it in Settings.`)
    }
    set({ barcode: code })
  }

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

      {(showProfiles || showBarcode) && (
        <div className="space-y-2 rounded-xl border border-border bg-background/40 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {showProfiles && (
              <Select
                value=""
                onChange={(e) => e.target.value && applyProfile(e.target.value)}
                aria-label="Apply a saved profile"
                className="flex-1"
              >
                <option value="">
                  {profiles.length ? "Apply a saved profile…" : "No saved profiles yet"}
                </option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
            {showProfiles && (
              <button
                type="button"
                onClick={saveProfile}
                className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
              >
                <Save className="h-4 w-4" /> Save
              </button>
            )}
            {showBarcode && (
              <button
                type="button"
                onClick={() => setScannerOpen(true)}
                className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-primary bg-primary/15 px-3 text-sm font-medium text-primary transition-colors hover:bg-primary/25"
              >
                <Barcode className="h-4 w-4" /> Scan
              </button>
            )}
          </div>
          {scanNote && <p className="text-xs text-muted-foreground">{scanNote}</p>}
        </div>
      )}

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

      <div className="grid grid-cols-2 gap-4">
        <Field label="Filament diameter (mm)">
          <Select
            value={String(value.diameter ?? defaultDiameter)}
            onChange={(e) => set({ diameter: Number.parseFloat(e.target.value) || defaultDiameter })}
            aria-label="Filament diameter"
          >
            <option value="1.75">1.75 mm (standard)</option>
            <option value="2.85">2.85 mm</option>
            <option value="3">3.0 mm</option>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">Used to convert print length into grams.</p>
        </Field>
        <Field label="Density (g/cm³)">
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            min={0.5}
            max={3}
            value={value.density ?? ""}
            onChange={(e) => {
              const raw = e.target.value.trim()
              set({ density: raw === "" ? undefined : Math.max(0, Number.parseFloat(raw) || 0) })
            }}
            placeholder={`e.g. ${densityFor(value.material)}`}
          />
          <p className="mt-1 text-xs text-muted-foreground">Defaults from the material.</p>
        </Field>
      </div>

      {showQuantity && (
        <Field label="Quantity">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => set({ quantity: Math.max(1, (value.quantity ?? 1) - 1) })}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border text-lg font-medium text-foreground transition-colors hover:bg-secondary"
              aria-label="Decrease quantity"
            >
              −
            </button>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              value={value.quantity ?? 1}
              onChange={(e) => set({ quantity: Math.max(1, Math.min(99, Number.parseInt(e.target.value) || 1)) })}
              className="text-center"
              aria-label="Quantity"
            />
            <button
              type="button"
              onClick={() => set({ quantity: Math.min(99, (value.quantity ?? 1) + 1) })}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border text-lg font-medium text-foreground transition-colors hover:bg-secondary"
              aria-label="Increase quantity"
            >
              +
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {(value.quantity ?? 1) > 1
              ? `Creates ${value.quantity} identical spools.`
              : "How many identical spools to create."}
          </p>
        </Field>
      )}

      <BarcodeScanner open={scannerOpen} onDetected={onScan} onClose={() => setScannerOpen(false)} />
    </div>
  )
}
