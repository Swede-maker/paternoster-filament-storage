"use client"

import { useState } from "react"
import { Home, Loader2, Ruler, ScanLine, Square } from "lucide-react"
import { useStore } from "@/lib/store"
import type { PositionMode } from "@/lib/node-protocol"
import type { StorageNode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function relativeTime(epochMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1000))
  if (s < 60) return "just now"
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} days ago`
}

const nf = new Intl.NumberFormat()

/**
 * Settings → Motor drive (servo): choose how a `goto` finds its shelf and run
 * the pulse calibration that makes the second option possible.
 *
 * "Shelf sensor" counts the proximity-sensor edges as the shelves go by (the
 * only option on DC). "Servo pulses" drives a measured number of pulses per
 * shelf from the home datum and re-syncs the odometer on every pass of the
 * index flag, so the shelf sensor's bounce can never miscount a stop.
 */
export function ServoPositioning({ node }: { node: StorageNode }) {
  const { state, dispatch } = useStore()
  const [error, setError] = useState<string | null>(null)

  const hardware = node.driver === "hardware"
  const online = !hardware || node.link === "online"
  const agentIsServo = !hardware || node.servo?.mode === "servo"
  const idle = node.machine.status === "idle" && !state.job
  const calibrating = node.calibrating === true
  const cal = node.calibration
  const calibrated = (node.servoCarouselPulses ?? 0) > 0
  const shelves = node.storage.shelves
  const mode: PositionMode = node.positionMode ?? "sensor"
  const pulsesPerShelf = calibrated ? Math.round((node.servoCarouselPulses ?? 0) / shelves) : null
  const flagsMismatch =
    cal?.ok === true && typeof cal.shelfFlagsSeen === "number" && cal.shelfFlagsSeen !== (cal.shelves ?? shelves)
  const shelvesChanged = cal?.ok === true && typeof cal.shelves === "number" && cal.shelves !== shelves

  const setMode = (m: PositionMode) => dispatch({ type: "UPDATE_NODE", id: node.id, changes: { positionMode: m } })

  const post = async (command: { type: "calibrate" | "stop" }) => {
    setError(null)
    if (!hardware) {
      // The simulated carousel runs the same sequence on in-app timers.
      if (command.type === "calibrate") dispatch({ type: "SIM_CALIBRATE_START", nodeId: node.id })
      else dispatch({ type: "EMERGENCY_STOP", nodeId: node.id })
      return
    }
    if (command.type === "calibrate") dispatch({ type: "NODE_CALIBRATING", nodeId: node.id, on: true })
    try {
      const res = await fetch("/api/pi/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: node.ip, port: node.port, command }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `Command failed (${res.status})`)
        dispatch({ type: "NODE_CALIBRATING", nodeId: node.id, on: false })
      }
    } catch {
      setError("Could not reach the app server.")
      dispatch({ type: "NODE_CALIBRATING", nodeId: node.id, on: false })
    }
  }

  const canCalibrate = online && agentIsServo && idle && !calibrating

  return (
    <div className="mt-3 rounded-lg border border-border bg-secondary/30 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Positioning</p>
        <div
          role="radiogroup"
          aria-label="Positioning method"
          className="grid grid-cols-3 rounded-md border border-border bg-background p-0.5 sm:flex"
        >
          {(
            [
              { value: "sensor", label: "Shelf sensor", icon: ScanLine },
              { value: "pulses", label: "Servo pulses", icon: Ruler },
              { value: "index", label: "Home only", icon: Home },
            ] as const
          ).map((opt) => {
            const active = mode === opt.value
            const disabled = opt.value === "pulses" && !calibrated
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                title={disabled ? "Run a calibration first" : undefined}
                onClick={() => setMode(opt.value)}
                className={cn(
                  "flex min-h-11 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors sm:min-h-8 sm:px-2.5",
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  disabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
                )}
              >
                <opt.icon className="size-3.5" aria-hidden />
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground text-pretty">
        {mode === "sensor"
          ? "Each shelf is counted as its flag reaches the proximity sensor. Edges that arrive less than half a shelf after the previous one — a bouncing chain, or the shelf you were parked beside being dragged back in — are ignored."
          : mode === "index"
            ? `No shelf sensor needed: only the home sensor is wired. Calibrate once to measure a full turn; shelves are then spaced evenly${pulsesPerShelf ? ` (${nf.format(pulsesPerShelf)} pulses each)` : ""} from home, and the position is corrected every time the home flag passes. Moving to a shelf is blocked until calibrated; jogging and Home always work.`
            : `Each shelf is ${pulsesPerShelf ? nf.format(pulsesPerShelf) : "…"} pulses from the next. The carousel drives that distance from the home datum and corrects its odometer every time the home flag passes the index sensor, without stopping. The shelf sensor is only reported, never used to stop.`}
      </p>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {calibrated ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Per turn</dt>
                <dd className="text-foreground">{nf.format(node.servoCarouselPulses ?? 0)} pulses</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Per shelf</dt>
                <dd className="text-foreground">{pulsesPerShelf !== null ? nf.format(pulsesPerShelf) : "—"} pulses</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Index window</dt>
                <dd className="text-foreground">
                  {node.servoIndexWindowPulses ? `${nf.format(node.servoIndexWindowPulses)} pulses` : "—"}
                </dd>
              </div>
              {mode !== "index" && (
                <div>
                  <dt className="text-muted-foreground">Flags seen</dt>
                  <dd className={cn(flagsMismatch ? "text-warning" : "text-foreground")}>
                    {typeof cal?.shelfFlagsSeen === "number" ? `${cal.shelfFlagsSeen} of ${cal.shelves ?? shelves}` : "—"}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-muted-foreground">Last home pass</dt>
                <dd className="text-foreground">
                  {typeof cal?.lastDriftPulses === "number"
                    ? `${cal.lastDriftPulses > 0 ? "+" : ""}${nf.format(cal.lastDriftPulses)} pulses`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Calibrated</dt>
                <dd className="text-foreground">
                  {node.servoCalibratedAt ? relativeTime(node.servoCalibratedAt) : cal?.restored ? "on the agent" : "—"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              Not calibrated. The carousel has to be measured once before it can position by pulses.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {calibrating && (
            <Button type="button" variant="outline" size="sm" onClick={() => void post({ type: "stop" })}>
              <Square className="size-3.5" aria-hidden />
              Stop
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={calibrated ? "outline" : "primary"}
            disabled={!canCalibrate}
            onClick={() => void post({ type: "calibrate" })}
          >
            {calibrating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Ruler className="size-3.5" aria-hidden />}
            {calibrating ? "Measuring…" : calibrated ? "Recalibrate" : "Calibrate"}
          </Button>
        </div>
      </div>

      {calibrating && (
        <p className="mt-2 text-xs text-muted-foreground">
          One full turn at homing speed: homes on the index flag, measures the way round, and stops at home again.
          {!hardware && " (Simulated: the result is derived from the pulses-per-revolution and gear ratio above.)"}
        </p>
      )}
      {!calibrating && cal && (
        <p className={cn("mt-2 text-xs leading-relaxed text-pretty", cal.ok ? "text-muted-foreground" : "text-destructive")}>
          {cal.message}
        </p>
      )}
      {shelvesChanged && (
        <p className="mt-1 text-xs text-warning text-pretty">
          Calibrated with {cal?.shelves} shelves; this unit now has {shelves}. The pulses per shelf above are
          recomputed from the same turn, so no re-run is needed unless shelves were physically added or removed.
        </p>
      )}
      {hardware && online && !agentIsServo && (
        <p className="mt-1 text-xs text-warning">
          The agent has not confirmed the servo drive yet; calibration is a servo-only feature.
        </p>
      )}
      {hardware && !online && <p className="mt-1 text-xs text-muted-foreground">Unit offline.</p>}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
