"use client"

import { Boxes, Layers } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

type StartArea = "filament" | "hardware"

const OPTIONS: { value: StartArea; label: string; Icon: typeof Layers }[] = [
  { value: "filament", label: "Filament", Icon: Layers },
  { value: "hardware", label: "Hardware", Icon: Boxes },
]

/**
 * Picks which area opens on load/refresh. Rendered in both the filament and
 * hardware Settings tabs; both read and write the same `settings.startArea`,
 * so the selection is identical wherever it's viewed.
 */
export function StartAreaToggle() {
  const { state, dispatch } = useStore()
  const available: Record<StartArea, boolean> = {
    filament: state.nodes.some((n) => n.system !== "hardware"),
    hardware: state.nodes.some((n) => n.system === "hardware"),
  }
  const saved: StartArea = state.settings.startArea ?? "filament"
  const current: StartArea = available[saved] ? saved : saved === "filament" ? "hardware" : "filament"
  const missing = OPTIONS.filter((o) => !available[o.value])

  return (
    <div className="flex flex-col gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">Open on start</p>
        <p className="text-xs text-muted-foreground text-pretty">
          The section shown when the page loads or refreshes. Same setting in Filament and Hardware.
        </p>
      </div>
      <div role="radiogroup" aria-label="Section to open on start" className="grid grid-cols-2 gap-1 rounded-xl border border-border bg-secondary p-1">
        {OPTIONS.map(({ value, label, Icon }) => {
          const selected = current === value
          const disabled = !available[value]
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              aria-describedby={disabled ? "start-area-hint" : undefined}
              onClick={() => dispatch({ type: "UPDATE_SETTINGS", settings: { startArea: value } })}
              className={cn(
                "flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors",
                selected
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
                disabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          )
        })}
      </div>
      {missing.length > 0 && (
        <p id="start-area-hint" className="text-xs text-muted-foreground text-pretty">
          {missing.map((m) => m.label).join(" and ")} has no storage units yet. Add one to choose it here.
        </p>
      )}
    </div>
  )
}
