"use client"

import { CircleGauge, Waypoints } from "lucide-react"
import { cn } from "@/lib/utils"
import type { MotorMode, PulseDrive } from "@/lib/types"
import { PULSE_DRIVE_PROFILES, pulseDriveProfile } from "@/lib/filament"

/**
 * Two-way choice between the DC bridge and a pulse + direction drive, plus —
 * once PUL/DIR is picked — which kind of drive sits on the lines (integrated
 * servo, AC servo or closed-loop stepper). Used by the setup wizard, the
 * add-unit forms and the per-node settings editor so the wording and look stay
 * identical everywhere the decision is made.
 */
export function MotorDrivePicker({
  value,
  onChange,
  pulseDrive,
  onPulseDriveChange,
  disabled,
  compact,
}: {
  value: MotorMode
  onChange: (mode: MotorMode) => void
  /** Which PUL/DIR drive; the sub-picker is shown only when both are given. */
  pulseDrive?: PulseDrive
  onPulseDriveChange?: (drive: PulseDrive) => void
  disabled?: boolean
  /** Single-line variant for tight settings rows. */
  compact?: boolean
}) {
  const options: { mode: MotorMode; title: string; detail: string; icon: typeof CircleGauge }[] = [
    {
      mode: "dc",
      title: "Standard DC motor",
      detail:
        "One brushed motor per carousel on a BTS7960 / IBT-2 motor driver. Speed is PWM duty; the motor can be jogged for a set number of milliseconds. A second driver lets one Pi run a Left and a Right carousel.",
      icon: CircleGauge,
    },
    {
      mode: "servo",
      title: "Closed-loop stepper or servo (PUL/DIR)",
      detail:
        "Two pulse + direction drives stepped in sync from one timer — integrated servos, AC servos or closed-loop steppers. Speed is pulse rate; each motor can be micro-jogged.",
      icon: Waypoints,
    },
  ]
  const showDrives = value === "servo" && pulseDrive !== undefined && onPulseDriveChange !== undefined

  return (
    <div className="flex flex-col gap-2">
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

      {showDrives && (
        <div
          role="radiogroup"
          aria-label="Pulse and direction drive type"
          className="grid grid-cols-1 gap-2 sm:grid-cols-3"
        >
          {PULSE_DRIVE_PROFILES.map((p) => {
            const selected = pulseDrive === p.id
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => onPulseDriveChange(p.id)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50",
                  selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
                )}
              >
                <span className="text-sm font-medium">{p.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{p.examples}</span>
                {!compact && (
                  <span className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">{p.detail}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function motorModeLabel(mode: MotorMode | undefined, pulseDrive?: PulseDrive): string {
  if (mode !== "servo") return "DC · BTS7960"
  return `${pulseDriveProfile(pulseDrive ?? "integrated-servo").short} · PUL/DIR`
}
