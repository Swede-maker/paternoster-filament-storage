"use client"

import { AlertTriangle, Home, OctagonX } from "lucide-react"
import { useStore } from "@/lib/store"
import { Dialog, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"

/**
 * Blocking safety dialog shown the moment a carousel reports a fault and stops
 * because it lost track of its position (missed shelf pulse, sensor timeout…).
 *
 * The carousel will NOT move again until the operator decides here. "Home
 * carousel" starts the homing sweep — the only way to re-establish position —
 * and "Not now" leaves the machine parked and un-homed, with a persistent
 * warning in the sidebar. Nothing in the app is allowed to home it
 * automatically after a fault; that surprise motion is exactly what this
 * dialog exists to prevent.
 *
 * Mounted once at the app root and driven purely from store state, so it
 * appears on top of whatever the operator is looking at.
 */
export function PositionLostDialog() {
  const { state, dispatch } = useStore()

  // Show the oldest unacknowledged fault first; one dialog at a time.
  const node = state.nodes
    .filter((n) => n.machine.fault && !n.machine.fault.acknowledged)
    .sort((a, b) => (a.machine.fault?.at ?? 0) - (b.machine.fault?.at ?? 0))[0]

  const fault = node?.machine.fault
  const open = !!node && !!fault
  const offline = !!node && node.driver === "hardware" && node.link !== "online"

  function dismiss() {
    if (node) dispatch({ type: "ACK_NODE_FAULT", nodeId: node.id })
  }

  function home() {
    if (!node) return
    if (state.job) dispatch({ type: "CANCEL_JOB" })
    dispatch({ type: "HOME_START", nodeId: node.id })
  }

  return (
    <Dialog open={open} onClose={dismiss} hideClose className="max-w-md" title="Carousel stopped — position lost">
      {node && fault && (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-xl border-2 border-destructive bg-destructive/10 p-4">
            <OctagonX className="mt-0.5 h-6 w-6 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-bold uppercase tracking-wider text-destructive">Stopped for safety</p>
              <p className="mt-1 text-sm leading-relaxed text-foreground text-pretty">
                <span className="font-semibold">{node.name}</span> lost track of which shelf is at the window and
                stopped. It does not know where it is, so it has not moved since and will not move on its own.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Reported by the unit</p>
            <p className="mt-0.5 font-mono text-xs leading-relaxed text-foreground break-words">{fault.message}</p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-foreground text-pretty">
              To find its position again the carousel must <span className="font-semibold">home</span>: it will rotate
              until the index sensor triggers, possibly several shelves. Make sure hands, tools and spools are clear of
              the shelves before you start it.
            </p>
          </div>

          <DialogFooter className="mt-0">
            <Button variant="outline" size="md" onClick={dismiss}>
              Not now
            </Button>
            <Button size="md" onClick={home} disabled={offline}>
              <Home className="h-4 w-4" />
              Home carousel
            </Button>
          </DialogFooter>
          {offline && (
            <p className="text-center text-xs text-muted-foreground">
              The Pi agent is offline, so homing cannot be started from here right now.
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}
