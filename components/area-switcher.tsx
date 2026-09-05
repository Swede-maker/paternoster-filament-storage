"use client"

import { Boxes, Layers, Printer } from "lucide-react"
import type { TopArea } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Top-level switcher between the tracking areas (Filament, Hardware, Printers).
 * Each area is its own self-contained world with its own bottom nav; this bar
 * is the only place they meet. Rendered as a segmented control so the active
 * area reads at a glance.
 */
export function AreaSwitcher({
  area,
  onChange,
}: {
  area: TopArea
  onChange: (area: TopArea) => void
}) {
  const areas: { id: TopArea; label: string; Icon: typeof Layers }[] = [
    { id: "filament", label: "Filament", Icon: Layers },
    { id: "hardware", label: "Hardware", Icon: Boxes },
    { id: "printers", label: "Printers", Icon: Printer },
  ]
  return (
    <div
      role="tablist"
      aria-label="Tracking area"
      className="flex items-center gap-1 rounded-full border border-border bg-card/60 p-1"
    >
      {areas.map(({ id, label, Icon }) => {
        const active = area === id
        return (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={cn(
              "flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </button>
        )
      })}
    </div>
  )
}
