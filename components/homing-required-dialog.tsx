"use client"

import { AlertTriangle, Home, Compass } from "lucide-react"
import { useStore } from "@/lib/store"
import { Dialog, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"

/**
 * Blocking confirmation shown the first time a REAL carousel comes online
 * without knowing its position — typically the moment a freshly wired-up unit's
 * Pi connects. Before this dialog existed the app homed it on its own, which
 * meant the carousel started spinning the instant the Pi was reachable.
 *
 * Homing rotates the carousel until the index sensor fires, possibly a whole
 * revolution, so the operator must confirm the shelves are clear. "Home now"
 * starts the sweep; "Not now" parks the unit un-homed with a reminder in the
 * sidebar (absolute moves stay blocked until it homes).
 *
 * Mounted once at the app root and driven purely from store state.
 */
export function HomingRequiredDialog() {
  const { state, dispatch } = useStore()

  // Position-lost takes precedence: a faulted unit shows its own dialog.
  const anyFault = state.nodes.some((n) => n.machine.fault && !n.machine.fault.acknowledged)
  const node = anyFault
    ? undefined
    : state.nodes
        .filter((n) => n.machine.homingRequest && !n.machine.homingRequest.acknowledged)
        .sort((a, b) => (a.machine.homingRequest?.at ?? 0) - (b.machine.homingRequest?.at ?? 0))[0]

  const open = !!node
  const offline = !!node && node.driver === "hardware" && node.link !== "online"
  const shelves = node?.storage.shelves ?? 0

  function dismiss() {
    if (node) dispatch({ type: "ACK_HOMING_REQUEST", nodeId: node.id })
  }

  function home() {
    if (!node) return
    if (state.job) dispatch({ type: "CANCEL_JOB" })
    dispatch({ type: "HOME_START", nodeId: node.id })
  }

  return (
    <Dialog open={open} onClose={dismiss} hideClose className="max-w-md" title="Carousel needs homing">
      {node && (
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3 rounded-xl border-2 border-primary/60 bg-primary/10 p-4">
            <Compass className="mt-0.5 h-6 w-6 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0">
              <p className="text-sm font-bold uppercase tracking-wider text-primary">Position unknown</p>
              <p className="mt-1 text-sm leading-relaxed text-foreground text-pretty">
                <span className="font-semibold">{node.name}</span> is connected but has never been homed, so it does
                not know which of its {shelves} shelves is at the window. It has not moved and will not move until you
                start homing here.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-foreground text-pretty">
              Homing will <span className="font-semibold">rotate the carousel</span> until the index sensor triggers —
              possibly a full revolution. Make sure hands, tools, cables and loose spools are clear of every shelf, and
              that the carousel can turn freely, before you start it.
            </p>
          </div>

          <DialogFooter className="mt-0">
            <Button variant="outline" size="md" onClick={dismiss}>
              Not now
            </Button>
            <Button size="md" onClick={home} disabled={offline}>
              <Home className="h-4 w-4" />
              Home now
            </Button>
          </DialogFooter>
          {offline && (
            <p className="text-center text-xs text-muted-foreground">
              The Pi agent went offline, so homing cannot be started from here right now.
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}
