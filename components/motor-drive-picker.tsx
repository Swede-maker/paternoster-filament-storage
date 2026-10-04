"use client"

import { CircleGauge, Waypoints } from "lucide-react"
import { cn } from "@/lib/utils"
import type { MotorMode } from "@/lib/types"

/**
 * Two-way choice between the DC bridge and the iSV57T servo pair. Used by the
 * setup wizard, the add-unit form and the per-node settings editor so the
 * wording and look stay identical everywhere the decision is made.
 */
export function MotorDrivePicker({
  value,
  onChange,
  disabled,
  compact,
}: {
  value: MotorMode
  onChange: (mode: MotorMode) => void
  disabled?: boolean
  /** Single-line variant for tight settings rows. */
  compact?: boolean
}) {
  const options: { mode: MotorMode; title: string; detail: string; icon: typeof CircleGauge }[] = [
    {
      mode: "dc",
      title: "Standard DC motors",
      detail:
        "Two brushed motors, one per side, each on its own BTS7960 / IBT-2 motor driver. Speed is PWM duty; each motor can be jogged for a set number of milliseconds.",
      icon: CircleGauge,
    },
    {
      mode: "servo",
      title: "Integrated servos (PUL/DIR)",
      detail: "Two iSV57T servos stepped in sync. Speed is pulse rate; each motor can be micro-jogged.",
      icon: Waypoints,
    },
  ]

  return (
    <div role="radiogroup" aria-label="Motor drive" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((opt) => {
        const selected = value === opt.mode
        const Icon = opt.icon
        return (
          <button
            key={opt.mode}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(opt.mode)}
            className={cn(
              "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-50",
              selected
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
              compact && "items-center py-2",
            )}
          >
            <Icon className={cn("h-5 w-5 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{opt.title}</span>
              {!compact && (
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground text-pretty">
                  {opt.detail}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function motorModeLabel(mode: MotorMode | undefined): string {
  return mode === "servo" ? "servo · PUL/DIR" : "2× DC · BTS7960"
}
