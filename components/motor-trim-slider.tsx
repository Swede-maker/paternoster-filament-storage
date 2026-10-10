"use client"

import { useEffect, useRef, useState } from "react"
import type { StorageNode } from "@/lib/types"
import {
  DC_TRIM_STEP_PCT,
  MAX_DC_TRIM_PCT,
  dcTrimScalesFromPct,
  formatDcTrimPct,
  roundDcTrimPct,
  type TravelDirection,
} from "@/lib/filament"
import { NumberInput } from "./ui/number-input"

/** How long the Test button runs the carousel, so the operator can see which way this slider governs. */
export const TRIM_TEST_MS = 1500

export const DIRECTION_LABEL: Record<TravelDirection, string> = { up: "Up", down: "Down" }
export const DIRECTION_ARROW: Record<TravelDirection, string> = { up: "↑", down: "↓" }

/**
 * One Motor balance slider: range + exact box + nudge buttons. When
 * `testDirection` is given, a Test button jogs both motors that way for 1.5 s
 * so the operator can see which rotation (CW or CCW on their machine) this
 * slider is trimming.
 */
export function MotorTrimSlider({
  id,
  node,
  label,
  value,
  onChange,
  disabled,
  testDirection,
}: {
  id: string
  node: StorageNode
  label: string
  value: number
  onChange: (pct: number) => void
  disabled: boolean
  testDirection?: TravelDirection
}) {
  const scales = dcTrimScalesFromPct(value)
  const set = (v: number) => onChange(Math.max(-MAX_DC_TRIM_PCT, Math.min(MAX_DC_TRIM_PCT, roundDcTrimPct(v))))
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const runTest = async () => {
    if (!testDirection || testing) return
    setTestError(null)
    setTesting(true)
    // Hold the button down for as long as the carousel runs, whether real or simulated.
    timer.current = setTimeout(() => setTesting(false), TRIM_TEST_MS + 300)
    if (node.driver !== "hardware") return
    try {
      const res = await fetch("/api/pi/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: node.ip,
          port: node.port,
          command: { type: "jog", motor: "both", direction: testDirection, ms: TRIM_TEST_MS },
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setTestError(body?.error ?? `Test failed (${res.status})`)
      }
    } catch {
      setTestError("Could not reach the app server.")
    }
  }

  const online = node.driver !== "hardware" || node.link === "online"

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </label>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-foreground">
            {value === 0 ? "equal" : value < 0 ? `A −${formatDcTrimPct(value)} %` : `B −${formatDcTrimPct(value)} %`}
          </span>
          {testDirection && (
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={disabled || testing || !online}
              aria-label={`Run the carousel ${DIRECTION_LABEL[testDirection].toLowerCase()} for 1.5 seconds to see which way this slider controls`}
              className="rounded-md border border-primary/60 bg-primary/10 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {testing ? `Running ${DIRECTION_ARROW[testDirection]}` : `Test ${DIRECTION_ARROW[testDirection]}`}
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="w-14 shrink-0 text-right font-mono text-[11px] text-muted-foreground">Slow A</span>
        <input
          id={id}
          type="range"
          aria-label={`${label}: PWM balance between motor A and motor B, percent`}
          aria-valuetext={
            value === 0
              ? "Equal duty on both motors"
              : value < 0
                ? `Motor A runs at ${(scales.a * 100).toFixed(1)} percent of the PWM duty`
                : `Motor B runs at ${(scales.b * 100).toFixed(1)} percent of the PWM duty`
          }
          min={-MAX_DC_TRIM_PCT}
          max={MAX_DC_TRIM_PCT}
          step={DC_TRIM_STEP_PCT}
          list={`${id}-ticks`}
          value={value}
          disabled={disabled}
          onChange={(e) => set(Number(e.target.value))}
          className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary disabled:cursor-not-allowed disabled:opacity-50"
        />
        <datalist id={`${id}-ticks`}>
          <option value={0} label="equal" />
        </datalist>
        <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">Slow B</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-num`} className="font-mono text-[11px] text-muted-foreground">
            Exact
          </label>
          <div className="w-24">
            <NumberInput
              id={`${id}-num`}
              min={-MAX_DC_TRIM_PCT}
              max={MAX_DC_TRIM_PCT}
              integer={false}
              step={DC_TRIM_STEP_PCT}
              unit="%"
              value={value}
              disabled={disabled}
              onCommit={set}
              aria-label={`${label} in percent: negative slows motor A, positive slows motor B, to 0.001`}
            />
          </div>
          <span className="font-mono text-[11px] text-muted-foreground">
            % · A × {scales.a.toFixed(3)} · B × {scales.b.toFixed(3)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => set(value - DC_TRIM_STEP_PCT)}
            disabled={disabled || value <= -MAX_DC_TRIM_PCT}
            aria-label={`${label}: slow motor A by 0.1 percent more`}
            className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            A −0.1
          </button>
          <button
            type="button"
            onClick={() => set(value + DC_TRIM_STEP_PCT)}
            disabled={disabled || value >= MAX_DC_TRIM_PCT}
            aria-label={`${label}: slow motor B by 0.1 percent more`}
            className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            B −0.1
          </button>
          <button
            type="button"
            onClick={() => set(0)}
            disabled={disabled || value === 0}
            aria-label={`${label}: reset to equal`}
            className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      </div>
      {testError && <p className="mt-1 text-xs text-destructive">{testError}</p>}
    </div>
  )
}
