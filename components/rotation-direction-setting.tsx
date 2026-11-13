"use client"

import { RotateCw, RotateCcw } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { Checkbox } from "./ui/field"

const OPTIONS = [
  {
    value: "home" as const,
    label: "Same as homing",
    hint: "Default. Turns the way the Home sweep runs.",
    Icon: RotateCw,
  },
  {
    value: "reverse" as const,
    label: "Opposite to homing",
    hint: "Turns against the Home sweep.",
    Icon: RotateCcw,
  },
]

/**
 * Global "always rotate the same way" switch. Applies to every motorized
 * carousel; homing keeps its own fixed direction regardless.
 */
export function RotationDirectionSetting() {
  const { state, dispatch } = useStore()
  const mode = state.settings.oneWayRotation ?? "off"
  const enabled = mode !== "off"
  const set = (oneWayRotation: "off" | "home" | "reverse") =>
    dispatch({ type: "UPDATE_SETTINGS", settings: { oneWayRotation } })

  return (
    <div className="flex flex-col gap-3">
      <Checkbox
        checked={enabled}
        onChange={(v) => set(v ? "home" : "off")}
        label="Always rotate the same way"
        description="Every move turns in one fixed direction instead of the shortest way round. Jobs are then ordered as one sweep, so a queued shelf is never passed and the carousel never needs an extra turn to come back for it. Homing is not affected."
      />
      {enabled && (
        <div role="radiogroup" aria-label="Fixed rotation direction" className="grid gap-2 sm:grid-cols-2">
          {OPTIONS.map(({ value, label, hint, Icon }) => {
            const selected = mode === value
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set(value)}
                className={cn(
                  "flex items-start gap-2 rounded-xl border p-3 text-left transition-colors",
                  selected ? "border-primary bg-primary/10" : "border-border bg-background/50 hover:border-primary/50",
                )}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">{hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
