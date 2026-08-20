"use client"

import { useMemo, useState } from "react"
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Boxes,
  Filter,
  MapPin,
  Search,
  X,
} from "lucide-react"
import { useStore } from "@/lib/store"
import { useFlow } from "./flow-controller"
import { storedSpools, searchSpools, type StoredEntry } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import { formatRemaining, formatGrams, spoolFill } from "@/lib/filament"
import { SpoolDisc, discColor2 } from "./spool"
import { Button } from "./ui/button"

type WeightSort = "none" | "heaviest" | "lightest"

/**
 * "All Filament In Storage" tab. A read-and-act inventory of EVERY spool sitting
 * in any storage unit (paternoster, shelf, or library). Mirrors the Library
 * view's filter/sort language (search + material/brand/color + weight sort) and
 * adds a storage-unit facet plus a full physical location on each row. Tapping a
 * spool hands it to the Home view (via the flow inspect bridge) which switches
 * to that unit and opens the load / take-out action hub.
 */
export function InventoryView({ onGoHome }: { onGoHome: () => void }) {
  const { state } = useStore()
  const flow = useFlow()

  const [query, setQuery] = useState("")
  const [materials, setMaterials] = useState<string[]>([])
  const [brands, setBrands] = useState<string[]>([])
  const [colors, setColors] = useState<string[]>([])
  const [units, setUnits] = useState<string[]>([])
  const [weightSort, setWeightSort] = useState<WeightSort>("none")

  // Every stored spool across all units, with its node + shelf/slot location.
  const entries = useMemo<StoredEntry[]>(() => storedSpools(state), [state])

  // Facet values — only what's actually present in storage right now.
  const facets = useMemo(() => {
    const mat = new Set<string>()
    const brd = new Set<string>()
    const col = new Map<string, string>() // label -> swatch color
    const uni = new Map<string, string>() // nodeId -> nodeName
    for (const { spool, nodeId, nodeName } of entries) {
      mat.add(spool.material)
      brd.add(spool.brand)
      const label = spool.colorName?.trim() || spool.color
      if (!col.has(label)) col.set(label, spool.color)
      if (!uni.has(nodeId)) uni.set(nodeId, nodeName)
    }
    return {
      materials: [...mat].sort(),
      brands: [...brd].sort(),
      colors: [...col.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      units: [...uni.entries()].sort((a, b) => a[1].localeCompare(b[1])),
    }
  }, [entries])

  const filtered = useMemo(() => {
    let list = searchSpools(entries, query).filter(({ spool, nodeId }) => {
      if (materials.length && !materials.includes(spool.material)) return false
      if (brands.length && !brands.includes(spool.brand)) return false
      if (units.length && !units.includes(nodeId)) return false
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
  }, [entries, query, materials, brands, colors, units, weightSort])

  const activeFilters =
    materials.length + brands.length + colors.length + units.length + (weightSort !== "none" ? 1 : 0)

  function toggle(list: string[], setList: (v: string[]) => void, value: string) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value])
  }

  function clearAll() {
    setMaterials([])
    setBrands([])
    setColors([])
    setUnits([])
    setWeightSort("none")
  }

  // Hand the spool off to Home, which focuses its unit and opens the action hub.
  function act(entry: StoredEntry) {
    flow.requestInspect(entry.spool, { nodeId: entry.nodeId, shelf: entry.loc.shelf, slot: entry.loc.slot })
    onGoHome()
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <Boxes className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-lg font-semibold text-foreground">All Filament In Storage</h1>
          <p className="text-sm text-muted-foreground">
            Every spool across all your storage, searchable in one place.
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search color, type, brand, unit, shelf…"
          className="h-11 w-full rounded-xl border border-border bg-card pl-10 pr-10 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
          aria-label="Search stored filament"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Filter / sort toolbar */}
      <div className="space-y-3 rounded-2xl border border-border bg-card/60 p-3">
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
        </div>

        {entries.length > 0 && (
          <div className="flex flex-col gap-2">
            {facets.units.length > 1 && (
              <FacetRow label="Unit">
                {facets.units.map(([id, name]) => (
                  <Chip key={id} active={units.includes(id)} onClick={() => toggle(units, setUnits, id)}>
                    {name}
                  </Chip>
                ))}
              </FacetRow>
            )}
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

      {/* Results */}
      {entries.length === 0 ? (
        <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card/40 p-6 text-center">
          <p className="text-sm text-muted-foreground text-balance">
            Nothing in storage yet. Place filament from the Home tab and it&apos;ll show up here.
          </p>
          <Button onClick={onGoHome}>Go to Home</Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card/40 p-6 text-center">
          <p className="text-sm text-muted-foreground">No spools match your search or filters.</p>
          <Button variant="outline" onClick={clearAll}>
            <X className="h-4 w-4" /> Clear filters
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((entry) => {
            const { spool, nodeName, shelfName, loc } = entry
            const location = `${nodeName} · ${shelfName} · Slot ${loc.slot + 1}`
            return (
              <li key={spool.id}>
                <button
                  type="button"
                  onClick={() => act(entry)}
                  disabled={!!state.job}
                  className={cn(
                    "flex w-full items-center gap-4 rounded-xl border border-border bg-card p-3 text-left transition-colors",
                    "hover:border-primary/50 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-60",
                  )}
                >
                  <SpoolDisc
                    color={spool.color}
                    color2={discColor2(spool)}
                    size={48}
                    fill={spoolFill(spool)}
                    boxed={!!spool.containerId}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-semibold text-foreground">{spool.material}</span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full border border-border"
                          style={{ backgroundColor: spool.color }}
                          aria-hidden
                        />
                        {spool.colorName?.trim() || spool.color}
                      </span>
                      <span className="text-xs text-muted-foreground">· {spool.brand}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />
                      <span className="truncate">{location}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-medium text-foreground">{formatGrams(spool.grams)}</div>
                    <div className="text-xs text-muted-foreground">{formatRemaining(spool)}</div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
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
