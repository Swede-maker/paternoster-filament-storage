"use client"

import type { NodeType, ShelfMeta, StorageConfig } from "@/lib/types"
import { Boxes, LayoutGrid, Package, SlidersHorizontal } from "lucide-react"
import { Field, Input } from "./ui/field"

/**
 * A single editable storage layout, shared by the first-run setup wizard and
 * the "add / edit storage" flow in Settings so both stay perfectly in sync.
 */
export interface StorageDraft {
  nodeType: NodeType
  name: string
  /** Physical area / location of the whole unit. */
  area: string
  shelves: number
  /** Uniform slots-per-shelf (used when `jagged` is off). */
  slotsPerShelf: number
  /** When true, each shelf can have its own slot count. */
  jagged: boolean
  /** Per-shelf name / area / slot count. Length is kept in sync with `shelves`. */
  perShelf: { name: string; area: string; slots: number }[]
}

// Paternosters are physical carousels: modest, uniform shelves. Manual shelf
// units can be much larger and irregular.
export const LIMITS = {
  paternoster: { shelves: 40, slots: 20 },
  shelf: { shelves: 10, slots: 100 },
}

export const clampInt = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.floor(Number.isFinite(v) ? v : min)))

export function makeDraft(nodeType: NodeType): StorageDraft {
  const shelves = nodeType === "shelf" ? 3 : 9
  const slotsPerShelf = nodeType === "shelf" ? 10 : 8
  return {
    nodeType,
    name: "",
    area: "",
    shelves,
    slotsPerShelf,
    jagged: false,
    perShelf: Array.from({ length: shelves }, () => ({ name: "", area: "", slots: slotsPerShelf })),
  }
}

/** Build a draft that mirrors an existing node's current layout (for editing). */
export function draftFromNode(node: {
  name: string
  type?: NodeType
  area?: string
  storage: StorageConfig
  shelfMeta?: ShelfMeta[]
  slots: (string | null)[][]
}): StorageDraft {
  const nodeType: NodeType = node.type === "shelf" ? "shelf" : "paternoster"
  const counts = node.slots.map((row) => row.length)
  const jagged = counts.some((c) => c !== counts[0])
  return {
    nodeType,
    name: node.name,
    area: node.area ?? "",
    shelves: node.storage.shelves,
    slotsPerShelf: node.storage.slotsPerShelf,
    jagged,
    perShelf: node.slots.map((row, i) => ({
      name: node.shelfMeta?.[i]?.name ?? "",
      area: node.shelfMeta?.[i]?.area ?? "",
      slots: row.length,
    })),
  }
}

/** Convert a draft into the persisted storage config + shelf metadata. */
export function draftToConfig(d: StorageDraft): { storage: StorageConfig; shelfMeta?: ShelfMeta[] } {
  const limit = LIMITS[d.nodeType]
  const shelves = clampInt(d.shelves, 1, limit.shelves)
  const slotsPerShelf = clampInt(d.slotsPerShelf, 1, limit.slots)
  const storage: StorageConfig = { shelves, slotsPerShelf }
  const rows = d.perShelf.slice(0, shelves)
  if (d.jagged) {
    storage.slotCounts = rows.map((p) => clampInt(p.slots, 1, limit.slots))
  }
  // Always return a defined array for shelf units so edits are authoritative
  // (RESHAPE_NODE keeps the old meta when this is undefined). Paternosters keep
  // numbered shelves, so they carry no per-shelf metadata.
  const shelfMeta: ShelfMeta[] | undefined =
    d.nodeType === "shelf"
      ? rows.map((p) => ({ name: p.name.trim() || undefined, area: p.area.trim() || undefined }))
      : undefined
  return { storage, shelfMeta }
}

/** Keep `perShelf` length in sync when the shelf count changes. */
function resizePerShelf(d: StorageDraft, shelves: number): StorageDraft["perShelf"] {
  const next = d.perShelf.slice(0, shelves)
  while (next.length < shelves) next.push({ name: "", area: "", slots: d.slotsPerShelf })
  return next
}

const TYPES: { type: NodeType; title: string; blurb: string; icon: typeof Boxes }[] = [
  {
    type: "paternoster",
    title: "Paternoster",
    blurb: "Motorised vertical carousel driven by a Raspberry Pi. Rotates to present the right shelf.",
    icon: Boxes,
  },
  {
    type: "shelf",
    title: "Shelf storage",
    blurb: "Plain manual shelving — no hardware. The app just tracks what filament sits where.",
    icon: Package,
  },
]

export function StorageLayoutEditor({
  draft,
  onChange,
  allowTypeChange = true,
}: {
  draft: StorageDraft
  onChange: (d: StorageDraft) => void
  allowTypeChange?: boolean
}) {
  const limit = LIMITS[draft.nodeType]
  const isShelf = draft.nodeType === "shelf"
  const total = draft.jagged
    ? draft.perShelf.slice(0, draft.shelves).reduce((s, p) => s + clampInt(p.slots, 1, limit.slots), 0)
    : draft.shelves * draft.slotsPerShelf

  const update = (patch: Partial<StorageDraft>) => onChange({ ...draft, ...patch })

  const setType = (nodeType: NodeType) => {
    if (nodeType === draft.nodeType) return
    // Re-seed sensible defaults for the new type while keeping the name/area.
    const seed = makeDraft(nodeType)
    onChange({ ...seed, name: draft.name, area: draft.area })
  }

  const setShelves = (raw: number) => {
    const shelves = clampInt(raw, 1, limit.shelves)
    onChange({ ...draft, shelves, perShelf: resizePerShelf({ ...draft, shelves }, shelves) })
  }

  const setSlotsPerShelf = (raw: number) => {
    const slotsPerShelf = clampInt(raw, 1, limit.slots)
    // When uniform, propagate to every shelf so the preview + totals track.
    const perShelf = draft.jagged ? draft.perShelf : draft.perShelf.map((p) => ({ ...p, slots: slotsPerShelf }))
    onChange({ ...draft, slotsPerShelf, perShelf })
  }

  const toggleJagged = (jagged: boolean) => {
    const perShelf = jagged ? draft.perShelf : draft.perShelf.map((p) => ({ ...p, slots: draft.slotsPerShelf }))
    onChange({ ...draft, jagged, perShelf })
  }

  const setShelf = (i: number, patch: Partial<StorageDraft["perShelf"][number]>) => {
    const perShelf = draft.perShelf.map((p, idx) => (idx === i ? { ...p, ...patch } : p))
    update({ perShelf })
  }

  return (
    <div className="space-y-5">
      {allowTypeChange && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {TYPES.map(({ type, title, blurb, icon: Icon }) => {
            const active = draft.nodeType === type
            return (
              <button
                key={type}
                type="button"
                onClick={() => setType(type)}
                aria-pressed={active}
                className={`flex flex-col gap-1.5 rounded-xl border p-4 text-left transition-colors ${
                  active
                    ? "border-primary bg-primary/10 ring-1 ring-primary"
                    : "border-border bg-background/50 hover:border-muted-foreground/40"
                }`}
              >
                <span className="flex items-center gap-2 font-semibold">
                  <Icon className={`h-5 w-5 ${active ? "text-primary" : "text-muted-foreground"}`} />
                  {title}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">{blurb}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={isShelf ? "Storage name" : "System name"}>
          <Input
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder={isShelf ? "e.g. Garage rack" : "e.g. Workshop PAX"}
          />
        </Field>
        <Field label={isShelf ? "Area / location" : "Where it stands (area)"}>
          <Input
            value={draft.area}
            onChange={(e) => update({ area: e.target.value })}
            placeholder="e.g. Garage"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label={`Number of shelves (1–${limit.shelves})`}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={limit.shelves}
            value={draft.shelves}
            onChange={(e) => setShelves(Number.parseInt(e.target.value) || 1)}
          />
        </Field>
        <Field label={`Slots per shelf (1–${limit.slots})`}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={limit.slots}
            value={draft.slotsPerShelf}
            disabled={draft.jagged}
            onChange={(e) => setSlotsPerShelf(Number.parseInt(e.target.value) || 1)}
          />
        </Field>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={draft.jagged}
          onChange={(e) => toggleJagged(e.target.checked)}
        />
        <SlidersHorizontal className="h-4 w-4" />
        Different slot counts per shelf
      </label>

      {(isShelf || draft.jagged) && (
        <div className="rounded-xl border border-border bg-background/50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <LayoutGrid className="h-4 w-4" /> Shelves
            </span>
            <span className="font-mono text-sm text-primary">{total} total slots</span>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {draft.perShelf.slice(0, draft.shelves).map((p, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card p-2">
                <span className="w-6 shrink-0 text-center font-mono text-xs text-muted-foreground">{i + 1}</span>
                {isShelf ? (
                  <>
                    <Input
                      className="min-w-24 flex-1"
                      value={p.name}
                      onChange={(e) => setShelf(i, { name: e.target.value })}
                      placeholder={`Shelf ${i + 1} name`}
                    />
                    <Input
                      className="min-w-24 flex-1"
                      value={p.area}
                      onChange={(e) => setShelf(i, { area: e.target.value })}
                      placeholder="Area"
                    />
                  </>
                ) : (
                  <span className="flex-1 text-sm text-muted-foreground">Shelf {i + 1}</span>
                )}
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={limit.slots}
                    className="w-20"
                    value={p.slots}
                    disabled={!draft.jagged}
                    onChange={(e) => setShelf(i, { slots: clampInt(Number.parseInt(e.target.value) || 1, 1, limit.slots) })}
                  />
                  <span className="text-xs text-muted-foreground">slots</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
