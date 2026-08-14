"use client"

import { useMemo, useState } from "react"
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check, Filter, PackagePlus, X } from "lucide-react"
import { useStore } from "@/lib/store"
import { useSpoolSelection } from "@/lib/use-spool-selection"
import { SpoolSelectionBar, SelectModeButton } from "./spool-selection-bar"
import { activeNode } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import { formatRemaining, spoolFill } from "@/lib/filament"
import { SpoolDisc } from "./spool"
import { Button } from "./ui/button"
import type { Spool } from "@/lib/types"

type WeightSort = "none" | "heaviest" | "lightest"

/** A stored spool paired with its slot index in the library's single row. */
interface Entry {
  spool: Spool
  slot: number
}

/**
 * Inventory view for a "library" storage node: an unbounded, manual catalog of
 * spools. Unlike the paternoster carousel or the fixed shelf grid there are no
 * physical positions — spools show in insertion order by default and can be
 * filtered (material / brand / color) and sorted (by remaining weight). Filters
 * combine, so e.g. "PLA + Black + lightest first" narrows and reorders together.
 * The card look matches ShelfStorageView so the two feel like one family.
 */
export function LibraryView({
  onSpoolClick,
  onAddClick,
  highlight,
}: {
  onSpoolClick: (slot: number) => void
  onAddClick: () => void
  /** Slot index to flash (e.g. the spool a running job is servicing). */
  highlight?: number | null
}) {
  const { state, dispatch } = useStore()
  const node = activeNode(state)
  const selection = useSpoolSelection()

  const [materials, setMaterials] = useState<string[]>([])
  const [brands, setBrands] = useState<string[]>([])
  const [colors, setColors] = useState<string[]>([])
  const [weightSort, setWeightSort] = useState<WeightSort>("none")

  // Every spool currently in this library, tagged with its row index.
  const entries = useMemo<Entry[]>(() => {
    const row = node.slots[0] ?? []
    const out: Entry[] = []
    row.forEach((id, slot) => {
      const spool = id ? state.spools[id] : null
      if (spool) out.push({ spool, slot })
    })
    return out
  }, [node.slots, state.spools])

  // Distinct facet values for the filter chips (only what's actually present).
  const facets = useMemo(() => {
    const mat = new Set<string>()
    const brd = new Set<string>()
    const col = new Map<string, string>() // label -> swatch color
    for (const { spool } of entries) {
      mat.add(spool.material)
      brd.add(spool.brand)
      const label = spool.colorName?.trim() || spool.color
      if (!col.has(label)) col.set(label, spool.color)
    }
    return {
      materials: [...mat].sort(),
      brands: [...brd].sort(),
      colors: [...col.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    }
  }, [entries])

  const filtered = useMemo(() => {
    let list = entries.filter(({ spool }) => {
      if (materials.length && !materials.includes(spool.material)) return false
      if (brands.length && !brands.includes(spool.brand)) return false
      if (colors.length) {
        const label = spool.colorName?.trim() || spool.color
        if (!colors.includes(label)) return false
      }
      return true
    })
    if (weightSort !== "none") {
      list = [...list].sort((a, b) =>
        weightSort === "heaviest" ? b.spool.grams - a.spool.grams : a.spool.grams - b.spool.grams,
      )
    }
    return list
  }, [entries, materials, brands, colors, weightSort])

  const activeFilters = materials.length + brands.length + colors.length + (weightSort !== "none" ? 1 : 0)

  function toggle(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value])
  }

  function clearAll() {
    setMaterials([])
    setBrands([])
    setColors([])
    setWeightSort("none")
  }

  // Delete every ticked spool. DELETE_SPOOL also clears its slot everywhere.
  function deleteSelected() {
    for (const id of selection.selected) dispatch({ type: "DELETE_SPOOL", id })
    selection.exit()
  }

  return (
    <>
      {/* Filter / sort toolbar. Fixed to its natural height (shrink-0) so it
          never steals room from the scrollable grid below — otherwise a tall
          toolbar would squeeze the cards down to a clipped sliver. */}
      <div className="shrink-0 space-y-3 rounded-2xl border border-border bg-card/60 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Filter className="h-4 w-4 text-primary" /> Filter
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            {filtered.length}/{entries.length}
          </span>
          {activeFilters > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-1 rounded-full bg-secondary/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3 w-3" /> Clear{activeFilters > 1 ? ` (${activeFilters})` : ""}
            </button>
          )}
          {!selection.active && entries.length > 0 && (
            <span className="ml-auto">
              <SelectModeButton onClick={() => selection.enter()} disabled={!!state.job} />
            </span>
          )}
        </div>

        {selection.active && (
          <SpoolSelectionBar
            count={selection.count}
            total={filtered.length}
            onDelete={deleteSelected}
            onSelectAll={() => selection.selectAll(filtered.map((e) => e.spool.id))}
            onClear={selection.clear}
            onExit={selection.exit}
          />
        )}

        {entries.length > 0 && (
          <div className="flex flex-col gap-2">
            {facets.materials.length > 0 && (
              <FacetRow label="Material">
                {facets.materials.map((m) => (
                  <Chip key={m} active={materials.includes(m)} onClick={() => toggle(materials, setMaterials, m)}>
                    {m}
                  </Chip>
                ))}
              </FacetRow>
            )}
            {facets.brands.length > 0 && (
              <FacetRow label="Brand">
                {facets.brands.map((b) => (
                  <Chip key={b} active={brands.includes(b)} onClick={() => toggle(brands, setBrands, b)}>
                    {b}
                  </Chip>
                ))}
              </FacetRow>
            )}
            {facets.colors.length > 0 && (
              <FacetRow label="Color">
                {facets.colors.map(([label, swatch]) => (
                  <Chip key={label} active={colors.includes(label)} onClick={() => toggle(colors, setColors, label)}>
                    <span
                      className="h-3 w-3 shrink-0 rounded-full border border-border"
                      style={{ backgroundColor: swatch }}
                      aria-hidden
                    />
                    {label}
                  </Chip>
                ))}
              </FacetRow>
            )}
            <FacetRow label="Weight">
              <Chip
                active={weightSort === "heaviest"}
                onClick={() => setWeightSort(weightSort === "heaviest" ? "none" : "heaviest")}
              >
                <ArrowDownWideNarrow className="h-3.5 w-3.5" /> Heaviest first
              </Chip>
              <Chip
                active={weightSort === "lightest"}
                onClick={() => setWeightSort(weightSort === "lightest" ? "none" : "lightest")}
              >
                <ArrowUpNarrowWide className="h-3.5 w-3.5" /> Lightest first
              </Chip>
            </FacetRow>
          </div>
        )}
      </div>

      {/* Spool grid. A library is an unbounded catalog, so the grid grows with
          its content and the page scrolls — it is NOT a squeezable flex pane.
          shrink-0 + a min-height floor guarantees the cards always render at
          full height instead of being crushed to a clipped sliver when the
          toolbar and printer panel compete for vertical space. */}
      <div className="min-h-[320px] shrink-0 rounded-2xl border border-border bg-gradient-to-b from-card to-background p-3">
        {entries.length === 0 ? (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground text-balance">
              Your library is empty. Add spools to catalog what filament you own.
            </p>
            <Button onClick={onAddClick}>
              <PackagePlus className="h-4 w-4" /> Add filament to library
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">No spools match these filters.</p>
            <Button variant="outline" onClick={clearAll}>
              <X className="h-4 w-4" /> Clear filters
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
            {filtered.map(({ spool, slot }) => {
              const isHi = highlight === slot
              const isSel = selection.selected.has(spool.id)
              return (
                <button
                  key={spool.id}
                  type="button"
                  aria-pressed={selection.active ? isSel : undefined}
                  onClick={() => (selection.active ? selection.toggle(spool.id) : onSpoolClick(slot))}
                  className={cn(
                    "relative flex flex-col items-center gap-1 rounded-xl p-1.5 transition-colors hover:bg-primary/10",
                    isHi && "animate-slot-flash",
                    selection.active && "ring-1 ring-inset ring-border",
                    isSel && "bg-primary/15 ring-2 ring-primary",
                  )}
                >
                  {selection.active && (
                    <span
                      className={cn(
                        "absolute right-1 top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full border",
                        isSel ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background",
                      )}
                      aria-hidden
                    >
                      {isSel && <Check className="h-3 w-3" />}
                    </span>
                  )}
                  <SpoolDisc color={spool.color} size={52} fill={spoolFill(spool)} boxed={!!spool.containerId} />
                  <span className="mt-0.5 flex w-full flex-col items-center leading-tight">
                    {/* Material always uses the foreground token so it stays
                        legible no matter how dark/light the spool colour is. */}
                    <span className="text-[11px] font-semibold text-foreground">{spool.material}</span>
                    {/* Colour is conveyed by a swatch dot + name, so a black or
                        white spool is still readable (unlike colouring the text). */}
                    <span className="flex max-w-full items-center gap-1 text-[9px] text-muted-foreground">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full border border-border"
                        style={{ backgroundColor: spool.color }}
                        aria-hidden
                      />
                      <span className="truncate">{spool.colorName?.trim() || spool.color}</span>
                    </span>
                    <span className="text-[9px] text-muted-foreground">{formatRemaining(spool)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

/** A labelled row of filter chips. */
function FacetRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** A toggleable filter chip. */
function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        active
          ? "border-primary bg-primary/15 text-primary"
          : "border-border bg-background/40 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}
