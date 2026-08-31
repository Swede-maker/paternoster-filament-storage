"use client"

import { useMemo, useState } from "react"
import { Search, X, PackageSearch, TriangleAlert, MapPin } from "lucide-react"
import { useStore } from "@/lib/store"
import { formatGrams } from "@/lib/filament"
import { storedParts, searchParts, isPartLow, partWeightGrams, type StoredPart } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import { Input } from "../ui/field"
import { Button } from "../ui/button"
import { PartThumb } from "./part-box"
import { HardwareSlotDialog } from "./hardware-slot-dialog"
import { HardwareForm } from "./hardware-form"
import type { HardwarePart } from "@/lib/types"

/**
 * All-Hardware search: one searchable list of every part across every hardware
 * unit. Search matches name, category, tags and location; a low-stock filter
 * narrows to parts at/below threshold. Tapping a row opens the slot dialog to
 * take out / store more / delete — the same carousel-driven flow as Home.
 */
export function HardwareInventoryView() {
  const { state, dispatch } = useStore()
  const [query, setQuery] = useState("")
  const [lowOnly, setLowOnly] = useState(false)
  const [category, setCategory] = useState<string | null>(null)
  const [selected, setSelected] = useState<HardwarePart | null>(null)
  const [editPart, setEditPart] = useState<HardwarePart | null>(null)

  const all = useMemo(() => storedParts(state), [state])

  // Distinct categories actually present in storage, for the filter chips.
  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const e of all) {
      const c = e.part.category?.trim()
      if (c) set.add(c)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [all])

  const results = useMemo(() => {
    const searched = searchParts(all, query)
    const byCat = category ? searched.filter((e) => (e.part.category?.trim() || "") === category) : searched
    return lowOnly ? byCat.filter((e) => isPartLow(e.part)) : byCat
  }, [all, query, lowOnly, category])

  const lowCount = all.filter((e) => isPartLow(e.part)).length

  // Keep the open dialog bound to the live part (counts change as jobs run).
  const liveSelected = selected ? (state.parts?.[selected.id] ?? null) : null

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-5">
        <h1 className="text-balance text-2xl font-semibold text-foreground">All hardware</h1>
        <p className="mt-1 text-pretty text-sm text-muted-foreground">
          Search every part across all units. Tap one to take pieces out, store more, or delete it.
        </p>
      </header>

      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, category, tag or location…"
            aria-label="Search hardware"
            className="pl-9"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button
          variant={lowOnly ? "primary" : "outline"}
          onClick={() => setLowOnly((v) => !v)}
          className="shrink-0"
          disabled={lowCount === 0 && !lowOnly}
        >
          <TriangleAlert className="h-4 w-4" /> Low stock
          {lowCount > 0 && (
            <span
              className={cn(
                "ml-1 rounded-full px-1.5 text-xs font-semibold",
                lowOnly ? "bg-primary-foreground/20" : "bg-warning/15 text-warning",
              )}
            >
              {lowCount}
            </span>
          )}
        </Button>
      </div>

      {/* Category filter chips — narrow the list to one category at a time. */}
      {categories.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by category">
          <FilterChip label="All" active={category === null} onClick={() => setCategory(null)} />
          {categories.map((c) => (
            <FilterChip key={c} label={c} active={category === c} onClick={() => setCategory(c)} />
          ))}
        </div>
      )}

      {results.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-background/40 px-6 py-16 text-center">
          <span
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"
            aria-hidden
          >
            <PackageSearch className="h-6 w-6" />
          </span>
          <p className="text-sm text-muted-foreground">
            {all.length === 0
              ? "No hardware stored yet. Add some from the Home tab."
              : "Nothing matches your search."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {results.map((entry) => (
            <PartRow key={entry.part.id} entry={entry} onOpen={() => setSelected(entry.part)} />
          ))}
        </ul>
      )}

      <HardwareSlotDialog
        part={liveSelected}
        onClose={() => setSelected(null)}
        onEdit={(p) => {
          setSelected(null)
          setEditPart(p)
        }}
      />
      <HardwareForm
        open={!!editPart}
        initial={editPart}
        onClose={() => setEditPart(null)}
        onSubmit={(p) => {
          dispatch({ type: "UPSERT_PART", part: p })
          setEditPart(null)
        }}
      />
    </div>
  )
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-8 rounded-full border px-3 text-sm font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
      )}
    >
      {label}
    </button>
  )
}

function PartRow({ entry, onOpen }: { entry: StoredPart; onOpen: () => void }) {
  const { part, nodeName, shelfName, loc } = entry
  const low = isPartLow(part)

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-xl border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
      >
        <PartThumb color={part.color} size={44} imageUrl={part.imageUrl} name={part.name} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{part.name}</span>
            {low && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                <TriangleAlert className="h-3 w-3" /> low
              </span>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {part.category ? `${part.category} · ` : ""}
            {part.count} pcs · {formatGrams(partWeightGrams(part))}
          </p>
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground/80">
            <MapPin className="h-3 w-3 shrink-0" />
            {nodeName} · {shelfName} · slot {loc.slot + 1}
          </p>
        </div>
        <span
          className={cn("text-lg font-semibold tabular-nums", low ? "text-warning" : "text-foreground")}
          aria-hidden
        >
          {part.count}
        </span>
      </button>
    </li>
  )
}
