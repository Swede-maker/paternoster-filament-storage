"use client"

import { Search, Scale } from "lucide-react"
import { useStore } from "@/lib/store"
import { activeNode, getNodeStats, getStats, nodeSystem } from "@/lib/selectors"
import { formatGrams } from "@/lib/filament"

function StatTile({
  label,
  value,
  total,
  accent,
  icon,
  footnote,
}: {
  label: string
  value: string
  total?: string
  accent: string
  icon?: React.ReactNode
  footnote?: string
}) {
  return (
    <div className="flex min-w-0 flex-col justify-center rounded-xl border border-border bg-card px-3 py-2.5 lg:min-w-[7rem] lg:px-4">
      <span className="line-clamp-2 break-words text-[11px] uppercase leading-tight tracking-wider text-muted-foreground">{label}</span>
      <span className="mt-0.5 flex items-baseline gap-1 font-mono">
        {icon}
        <span className={`text-xl font-bold lg:text-2xl ${accent}`}>{value}</span>
        {total && <span className="text-sm text-muted-foreground">/ {total}</span>}
      </span>
      {footnote && (
        <span className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{footnote}</span>
      )}
    </div>
  )
}

export function StatsBar({ onSearchClick }: { onSearchClick: () => void }) {
  const { state } = useStore()
  const stats = getStats(state)
  const selected = activeNode(state)
  const unit = selected && nodeSystem(selected) === "filament" ? getNodeStats(state, selected) : null
  const slotsShown = unit ?? stats
  const allFootnote = (count: number) => (unit ? `All ${count}/${stats.totalSlots}` : undefined)

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
      <button
        type="button"
        onClick={onSearchClick}
        className="flex h-14 flex-1 items-center gap-3 rounded-xl border border-border bg-card px-4 text-left text-muted-foreground transition-colors hover:border-primary/50"
      >
        <Search className="h-5 w-5 shrink-0" />
        <span className="truncate text-base">Search filament (color, type, brand, slot…)</span>
      </button>
      <div className="grid grid-cols-3 gap-2 lg:flex lg:gap-3">
        <StatTile
          label={unit ? `Empty · ${selected.name}` : "Empty Slots"}
          value={String(slotsShown.emptySlots)}
          total={String(slotsShown.totalSlots)}
          accent="text-success"
          footnote={allFootnote(stats.emptySlots)}
        />
        <StatTile
          label={unit ? `Used · ${selected.name}` : "Used Slots"}
          value={String(slotsShown.usedSlots)}
          total={String(slotsShown.totalSlots)}
          accent="text-primary"
          footnote={allFootnote(stats.usedSlots)}
        />
        <StatTile
          label="Total Filament"
          value={formatGrams(stats.totalGrams)}
          accent="text-foreground"
          icon={<Scale className="h-4 w-4 text-muted-foreground" />}
        />
      </div>
    </div>
  )
}
