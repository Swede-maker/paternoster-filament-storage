"use client"

import { Search, Scale } from "lucide-react"
import { useStore } from "@/lib/store"
import { getStats } from "@/lib/selectors"
import { formatGrams } from "@/lib/filament"

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

export function StatsBar({ onSearchClick }: { onSearchClick: () => void }) {
  const { state } = useStore()
  const stats = getStats(state)

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
        <StatTile label="Empty Slots" value={String(stats.emptySlots)} total={String(stats.totalSlots)} accent="text-success" />
        <StatTile label="Used Slots" value={String(stats.usedSlots)} total={String(stats.totalSlots)} accent="text-primary" />
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
