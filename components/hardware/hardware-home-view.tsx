"use client"

import { useMemo, useState } from "react"
import { Boxes, Package, Server, Plus, Search, Scale, Loader2, MapPin, AlertTriangle, X } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { formatGrams } from "@/lib/filament"
import {
  activeNode,
  nodesForSystem,
  getHardwareStats,
  isPartLow,
  shelfLabel,
  storedParts,
  searchParts,
  partWeightGrams,
  type StoredPart,
} from "@/lib/selectors"
import { placeNewPart } from "@/lib/hardware-flow"
import { Button } from "../ui/button"
import { Input } from "../ui/field"
import { HardwareCarousel } from "./hardware-carousel"
import { HardwareForm } from "./hardware-form"
import { HardwareSlotDialog } from "./hardware-slot-dialog"
import { HardwareQueueTray } from "./hardware-queue-tray"
import { HardwareSidebar } from "./hardware-sidebar"
import { PartBox, PartThumb, HardwareEmptySlot } from "./part-box"
import type { HardwarePart, StorageNode } from "@/lib/types"

export function HardwareHomeView() {
  const { state, dispatch } = useStore()
  const nodes = nodesForSystem(state, "hardware")
  // The shared activeNodeId may still point at a filament unit (e.g. right after
  // launch); fall back to the first hardware unit so this view always shows one.
  const shared = activeNode(state)
  const node = shared.system === "hardware" ? shared : nodes[0]
  const [addOpen, setAddOpen] = useState(false)
  const [slotPart, setSlotPart] = useState<HardwarePart | null>(null)
  // Part currently being edited (opens the form prefilled; save = UPSERT_PART).
  const [editPart, setEditPart] = useState<HardwarePart | null>(null)
  // When storage is full we surface a message instead of silently dropping a part.
  const [placeError, setPlaceError] = useState<string | null>(null)
  // The exact empty slot the user tapped to add into; null when adding via the +
  // button (auto-balanced placement).
  const [targetSlot, setTargetSlot] = useState<{ shelf: number; slot: number } | null>(null)
  // Inline search over every part in every hardware unit (name/category/tag/location).
  const [query, setQuery] = useState("")
  const searchResults = useMemo(
    () => (query.trim() ? searchParts(storedParts(state), query).slice(0, 8) : []),
    [state, query],
  )

  // No hardware units yet — point the user to Settings to create one.
  if (nodes.length === 0 || !node) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <Server className="h-7 w-7" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-foreground">No hardware storage yet</h2>
          <p className="mt-1 max-w-sm text-pretty text-sm text-muted-foreground">
            Add a hardware paternoster, shelf, or library from the Settings tab to start tracking bolts, nuts and parts.
          </p>
        </div>
      </div>
    )
  }

  const stats = getHardwareStats(state)
  const type = node.type ?? "paternoster"
  const isManual = type === "shelf" || type === "library"

  // The active-job target on THIS unit, used to flash the destination slot.
  const currentItem = state.job ? state.job.items[state.job.currentIndex] : null
  const jobTarget =
    currentItem && currentItem.nodeId === node.id ? { shelf: currentItem.shelf, slot: currentItem.slot } : null

  function handleAdd(part: HardwarePart) {
    const target = targetSlot ? { nodeId: node.id, shelf: targetSlot.shelf, slot: targetSlot.slot } : undefined
    const ok = placeNewPart(state, dispatch, part, node.id, target)
    if (!ok) setPlaceError("All hardware storage is full. Add another unit in Settings, or free a slot first.")
    setTargetSlot(null)
  }

  // Tapping a box: a filled one opens its manage dialog; an empty one starts a
  // new-part form pre-aimed at that exact slot.
  function openSlot(shelf: number, slot: number) {
    if (state.job) return
    const id = node.slots[shelf]?.[slot]
    const part = id ? state.parts[id] : null
    if (part) {
      setSlotPart(part)
    } else {
      setPlaceError(null)
      setTargetSlot({ shelf, slot })
      setAddOpen(true)
    }
  }

  // Pick a search result: switch to its unit so the carousel matches, then open
  // the slot dialog (take out / store more / edit) — the same flow as tapping a box.
  function openFromSearch(entry: StoredPart) {
    if (entry.nodeId !== node.id) dispatch({ type: "SET_ACTIVE_NODE", id: entry.nodeId })
    setSlotPart(entry.part)
    setQuery("")
  }

  return (
    <div className="flex flex-col gap-3 p-3 lg:min-h-0 lg:flex-1 lg:flex-row">
      {/* Left control panel — carousel only. Manual shelf/library units have no
          motor to drive and render every shelf full-width, so (like the filament
          side) they skip the sidebar and reclaim the width. */}
      {!isManual && (
        <aside className="flex w-full shrink-0 flex-col rounded-2xl border border-border bg-panel lg:w-[300px] lg:min-h-0">
          <HardwareSidebar node={node} />
        </aside>
      )}

      {/* Main column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      {/* Stats + search hint */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search parts by name, category, tag or location…"
            aria-label="Search hardware parts"
            className="h-14 pl-12 pr-10 text-base"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {/* Live results dropdown — pick one to jump to its unit and manage it. */}
          {query.trim() && (
            <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-30 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
              {searchResults.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">No parts match &ldquo;{query}&rdquo;.</p>
              ) : (
                <ul className="max-h-80 overflow-y-auto py-1">
                  {searchResults.map((entry) => {
                    const low = isPartLow(entry.part)
                    return (
                      <li key={entry.part.id}>
                        <button
                          type="button"
                          onClick={() => openFromSearch(entry)}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-primary/10"
                        >
                          <PartThumb
                            color={entry.part.color}
                            size={36}
                            imageUrl={entry.part.imageUrl}
                            name={entry.part.name}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-foreground">{entry.part.name}</span>
                              {low && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                                  <AlertTriangle className="h-3 w-3" /> low
                                </span>
                              )}
                            </div>
                            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                              <MapPin className="h-3 w-3 shrink-0" />
                              {entry.nodeName} · {entry.shelfName} · slot {entry.loc.slot + 1}
                            </p>
                          </div>
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {entry.part.count} pcs · {formatGrams(partWeightGrams(entry.part))}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 lg:flex lg:gap-3">
          <StatTile label="Empty Slots" value={String(stats.emptySlots)} total={String(stats.totalSlots)} accent="text-success" />
          <StatTile label="Used Slots" value={String(stats.usedSlots)} total={String(stats.totalSlots)} accent="text-primary" />
          <StatTile
            label="Total Weight"
            value={formatGrams(stats.totalGrams)}
            accent="text-foreground"
            icon={<Scale className="h-4 w-4 text-muted-foreground" />}
          />
        </div>
      </div>

      {/* Unit switcher */}
      {nodes.length > 1 && (
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Hardware units">
          {nodes.map((n) => {
            const active = n.id === node.id
            const nt = n.type ?? "paternoster"
            const busy = nt === "paternoster" && n.machine.status === "moving"
            const Icon = nt === "library" ? Boxes : nt === "shelf" ? Package : Server
            return (
              <button
                key={n.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => dispatch({ type: "SET_ACTIVE_NODE", id: n.id })}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-background/50 text-muted-foreground hover:border-primary/50",
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="font-medium">{n.name}</span>
                {n.area ? (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                    <MapPin className="h-3 w-3" />
                    {n.area}
                  </span>
                ) : (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{nt}</span>
                )}
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
              </button>
            )
          })}
        </div>
      )}

      {/* Add action */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground text-pretty">
          {state.job
            ? "Operation in progress — tap + to queue another part behind it."
            : "Tap a filled box to take out or store more, tap an empty box to add hardware there, or tap + to auto-place."}
        </p>
        <Button
          size="icon"
          aria-label="Add new hardware"
          title="Add new hardware"
          className="h-12 w-12 shrink-0 rounded-xl shadow-sm"
          onClick={() => {
            setPlaceError(null)
            setTargetSlot(null)
            setAddOpen(true)
          }}
        >
          <Plus className="h-7 w-7" strokeWidth={2.5} />
        </Button>
      </div>

      {placeError && (
        <p className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {placeError}
        </p>
      )}

      {/* Storage view */}
      {isManual ? (
        <HardwareGrid node={node} onSlotClick={openSlot} highlight={jobTarget} />
      ) : (
        <HardwareCarousel node={node} onSlotClick={openSlot} highlight={jobTarget} />
      )}
      </div>

      <HardwareForm
        open={addOpen}
        onClose={() => {
          setAddOpen(false)
          setTargetSlot(null)
        }}
        onSubmit={handleAdd}
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
      <HardwareSlotDialog
        part={slotPart}
        onClose={() => setSlotPart(null)}
        onEdit={(p) => {
          setSlotPart(null)
          setEditPart(p)
        }}
      />
      <HardwareQueueTray />
    </div>
  )
}

/** Manual (shelf / library) hardware unit rendered as a flat grid of boxes. */
function HardwareGrid({
  node,
  onSlotClick,
  highlight,
}: {
  node: StorageNode
  onSlotClick: (shelf: number, slot: number) => void
  highlight: { shelf: number; slot: number } | null
}) {
  const { state } = useStore()
  return (
    <div className="flex-1 space-y-3 rounded-2xl border border-border bg-panel p-3">
      {node.slots.map((row, shelf) => {
        const used = row.filter(Boolean).length
        return (
        <section
          key={shelf}
          aria-label={shelfLabel(node, shelf)}
          className="rounded-xl border border-border bg-background/40 p-3"
        >
          <header className="mb-2 flex items-center gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {shelfLabel(node, shelf)}
            </p>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {used}/{row.length}
            </span>
          </header>
          <div className="flex flex-wrap gap-3">
            {row.map((id, slot) => {
              const part = id ? state.parts[id] : null
              const low = part ? isPartLow(part) : false
              const isHi = highlight && highlight.shelf === shelf && highlight.slot === slot
              return (
                <button
                  key={slot}
                  type="button"
                  onClick={() => onSlotClick(shelf, slot)}
                  className={cn(
                    "flex w-20 flex-col items-center gap-1 rounded-xl p-2 transition-colors hover:bg-primary/10",
                    isHi && "animate-slot-flash",
                  )}
                >
                  <span className="relative flex h-14 items-center justify-center">
                    {part ? (
                      <PartBox color={part.color} size={56} imageUrl={part.imageUrl} name={part.name} />
                    ) : (
                      <HardwareEmptySlot size={56} />
                    )}
                    {low && (
                      <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-warning text-background">
                        <AlertTriangle className="h-2.5 w-2.5" />
                      </span>
                    )}
                  </span>
                  <span className="w-full truncate text-center text-[11px] font-medium text-foreground">
                    {part ? part.name : `Slot ${slot + 1}`}
                  </span>
                  {part && <span className="text-[10px] text-muted-foreground">{part.count} pcs</span>}
                </button>
              )
            })}
          </div>
        </section>
        )
      })}
    </div>
  )
}

function StatTile({
  label,
  value,
  total,
  accent,
  icon,
}: {
  label: string
  value: string
  total?: string
  accent: string
  icon?: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col justify-center rounded-xl border border-border bg-card px-3 py-2.5 lg:min-w-[7rem] lg:px-4">
      <span className="truncate text-[11px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="mt-0.5 flex items-baseline gap-1 font-mono">
        {icon}
        <span className={`text-xl font-bold lg:text-2xl ${accent}`}>{value}</span>
        {total && <span className="text-sm text-muted-foreground">/ {total}</span>}
      </span>
    </div>
  )
}
