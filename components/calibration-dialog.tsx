"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Gauge, Play, AlertTriangle, CheckCircle2, XCircle, RotateCw } from "lucide-react"
import { useStore } from "@/lib/store"
import { DEFAULT_SEC_PER_SHELF } from "@/lib/filament"
import { Dialog, DialogHeader, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import type { StorageNode } from "@/lib/types"

/**
 * Carousel speed auto-calibration.
 *
 * Realistic simulation of a physical calibration routine: the motor starts very
 * slow and ramps up, and we "count seconds" until the shelf-position sensor
 * triggers. From the measured seconds-per-shelf we converge on the ~3.5 s target.
 *
 * Failure handling mirrors real hardware:
 *  - No sensor trigger within 10 s  → ask "did the carousel rotate?"
 *  - If it rotated                  → sensor didn't trigger; ask "safe to go 25% faster?"
 *  - Retry once at +25% speed; still nothing within 10 s → abort with guidance
 *    to jog a shelf near a trigger point or inspect the sensor/spacing.
 *
 * The measured speed is stored on the node (secPerShelf) and drives the on-screen
 * carousel timing everywhere.
 */

/** Motor duty as a fraction (0..1) mapped to a simulated seconds-per-shelf. */
const TIMEOUT_SEC = 10 // sensor must trigger within this window
const TARGET_SEC = DEFAULT_SEC_PER_SHELF // desired seconds between shelves (~3.5)
// Simulated physical response: at low duty the shelf takes a long time to reach
// the sensor; higher duty is proportionally faster. Tuned so the first (very
// slow) pass usually reads long, then the routine ramps toward TARGET_SEC.
function simulatedSecPerShelf(duty: number, sensorHealthy: boolean): number | null {
  if (!sensorHealthy) return null // sensor never triggers
  // ~7 s at 30% duty down to ~2.1 s at 100% duty.
  const sec = 2.1 / Math.max(0.05, duty)
  return sec
}

type Phase =
  | { kind: "intro" }
  | { kind: "running"; pass: number; duty: number; elapsed: number }
  | { kind: "timeout"; duty: number } // no trigger in 10s → did it rotate?
  | { kind: "confirm-faster"; duty: number } // it rotated but no trigger → go 25% faster?
  | { kind: "aborted" }
  | { kind: "done"; secPerShelf: number }

export function CalibrationDialog({
  node,
  open,
  onClose,
}: {
  node: StorageNode | null
  open: boolean
  onClose: () => void
}) {
  const { dispatch } = useStore()
  const [phase, setPhase] = useState<Phase>({ kind: "intro" })
  // Test rig: assume the sensor is healthy. (In a real unit this comes from the
  // sensor line; here it lets the simulated routine converge.)
  const sensorHealthyRef = useRef(true)
  const tick = useRef<ReturnType<typeof setInterval> | null>(null)

  const nodeId = node?.id

  const clearTick = useCallback(() => {
    if (tick.current) {
      clearInterval(tick.current)
      tick.current = null
    }
  }, [])

  // Reset whenever the dialog opens for a node.
  useEffect(() => {
    if (open) {
      setPhase({ kind: "intro" })
      sensorHealthyRef.current = true
    } else {
      clearTick()
    }
  }, [open, clearTick])

  useEffect(() => () => clearTick(), [clearTick])

  // Begin a calibration pass at a given motor duty. Counts seconds up to the
  // timeout; if the (simulated) sensor triggers, records the speed and finishes.
  const startPass = useCallback(
    (pass: number, duty: number) => {
      if (!nodeId) return
      clearTick()
      dispatch({ type: "CALIBRATE_START", nodeId })
      const measured = simulatedSecPerShelf(duty, sensorHealthyRef.current)
      setPhase({ kind: "running", pass, duty, elapsed: 0 })

      const started = Date.now()
      tick.current = setInterval(() => {
        const elapsed = (Date.now() - started) / 1000
        // Visibly index a shelf as time passes (roughly once per second of travel).
        // Sensor trigger: measured time elapsed and within the window.
        if (measured != null && elapsed >= measured) {
          clearTick()
          dispatch({ type: "CALIBRATE_ADVANCE", nodeId })
          // Nudge duty toward the target speed: if we were too slow (long seconds),
          // ramp up; if too fast, ease off. One correction pass then commit.
          const error = measured - TARGET_SEC
          if (Math.abs(error) > 0.6 && pass < 4) {
            // Scale duty by how far off we are (more duty => fewer seconds).
            const nextDuty = Math.min(1, Math.max(0.2, duty * (measured / TARGET_SEC)))
            startPass(pass + 1, nextDuty)
          } else {
            dispatch({ type: "CALIBRATE_DONE", nodeId, secPerShelf: TARGET_SEC })
            setPhase({ kind: "done", secPerShelf: TARGET_SEC })
          }
          return
        }
        if (elapsed >= TIMEOUT_SEC) {
          clearTick()
          setPhase({ kind: "timeout", duty })
          return
        }
        setPhase({ kind: "running", pass, duty, elapsed })
      }, 100)
    },
    [nodeId, dispatch, clearTick],
  )

  if (!node) return null

  const cancelAndClose = () => {
    clearTick()
    if (nodeId) dispatch({ type: "CALIBRATE_CANCEL", nodeId })
    onClose()
  }

  return (
    <Dialog open={open} onClose={cancelAndClose} className="max-w-md" hideClose>
      <DialogHeader
        icon={<Gauge className="h-5 w-5" />}
        title="Calibrate carousel speed"
        description={node.name}
      />

      {phase.kind === "intro" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The carousel will start slow and ramp up while the shelf-position sensor is timed. It targets about{" "}
            <span className="font-mono text-foreground">{TARGET_SEC.toFixed(1)}s</span> between shelves.
          </p>
          <DialogFooter>
            <Button variant="secondary" onClick={cancelAndClose}>
              Cancel
            </Button>
            {/* Start at a deliberately low duty for the very first slow pass. */}
            <Button onClick={() => startPass(1, 0.3)}>
              <Play className="h-4 w-4" /> Start calibration
            </Button>
          </DialogFooter>
        </div>
      )}

      {phase.kind === "running" && (
        <div className="space-y-4">
          <RunningMeter pass={phase.pass} duty={phase.duty} elapsed={phase.elapsed} />
          <DialogFooter>
            <Button variant="secondary" onClick={cancelAndClose}>
              Stop
            </Button>
          </DialogFooter>
        </div>
      )}

      {phase.kind === "timeout" && (
        <div className="space-y-4">
          <Notice tone="warn" icon={<AlertTriangle className="h-5 w-5" />}>
            No shelf sensor triggered within {TIMEOUT_SEC} seconds. Did the carousel actually rotate?
          </Notice>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                // Carousel did NOT rotate → treat as a hard fault, abort.
                setPhase({ kind: "aborted" })
              }}
            >
              No, it didn&apos;t move
            </Button>
            <Button onClick={() => setPhase({ kind: "confirm-faster", duty: phase.duty })}>
              Yes, it rotated
            </Button>
          </DialogFooter>
        </div>
      )}

      {phase.kind === "confirm-faster" && (
        <div className="space-y-4">
          <Notice tone="warn" icon={<AlertTriangle className="h-5 w-5" />}>
            It rotated but the shelf sensor never triggered. Is it safe to try again{" "}
            <span className="font-semibold text-foreground">25% faster</span>?
          </Notice>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPhase({ kind: "aborted" })}>
              No, abort
            </Button>
            <Button
              onClick={() => {
                // Second attempt: 25% faster. If the sensor is broken it still
                // won't trigger, so the retry will time out and we abort next.
                sensorHealthyRef.current = false
                startPass(2, Math.min(1, phase.duty * 1.25))
              }}
            >
              <RotateCw className="h-4 w-4" /> Retry 25% faster
            </Button>
          </DialogFooter>
        </div>
      )}

      {phase.kind === "aborted" && (
        <div className="space-y-4">
          <Notice tone="error" icon={<XCircle className="h-5 w-5" />}>
            Calibration aborted. Use the arrow buttons to jog the carousel so a shelf sits close to a trigger point,
            or check whether the sensor is broken or too far from the shelf. Then run auto-calibrate again.
          </Notice>
          <DialogFooter>
            <Button onClick={cancelAndClose}>Close</Button>
          </DialogFooter>
        </div>
      )}

      {phase.kind === "done" && (
        <div className="space-y-4">
          <Notice tone="ok" icon={<CheckCircle2 className="h-5 w-5" />}>
            Calibrated to <span className="font-mono font-semibold text-foreground">{phase.secPerShelf.toFixed(1)}s</span>{" "}
            per shelf. You can fine-tune with the speed slider anytime.
          </Notice>
          <DialogFooter>
            <Button onClick={onClose}>Done</Button>
          </DialogFooter>
        </div>
      )}
    </Dialog>
  )
}

function RunningMeter({ pass, duty, elapsed }: { pass: number; duty: number; elapsed: number }) {
  const pct = Math.min(100, (elapsed / TIMEOUT_SEC) * 100)
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">Pass {pass}</span>
        <span className="font-mono tabular-nums text-foreground">{elapsed.toFixed(1)}s</span>
      </div>
      {/* Elapsed-toward-timeout bar. */}
      <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
        <div className="h-full rounded-full bg-primary transition-[width] duration-100" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        Motor at {Math.round(duty * 100)}% — waiting for the shelf sensor…
      </p>
    </div>
  )
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "ok" | "warn" | "error"
  icon: React.ReactNode
  children: React.ReactNode
}) {
  const toneClass =
    tone === "ok"
      ? "border-primary/40 bg-primary/10 text-foreground"
      : tone === "warn"
        ? "border-amber-500/40 bg-amber-500/10 text-foreground"
        : "border-destructive/40 bg-destructive/10 text-foreground"
  const iconClass = tone === "ok" ? "text-primary" : tone === "warn" ? "text-amber-500" : "text-destructive"
  return (
    <div className={`flex items-start gap-3 rounded-xl border p-3 text-sm leading-relaxed ${toneClass}`}>
      <span className={`mt-0.5 shrink-0 ${iconClass}`}>{icon}</span>
      <p className="text-pretty">{children}</p>
    </div>
  )
}
