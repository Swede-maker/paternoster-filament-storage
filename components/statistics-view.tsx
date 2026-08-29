"use client"

import { useMemo, useState } from "react"
import { BarChart3 } from "lucide-react"
import { useStore } from "@/lib/store"
import { shelfLabel, getStats } from "@/lib/selectors"
import {
  filterBuckets,
  presetRange,
  snapshotsInRange,
  parseDayKey,
  type DayRange,
} from "@/lib/statistics"
import {
  UsageByMaterialCard,
  UsageByColorCard,
  PrinterUsageCard,
  StorageOverTimeCard,
  StorageByShelfCard,
  type ShelfUsage,
} from "./statistics-charts"
import { ResizablePanel } from "./resizable-panel"
import { cn } from "@/lib/utils"

type Preset = "7d" | "30d" | "month" | "year" | "all" | "custom"

const PRESETS: { id: Preset; label: string }[] = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "month", label: "This month" },
  { id: "year", label: "This year" },
  { id: "all", label: "All time" },
  { id: "custom", label: "Custom" },
]

/** Human label for the active range, echoed under each card title. */
function rangeToLabel(preset: Preset, range: DayRange): string {
  if (preset === "custom") {
    const from = parseDayKey(range.from).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    const to = parseDayKey(range.to).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    return `${from} – ${to}`
  }
  return PRESETS.find((p) => p.id === preset)?.label ?? ""
}

export function StatisticsView() {
  const { state } = useStore()
  const printers = state.printers
  const [preset, setPreset] = useState<Preset>("30d")
  const [printerId, setPrinterId] = useState<string>("all")
  // Custom range endpoints (only used when preset === "custom").
  const today = new Date()
  const monthAgo = new Date()
  monthAgo.setDate(monthAgo.getDate() - 29)
  const [customFrom, setCustomFrom] = useState(monthAgo.toISOString().slice(0, 10))
  const [customTo, setCustomTo] = useState(today.toISOString().slice(0, 10))

  const range: DayRange = useMemo(
    () => (preset === "custom" ? { from: customFrom, to: customTo } : presetRange(preset)),
    [preset, customFrom, customTo],
  )
  const rangeLabel = rangeToLabel(preset, range)

  // Filter the consumption log by the active range + printer once, shared by
  // every consumption-based card.
  const buckets = useMemo(
    () => filterBuckets(state.consumptionLog ?? [], range, printerId),
    [state.consumptionLog, range, printerId],
  )
  const snapshots = useMemo(
    () => snapshotsInRange(state.storageSnapshots ?? [], range),
    [state.storageSnapshots, range],
  )

  // Storage-by-shelf: one view per storage unit plus an "All storage" aggregate,
  // so the user can pick which unit's live shelf occupancy to inspect. Without
  // this the card only ever showed the master node, hiding secondary units.
  const [shelfNodeId, setShelfNodeId] = useState<string>("all")
  const shelfViews = useMemo(() => {
    const perNode = state.nodes.map((node) => {
      const rows: ShelfUsage[] = node.slots.map((row, shelf) => ({
        label: shelfLabel(node, shelf),
        used: row.filter(Boolean).length,
        total: row.length,
      }))
      const used = rows.reduce((s, r) => s + r.used, 0)
      const total = rows.reduce((s, r) => s + r.total, 0)
      return { id: node.id, name: node.name, shelves: rows, usedSlots: used, totalSlots: total }
    })
    // "All storage": every shelf across units, labelled by unit when there is
    // more than one so identically-numbered shelves stay distinguishable.
    const multi = perNode.length > 1
    const allShelves: ShelfUsage[] = perNode.flatMap((v) =>
      v.shelves.map((r) => ({ ...r, label: multi ? `${v.name} · ${r.label}` : r.label })),
    )
    const stats = getStats(state)
    const all = { id: "all", name: "All storage", shelves: allShelves, usedSlots: stats.usedSlots, totalSlots: stats.totalSlots }
    return [all, ...perNode]
  }, [state])

  const activeShelfView = shelfViews.find((v) => v.id === shelfNodeId) ?? shelfViews[0]
  const shelfOptions = shelfViews.map((v) => ({ id: v.id, name: v.name }))

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <header className="mb-5">
        <h1 className="flex items-center gap-2 text-balance text-2xl font-semibold text-foreground">
          <BarChart3 className="h-6 w-6 text-primary" />
          Statistik
        </h1>
        <p className="mt-1 text-pretty text-sm text-muted-foreground">
          Filament consumption and storage trends. Data is recorded going forward as your printers run.
        </p>
      </header>

      {/* Filters: date-range presets, optional custom dates, and printer. */}
      <div className="mb-6 flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                preset === p.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {preset === "custom" && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-1.5 text-muted-foreground">
                From
                <input
                  type="date"
                  value={customFrom}
                  max={customTo}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-foreground"
                />
              </label>
              <label className="flex items-center gap-1.5 text-muted-foreground">
                To
                <input
                  type="date"
                  value={customTo}
                  min={customFrom}
                  max={today.toISOString().slice(0, 10)}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-foreground"
                />
              </label>
            </div>
          )}

          <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            Printer
            <select
              value={printerId}
              onChange={(e) => setPrinterId(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-foreground"
            >
              <option value="all">All printers</option>
              {printers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Cards. Two columns on desktop, matching the reference dashboard. Each
          card sits in a ResizablePanel so its height can be dragged from the
          bottom edge; the chosen size is remembered per device. */}
      <div className="grid items-start gap-4 pb-4 lg:grid-cols-2">
        <ResizablePanel
          storageKey="pax:stats:storageOverTimeV1"
          defaultHeight={420}
          minHeight={260}
          label="storage usage over time"
          className="lg:col-span-2"
        >
          <StorageOverTimeCard snapshots={snapshots} rangeLabel={rangeLabel} />
        </ResizablePanel>
        <ResizablePanel storageKey="pax:stats:byMaterialV1" defaultHeight={380} autoFit label="usage by material">
          <UsageByMaterialCard buckets={buckets} rangeLabel={rangeLabel} />
        </ResizablePanel>
        <ResizablePanel storageKey="pax:stats:byColorV1" defaultHeight={380} autoFit label="usage by color">
          <UsageByColorCard buckets={buckets} rangeLabel={rangeLabel} />
        </ResizablePanel>
        <ResizablePanel storageKey="pax:stats:printerUsageV1" defaultHeight={380} autoFit label="printer usage">
          <PrinterUsageCard buckets={buckets} rangeLabel={rangeLabel} />
        </ResizablePanel>
        <ResizablePanel
          storageKey="pax:stats:byShelfV1"
          defaultHeight={380}
          maxHeight={720}
          autoFit
          label="storage by shelf"
        >
          <StorageByShelfCard
            shelves={activeShelfView?.shelves ?? []}
            usedSlots={activeShelfView?.usedSlots ?? 0}
            totalSlots={activeShelfView?.totalSlots ?? 0}
            options={shelfOptions}
            selectedId={activeShelfView?.id ?? "all"}
            onSelect={setShelfNodeId}
          />
        </ResizablePanel>
      </div>
    </div>
  )
}
