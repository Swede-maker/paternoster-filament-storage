"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowUp, ArrowDown, Home, Loader2, Gauge } from "lucide-react"
import { useStore } from "@/lib/store"
import { activeNode } from "@/lib/selectors"
import { DEFAULT_SEC_PER_SHELF, MIN_SEC_PER_SHELF, MAX_SEC_PER_SHELF, DEFAULT_RAMP_PCT } from "@/lib/filament"
import { Button } from "./ui/button"
import { CalibrationDialog } from "./calibration-dialog"
import { cn } from "@/lib/utils"

export function ManualControl() {
  const { state, dispatch } = useStore()
  const node = activeNode(state)
  const { currentShelf, homed, status } = node.machine
  const idle = status === "idle" && !state.job
  const canJog = homed && idle
  const [calibrating, setCalibrating] = useState(false)

  // Speed controls only apply to a motorized carousel, not manual shelf storage.
  const isCarousel = node.type !== "shelf"
  const secPerShelf = node.secPerShelf ?? DEFAULT_SEC_PER_SHELF
  const rampPct = node.rampPct ?? DEFAULT_RAMP_PCT

  // Prompt calibration once per uncalibrated carousel (e.g. right after setup):
  // a paternoster must be calibrated BEFORE it can home, so surface it up front.
  const promptedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (isCarousel && !node.calibrated && node.machine.status === "idle" && !promptedRef.current.has(node.id)) {
      promptedRef.current.add(node.id)
      setCalibrating(true)
    }
  }, [isCarousel, node.calibrated, node.id, node.machine.status])

  const statusLabel = (() => {
    switch (status) {
      case "homing":
        return "Homing…"
      case "moving":
        return "Moving…"
      case "awaiting-move-confirm":
        return "Waiting for confirm"
      case "awaiting-pick-confirm":
        return "Ready to pick"
      case "awaiting-store-confirm":
        return "Ready to store"
      case "calibrating":
        return "Calibrating…"
      default:
        return homed ? "Positioning OK" : node.calibrated || !isCarousel ? "Not homed" : "Needs calibration"
    }
  })()

  const busy = status === "homing" || status === "moving" || status === "calibrating"

  return (
    <section aria-label="Manual control" className="border-t border-border px-4 py-4">
      <h2 className="pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Manual Control</h2>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={!canJog}
          onClick={() => dispatch({ type: "MANUAL_MOVE", nodeId: node.id, direction: "up" })}
          className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-border bg-secondary/40 text-foreground transition-colors hover:border-primary/50 hover:bg-secondary/70 disabled:opacity-40"
        >
          <ArrowUp className="h-6 w-6 text-primary" />
          <span className="text-xs font-medium">Move Up</span>
        </button>
        <button
          type="button"
          disabled={!canJog}
          onClick={() => dispatch({ type: "MANUAL_MOVE", nodeId: node.id, direction: "down" })}
          className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-border bg-secondary/40 text-foreground transition-colors hover:border-primary/50 hover:bg-secondary/70 disabled:opacity-40"
        >
          <ArrowDown className="h-6 w-6 text-primary" />
          <span className="text-xs font-medium">Move Down</span>
        </button>
      </div>

      <Button
        variant="outline"
        size="md"
        className="mt-3 w-full"
        disabled={busy}
        onClick={() => dispatch({ type: "HOME_START", nodeId: node.id })}
      >
        {status === "homing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Home className="h-4 w-4" />}
        Home Carousel
      </Button>

      {isCarousel && (
        <div className="mt-4 rounded-xl border border-border bg-background/50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Carousel Speed</p>
            <span className="font-mono text-xs text-foreground">{secPerShelf.toFixed(1)}s / shelf</span>
          </div>

          {/* Manual fine-tune. Slider is inverted so "right = faster" reads naturally:
              we map the position back to seconds-per-shelf (lower sec = faster). */}
          <input
            type="range"
            aria-label="Carousel speed (seconds per shelf)"
            min={MIN_SEC_PER_SHELF}
            max={MAX_SEC_PER_SHELF}
            step={0.1}
            // invert: slider value is "fastness", displayed value is seconds
            value={MIN_SEC_PER_SHELF + MAX_SEC_PER_SHELF - secPerShelf}
            disabled={busy}
            onChange={(e) => {
              const fastness = Number(e.target.value)
              const sec = MIN_SEC_PER_SHELF + MAX_SEC_PER_SHELF - fastness
              dispatch({ type: "SET_NODE_SPEED", nodeId: node.id, secPerShelf: sec })
            }}
            className="mt-2 w-full accent-[var(--color-primary)] disabled:opacity-40"
          />
          <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>Slower</span>
            <span>Faster</span>
          </div>

          {/* Soft start/stop ramp: how gently the carousel accelerates at the
              start of a move and decelerates at the end. Auto-calibration seeds
              a value from the found speed; this lets the user fine-tune it. */}
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Soft start / stop</p>
            <span className="font-mono text-xs text-foreground">
              {rampPct === 0 ? "Off" : `${rampPct}%`}
            </span>
          </div>
          <input
            type="range"
            aria-label="Soft start and stop ramp intensity (percent)"
            min={0}
            max={100}
            step={5}
            value={rampPct}
            disabled={busy}
            onChange={(e) => dispatch({ type: "SET_NODE_RAMP", nodeId: node.id, rampPct: Number(e.target.value) })}
            className="mt-2 w-full accent-[var(--color-primary)] disabled:opacity-40"
          />
          <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>Sharp</span>
            <span>Gentle</span>
          </div>

          <Button
            variant="secondary"
            size="sm"
            className="mt-3 w-full"
            disabled={busy}
            onClick={() => setCalibrating(true)}
          >
            <Gauge className="h-4 w-4" />
            Auto-calibrate speed
          </Button>
          {!node.calibrated && (
            <p className="mt-2 text-[11px] leading-relaxed text-amber-500">
              This carousel isn&apos;t calibrated yet. Run auto-calibrate so it can home and move reliably.
            </p>
          )}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-border bg-background/50 p-3">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Current Position</p>
        <p className="mt-0.5 font-mono text-2xl font-bold text-primary">
          {homed ? `Shelf ${currentShelf + 1}` : "—"}
        </p>
        <p className="mt-1 flex items-center gap-2 text-xs">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              busy ? "bg-warning animate-pulse" : homed ? "bg-success" : "bg-muted-foreground",
            )}
          />
          <span className={cn(busy ? "text-warning" : homed ? "text-success" : "text-muted-foreground")}>
            {statusLabel}
          </span>
        </p>
      </div>

      <CalibrationDialog node={calibrating ? node : null} open={calibrating} onClose={() => setCalibrating(false)} />
    </section>
  )
}
