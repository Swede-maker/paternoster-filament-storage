"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Plus, X, Check, ImagePlus, Trash2 } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { newId } from "@/lib/filament"
import { Dialog, DialogFooter } from "../ui/dialog"
import { Button } from "../ui/button"
import { Input, Field, Checkbox } from "../ui/field"
import { PartBox, DEFAULT_TOTE_COLOR } from "./part-box"
import type { HardwarePart } from "@/lib/types"

/** Built-in fallback swatches so the picker is useful before any are saved. */
const DEFAULT_SWATCHES: { name: string; hex: string }[] = [
  { name: "Blue", hex: DEFAULT_TOTE_COLOR },
  { name: "Steel", hex: "#8a8f98" },
  { name: "Graphite", hex: "#3f4249" },
  { name: "Brass", hex: "#b08d57" },
  { name: "Copper", hex: "#b87333" },
  { name: "Red", hex: "#d64545" },
  { name: "Green", hex: "#3fae6b" },
  { name: "Yellow", hex: "#e0b83a" },
]

export interface HardwareDraftResult {
  part: HardwarePart
}

/**
 * The add / edit hardware dialog. Collects a part's identity (name, category,
 * color, optional photo), batch (quantity + per-piece weight), search tags, and
 * an optional low-stock threshold, then hands a fully-formed {@link HardwarePart}
 * back to the caller. In add mode the caller finds a balanced slot and drives
 * the carousel to place it; in edit mode (`initial` set) it just upserts the
 * record, keeping the same id and slot.
 */
export function HardwareForm({
  open,
  onClose,
  onSubmit,
  initial,
}: {
  open: boolean
  onClose: () => void
  onSubmit: (part: HardwarePart) => void
  /** When set, the form opens prefilled for editing this part. */
  initial?: HardwarePart | null
}) {
  const { state, dispatch } = useStore()
  const categories = state.settings.hardwareCategories ?? []
  const savedColors = state.settings.hardwareColorPresets ?? []
  const swatches = savedColors.length > 0 ? savedColors : DEFAULT_SWATCHES
  const isEdit = !!initial

  // Default to bin blue when nothing is chosen, per the tote fallback.
  const blue = useMemo(
    () => swatches.find((s) => s.hex.toLowerCase() === DEFAULT_TOTE_COLOR) ?? swatches.find((s) => /blue/i.test(s.name)),
    [swatches],
  )
  const defColor = blue?.hex ?? DEFAULT_TOTE_COLOR
  const defColorName = blue?.name ?? "Blue"

  const [name, setName] = useState("")
  const [category, setCategory] = useState("")
  const [newCategory, setNewCategory] = useState("")
  const [quantity, setQuantity] = useState("25")
  const [perPiece, setPerPiece] = useState("3")
  const [color, setColor] = useState(defColor)
  const [colorName, setColorName] = useState(defColorName)
  const [tagInput, setTagInput] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [notify, setNotify] = useState(false)
  const [threshold, setThreshold] = useState("5")
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Seed the fields whenever the dialog opens — prefilled from `initial` for an
  // edit, or reset to fresh defaults for a new part.
  useEffect(() => {
    if (!open) return
    if (initial) {
      setName(initial.name)
      setCategory(initial.category)
      setNewCategory("")
      setQuantity(String(initial.count))
      setPerPiece(String(initial.perPieceWeightGrams))
      setColor(initial.color || defColor)
      setColorName(initial.colorName || defColorName)
      setTags(initial.tags ?? [])
      setTagInput("")
      setNotify(initial.lowStockThreshold != null)
      setThreshold(initial.lowStockThreshold != null ? String(initial.lowStockThreshold) : "5")
      setImageUrl(initial.imageUrl ?? null)
    } else {
      setName("")
      setCategory("")
      setNewCategory("")
      setQuantity("25")
      setPerPiece("3")
      setColor(defColor)
      setColorName(defColorName)
      setTags([])
      setTagInput("")
      setNotify(false)
      setThreshold("5")
      setImageUrl(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])

  const totalGrams = useMemo(() => {
    const q = Number.parseFloat(quantity) || 0
    const w = Number.parseFloat(perPiece) || 0
    return Math.max(0, q * w)
  }, [quantity, perPiece])

  const addTag = () => {
    const t = tagInput.trim()
    if (!t || tags.includes(t)) {
      setTagInput("")
      return
    }
    setTags((prev) => [...prev, t])
    setTagInput("")
  }

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImageUrl(typeof reader.result === "string" ? reader.result : null)
    reader.readAsDataURL(file)
    // Reset so re-picking the same file still fires change.
    e.target.value = ""
  }

  const canSubmit = name.trim().length > 0 && (Number.parseFloat(quantity) || 0) >= 1

  const submit = () => {
    if (!canSubmit) return
    // Persist a freshly-typed category so it's reusable next time.
    let cat = category.trim()
    const typed = newCategory.trim()
    if (typed) {
      cat = typed
      if (!categories.some((c) => c.name.toLowerCase() === typed.toLowerCase())) {
        dispatch({ type: "ADD_HW_CATEGORY", category: { id: newId("hwcat"), name: typed } })
      }
    }
    // Remember a custom color the user picked so it appears as a preset later.
    if (!swatches.some((s) => s.hex.toLowerCase() === color.toLowerCase())) {
      dispatch({ type: "ADD_HW_COLOR", color: { name: colorName.trim() || color, hex: color } })
    }
    const part: HardwarePart = {
      id: initial?.id ?? newId("part"),
      name: name.trim(),
      category: cat,
      count: Math.max(1, Math.round(Number.parseFloat(quantity) || 1)),
      perPieceWeightGrams: Math.max(0, Number.parseFloat(perPiece) || 0),
      tags,
      color,
      colorName: colorName.trim() || color,
      lowStockThreshold: notify ? Math.max(0, Math.round(Number.parseFloat(threshold) || 0)) : null,
      imageUrl: imageUrl ?? null,
      createdAt: initial?.createdAt ?? Date.now(),
    }
    onSubmit(part)
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit hardware" : "Add hardware"}
      description={
        isEdit
          ? "Update this part's details, color and photo. Changes apply to the box in place."
          : "Create a batch to store in a carousel slot. The system balances it by total weight."
      }
      className="max-w-lg"
    >
      <div className="space-y-5">
        {/* Identity */}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. M5×40 socket screw" autoFocus />
        </Field>

        {/* Photo */}
        <Field label="Photo (optional)">
          <div className="flex items-center gap-3">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-background/50">
              <PartBox color={color} size={60} imageUrl={imageUrl} name={name} />
            </span>
            <div className="flex flex-wrap gap-2">
              <input ref={fileRef} type="file" accept="image/*" onChange={onPickImage} className="sr-only" />
              <Button type="button" variant="outline" size="md" onClick={() => fileRef.current?.click()}>
                <ImagePlus className="h-4 w-4" /> {imageUrl ? "Replace photo" : "Choose photo"}
              </Button>
              {imageUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setImageUrl(null)}
                >
                  <Trash2 className="h-4 w-4" /> Remove
                </Button>
              )}
            </div>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Shown on the tote in the carousel and in the &ldquo;All Hardware&rdquo; list.
          </p>
        </Field>

        {/* Batch */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity (pieces)">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
          <Field label="Weight each (g)">
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.1"
              value={perPiece}
              onChange={(e) => setPerPiece(e.target.value)}
            />
          </Field>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          Total box weight <span className="font-mono text-foreground">{totalGrams.toFixed(0)} g</span> — used to
          balance the carousel.
        </p>

        {/* Category */}
        <Field label="Category">
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  setCategory(c.name)
                  setNewCategory("")
                }}
                className={cn(
                  "h-9 rounded-lg border px-3 text-sm font-medium transition-colors",
                  category === c.name && !newCategory
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
          <Input
            className="mt-2"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="…or type a new category"
          />
        </Field>

        {/* Color */}
        <Field label="Slot color">
          <div className="flex items-center gap-3">
            <PartBox color={color} size={44} />
            <div className="flex flex-wrap gap-2">
              {swatches.map((s) => (
                <button
                  key={s.hex}
                  type="button"
                  aria-label={s.name}
                  title={s.name}
                  onClick={() => {
                    setColor(s.hex)
                    setColorName(s.name)
                  }}
                  className={cn(
                    "h-8 w-8 rounded-full border-2 transition-transform",
                    color.toLowerCase() === s.hex.toLowerCase()
                      ? "border-primary scale-110"
                      : "border-border hover:scale-105",
                  )}
                  style={{ backgroundColor: s.hex }}
                />
              ))}
              <label className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-border text-muted-foreground hover:text-foreground">
                <Plus className="h-4 w-4" />
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="sr-only"
                  aria-label="Pick a custom color"
                />
              </label>
            </div>
          </div>
          <Input
            className="mt-2"
            value={colorName}
            onChange={(e) => setColorName(e.target.value)}
            placeholder="Color name (e.g. Steel Blue)"
          />
        </Field>

        {/* Tags */}
        <Field label="Search tags">
          <div className="flex gap-2">
            <Input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault()
                  addTag()
                }
              }}
              placeholder="e.g. steel, M5, hex"
            />
            <Button variant="outline" size="icon" onClick={addTag} aria-label="Add tag">
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {tags.map((t) => (
                <span
                  key={t}
                  className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs text-secondary-foreground"
                >
                  {t}
                  <button type="button" onClick={() => setTags((prev) => prev.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </Field>

        {/* Low stock */}
        <div className="space-y-2">
          <Checkbox
            checked={notify}
            onChange={setNotify}
            label="Notify me when stock is low"
            description="Flags the part and badges the Hardware tab when it drops to the threshold."
          />
          {notify && (
            <Field label="Low-stock threshold (pieces)">
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </Field>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          <Check className="h-4 w-4" /> {isEdit ? "Save changes" : "Find slot & place"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
