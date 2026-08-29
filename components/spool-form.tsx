"use client"

import { useEffect, useState } from "react"
import { Barcode, Save, X, QrCode as QrIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"
import { Field, Input, Label, Select } from "./ui/field"
import { PresetCombobox } from "./preset-combobox"
import { SpoolDisc } from "./spool"
import { BarcodeScanner } from "./barcode-scanner"
import { QrCode } from "./qr-code"
import { QrPrintButton } from "./qr-print-button"
import { newQrTagId, qrPayload } from "@/lib/tags"
import type { QrLabelSpec } from "@/lib/qr"
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
  /** Optional second color for a dual-color spool. */
  color2?: string
  /** Whether this spool is a two-tone spool (renders `color2`). */
  dualColor?: boolean
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
  /**
   * Ids of RFID/QR tags to bind to the spool(s) created from this draft — one
   * per spool when a quantity is set, so each physical spool gets its own unique
   * printable QR. Minted when the user opts into QR during creation; the
   * `UPSERT_SPOOL` reducer registers each binding once its spool exists.
   */
  tagIds?: string[]
}

/**
 * Convert a draft into the fields of a single `Spool`, stripping form-only
 * fields (`quantity`, `tagIds`) and assigning the Nth minted tag id. Use this
 * everywhere a `SpoolDraft` becomes a `Spool` so batch spools each get their
 * own tag and no draft-only field leaks onto the stored spool.
 */
export function draftToSpoolFields(draft: SpoolDraft, index = 0): Omit<SpoolDraft, "quantity" | "tagIds"> & {
  tagId?: string
} {
  const { quantity: _q, tagIds, ...rest } = draft
  const tagId = tagIds?.[index]
  return tagId ? { ...rest, tagId } : rest
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
 * A numeric text input that can be genuinely empty while editing. It keeps its
 * own display string, so clearing the field shows a blank box (not a forced 0).
 * `onValue` reports `null` while the field is empty; the parent decides what to
 * store for that. Values are clamped to [min, max] when they parse. When the
 * external `value` changes (e.g. a profile is applied) the display resyncs, but
 * only while the field isn't focused so it never fights the user's typing.
 */
export function NumField({
  value,
  onValue,
  min,
  max,
  integer = true,
  placeholder,
  className,
  ariaLabel,
}: {
  value: number | undefined
  onValue: (n: number | null) => void
  min?: number
  max?: number
  integer?: boolean
  placeholder?: string
  className?: string
  ariaLabel?: string
}) {
  const fmt = (v: number | undefined) => (v == null || Number.isNaN(v) ? "" : String(v))
  const [text, setText] = useState(() => fmt(value))
  const [focused, setFocused] = useState(false)

  // Resync the display when the model changes from outside (profile apply,
  // material change, etc.) — but not mid-typing.
  useEffect(() => {
    if (!focused) setText(fmt(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, focused])

  const clamp = (n: number) => {
    let v = n
    if (min != null) v = Math.max(min, v)
    if (max != null) v = Math.min(max, v)
    return v
  }

  return (
    <Input
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={className}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        // Snap the display back to the committed model value on blur so a
        // left-empty field doesn't stay blank forever.
        setText(fmt(value))
      }}
      onChange={(e) => {
        const raw = e.target.value
        setText(raw)
        if (raw.trim() === "") {
          onValue(null)
          return
        }
        const n = integer ? Number.parseInt(raw) : Number.parseFloat(raw)
        if (Number.isFinite(n)) onValue(clamp(n))
      }}
    />
  )
}

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

/**
 * QR creation UI shown inside SpoolForm when `showTag` is on. Mints one unique
 * QR per spool (tracking the quantity), previews them, and prints them at a
 * chosen physical size. Bindings are registered on save by the store.
 */
function TagQrBlock({
  value,
  set,
  count,
}: {
  value: SpoolDraft
  set: (patch: Partial<SpoolDraft>) => void
  count: number
}) {
  const ids = value.tagIds ?? []

  // Once the user opts in, keep the number of codes in step with the quantity:
  // add ids when it grows, trim when it shrinks. Skips the opted-out state.
  useEffect(() => {
    if (ids.length === 0 || ids.length === count) return
    const next = ids.slice(0, count)
    while (next.length < count) next.push(newQrTagId())
    set({ tagIds: next })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count])

  const baseCaption = `${value.brand ?? ""} ${value.material ?? ""}`.trim() || "Filament spool"
  const labels: QrLabelSpec[] = ids.map((id, i) => ({
    contents: qrPayload(id),
    caption: baseCaption,
    sub:
      ids.length > 1
        ? `${value.colorName ? value.colorName + " · " : ""}#${i + 1} of ${ids.length}`
        : value.colorName || undefined,
  }))

  const remove = () => set({ tagIds: undefined })

  return (
    <div className="flex flex-col gap-2">
      <Label>QR code{count > 1 ? "s" : ""}</Label>
      {ids.length === 0 ? (
        <button
          type="button"
          onClick={() => set({ tagIds: Array.from({ length: count }, () => newQrTagId()) })}
          className="flex h-11 items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <QrIcon className="h-4 w-4" />
          {count > 1 ? `Create ${count} QR codes to print` : "Create QR code to print"}
        </button>
      ) : (
        <div className="rounded-xl border border-border bg-background/50 p-3">
          <p className="mb-3 text-xs text-muted-foreground text-pretty">
            {count > 1
              ? `${count} unique QR codes will be bound — one per spool. Print them and stick one on each spool.`
              : "A QR code will be bound to this spool when you save. Print it and stick it on the spool."}
          </p>
          {ids.length === 1 ? (
            <div className="flex flex-wrap items-center gap-4">
              <QrCode id={ids[0]} size={96} />
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <QrPrintButton labels={labels} />
                <RemoveTagsButton onClick={remove} />
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {ids.map((id, i) => (
                  <div key={id} className="flex flex-col items-center gap-1">
                    <QrCode id={id} size={72} />
                    <span className="text-[11px] text-muted-foreground">#{i + 1}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <QrPrintButton labels={labels} />
                <RemoveTagsButton onClick={remove} />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function RemoveTagsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary"
    >
      <X className="h-4 w-4" /> Remove
    </button>
  )
}

/** Full editor for a spool's attributes. Controlled via value/onChange. */
export function SpoolForm({
  value,
  onChange,
  showProfiles = false,
  showQuantity = false,
  showBarcode = false,
  showTag = false,
}: {
  value: SpoolDraft
  onChange: (d: SpoolDraft) => void
  /** Show the saved-profile picker + "Save as profile" action (create flows). */
  showProfiles?: boolean
  /** Show the quantity stepper (create/place flows that support batches). */
  showQuantity?: boolean
  /** Show the "Scan barcode" action and apply matched profiles (create flows). */
  showBarcode?: boolean
  /**
   * Show the "Create QR code" affordance so the user can mint + print a QR for
   * this spool during creation (single-spool flows only). The binding is saved
   * automatically when the spool is created.
   */
  showTag?: boolean
}) {
  const { state, dispatch } = useStore()
  const set = (patch: Partial<SpoolDraft>) => onChange({ ...value, ...patch })

  // One QR per physical spool: for batch flows the code count tracks quantity.
  const tagCount = showQuantity ? Math.max(1, Math.round(value.quantity ?? 1)) : 1

  const materials = allMaterials(state.settings.customMaterials)
  const brands = allBrands(state.settings.customBrands)
  const containers = state.settings.containers ?? []
  const profiles = state.settings.filamentProfiles ?? []
  const barcodes = state.settings.barcodes ?? []
  const customColors = state.settings.customColors ?? []
  const defaultDiameter = state.settings.defaultDiameter ?? DEFAULT_DIAMETER

  const [scannerOpen, setScannerOpen] = useState(false)
  const [scanNote, setScanNote] = useState<string | null>(null)
  // Saved-color delete affordance is gated behind an explicit "Edit" toggle so
  // the small X can't be hit by mistake while just picking a color.
  const [editingColors, setEditingColors] = useState(false)

  /** Apply a saved profile's attributes to the current draft (keeps quantity). */
  function applyProfile(id: string) {
    const p = profiles.find((x) => x.id === id)
    if (!p) return
    set({
      material: p.material,
      brand: p.brand,
      color: p.color,
      color2: p.color2,
      dualColor: p.dualColor,
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
    const name = value.colorName ? `${value.brand} ${value.material} �� ${value.colorName}` : `${value.brand} ${value.material}`
    dispatch({
      type: "ADD_PROFILE",
      profile: {
        id: newId("profile"),
        name,
        material: value.material,
        brand: value.brand,
        color: value.color,
        color2: value.dualColor ? value.color2 : undefined,
        dualColor: value.dualColor,
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
  function normalizeHex(raw: string) {
    let v = raw.replace(/[^#0-9a-fA-F]/g, "")
    if (!v.startsWith("#")) v = "#" + v
    return "#" + v.slice(1).slice(0, 6)
  }
  const setHex = (raw: string) => set({ color: normalizeHex(raw) })
  const setHex2 = (raw: string) => set({ color2: normalizeHex(raw) })

  /** Save the current primary color as a reusable custom swatch. */
  function saveCurrentColor() {
    if (!validHex) return
    dispatch({ type: "ADD_CUSTOM_COLOR", color: { name: value.colorName.trim() || value.color, hex: value.color } })
  }

  const validHex = HEX_RE.test(value.color)
  const validHex2 = HEX_RE.test(value.color2 ?? "")
  const allPresetHexes = new Set([
    ...COLOR_PRESETS.map((c) => c.hex.toLowerCase()),
    ...customColors.map((c) => c.hex.toLowerCase()),
  ])
  const isPreset = allPresetHexes.has(value.color.toLowerCase())
  const alreadySaved = customColors.some((c) => c.hex.toLowerCase() === value.color.toLowerCase())
  const pickerValue = validHex ? value.color : "#000000"
  const pickerValue2 = validHex2 ? value.color2! : "#000000"
  const fill = spoolFill(value)

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <SpoolDisc
          color={validHex ? value.color : "#1c1c1e"}
          color2={value.dualColor && value.color2 && HEX_RE.test(value.color2) ? value.color2 : undefined}
          size={72}
          fill={fill}
          boxed={!!value.containerId}
        />
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

      {showTag && <TagQrBlock value={value} set={set} count={tagCount} />}

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

        {/* Saved custom swatches — reusable colors the user has stored. */}
        {customColors.length > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Your saved colors</p>
              <button
                type="button"
                onClick={() => setEditingColors((v) => !v)}
                className={cn(
                  "text-xs font-medium transition-colors",
                  editingColors ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={editingColors}
              >
                {editingColors ? "Done" : "Edit"}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {customColors.map((c) => (
                <span key={c.hex} className="relative">
                  <button
                    type="button"
                    title={c.name}
                    onClick={() =>
                      editingColors
                        ? dispatch({ type: "REMOVE_CUSTOM_COLOR", hex: c.hex })
                        : set({ color: c.hex, colorName: c.name })
                    }
                    className={cn(
                      "h-9 w-9 rounded-full border-2 transition-transform hover:scale-110",
                      editingColors
                        ? "border-destructive/60"
                        : value.color.toLowerCase() === c.hex.toLowerCase()
                          ? "border-primary"
                          : "border-black/40",
                    )}
                    style={{ backgroundColor: c.hex }}
                    aria-label={editingColors ? `Remove saved color ${c.name}` : `${c.name} (saved)`}
                  />
                  {editingColors && (
                    <span
                      className="pointer-events-none absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-background text-destructive shadow ring-1 ring-border"
                      aria-hidden="true"
                    >
                      <X className="h-3 w-3" />
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Custom hex color: swatch/native picker + text field + save action */}
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
          <button
            type="button"
            onClick={saveCurrentColor}
            disabled={!validHex || alreadySaved || isPreset}
            title={alreadySaved ? "Already saved" : isPreset ? "Built-in color" : "Save this color for reuse"}
            className="flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save className="h-4 w-4" /> Save
          </button>
        </div>
        {!validHex && <p className="mt-1 text-xs text-warning">Enter a 6-digit hex like #1e88e5.</p>}

        {/* Dual-color toggle + second color picker */}
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={!!value.dualColor}
            onChange={(e) =>
              set({
                dualColor: e.target.checked,
                // Seed the second color so the preview shows a split immediately.
                color2: e.target.checked ? value.color2 ?? "#f4f4f5" : value.color2,
              })
            }
            className="h-4 w-4 accent-primary"
          />
          Dual-color spool (two-tone / co-extruded)
        </label>

        {value.dualColor && (
          <div className="mt-2 flex items-center gap-2">
            <label
              className="relative h-11 w-12 shrink-0 cursor-pointer overflow-hidden rounded-lg border-2 border-black/40"
              style={{ backgroundColor: validHex2 ? value.color2 : "transparent" }}
              title="Pick the second color"
            >
              <input
                type="color"
                value={pickerValue2}
                onChange={(e) => set({ color2: e.target.value })}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                aria-label="Second color picker"
              />
            </label>
            <Input
              value={value.color2 ?? ""}
              onChange={(e) => setHex2(e.target.value)}
              placeholder="#RRGGBB (second color)"
              spellCheck={false}
              className={cn("font-mono uppercase", !validHex2 && "border-warning focus-visible:ring-warning")}
              aria-label="Second hex color"
            />
          </div>
        )}
        {value.dualColor && !validHex2 && (
          <p className="mt-1 text-xs text-warning">Enter a 6-digit hex for the second color.</p>
        )}
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
          <NumField
            value={value.capacity}
            min={1}
            max={5000}
            ariaLabel="Full spool weight"
            onValue={(n) => {
              if (n == null) return // left empty while typing — keep the last value
              const cap = Math.max(1, n)
              // Keep remaining within the new full weight.
              set({ capacity: cap, grams: Math.min(value.grams, cap) })
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">Weight of a brand-new spool (the 100% mark).</p>
        </Field>
        <Field label="Remaining (grams)">
          <NumField
            value={value.grams}
            min={0}
            max={value.capacity}
            ariaLabel="Remaining grams"
            onValue={(n) => {
              if (n == null) return // left empty while typing — keep the last value
              set({ grams: Math.max(0, Math.min(value.capacity, n)) })
            }}
          />
          <p className="mt-1 text-xs text-muted-foreground">{Math.round(fill * 100)}% left on the spool.</p>
        </Field>
      </div>

      <Field label="Nozzle temperature (optional)">
        <div className="flex items-center gap-2">
          <NumField
            value={value.nozzleTemp}
            min={0}
            max={350}
            ariaLabel="Nozzle temperature"
            placeholder={`e.g. ${nozzleTempFor(value.material)}`}
            onValue={(n) => set({ nozzleTemp: n == null ? undefined : n })}
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
          <NumField
            value={value.density}
            min={0}
            max={3}
            integer={false}
            ariaLabel="Density"
            placeholder={`e.g. ${densityFor(value.material)}`}
            onValue={(n) => set({ density: n == null ? undefined : n })}
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
