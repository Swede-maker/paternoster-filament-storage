"use client"

import { useState } from "react"
import { Play, X, ChevronDown, ChevronUp, ArrowUpFromLine, MapPin } from "lucide-react"
import { useStore } from "@/lib/store"
import { getNode, shelfLabel } from "@/lib/selectors"
import { findPartLocation, takeOutParts } from "@/lib/hardware-flow"
import { Button } from "../ui/button"
import { PartThumb } from "./part-box"

/**
 * Bottom sheet for assembling a hardware TAKE-OUT queue. The operator taps parts
 * to add them here (no quantity yet), then presses "Ready to take out" to run one
 * pick job that visits each box in turn — the amount taken from each is entered
 * live at the stop (in the motion overlay). Hidden when the queue is empty or a
 * job is already running.
 */
export function HardwareQueueTray() {
  const { state, dispatch } = useStore()
  const [collapsed, setCollapsed] = useState(false)

  // While a job runs the motion overlay owns the screen; don't stack the tray.
  if (state.job || state.hwPickQueue.length === 0) return null

  // Resolve each queued id to its part + current location; drop any that vanished.
  const entries = state.hwPickQueue
    .map((id) => {
      const part = state.parts[id]
      if (!part) return null
      const loc = findPartLocation(state, id)
      return { part, loc }
    })
    .filter((e): e is { part: NonNullable<typeof e>["part"]; loc: ReturnType<typeof findPartLocation> } => e != null)

  const start = () => {
    if (takeOutParts(state, dispatch, state.hwPickQueue)) {
      dispatch({ type: "HW_QUEUE_TAKE_CLEAR" })
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-14 z-40 mx-auto max-w-3xl px-4">
      <div className="rounded-2xl border border-primary/40 bg-card/95 p-4 shadow-2xl backdrop-blur">
        <div className={collapsed ? "flex items-center justify-between gap-2" : "mb-3 flex items-center justify-between gap-2"}>
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ArrowUpFromLine className="h-4 w-4 text-primary" />
            Take-out queue
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {entries.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand queue" : "Collapse queue"}
              className="rounded-md p-1.5 text-muted-foreground hover:text-primary"
            >
              {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "HW_QUEUE_TAKE_CLEAR" })}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive"
            >
              <X className="h-4 w-4" /> Clear
            </button>
          </div>
        </div>

        {!collapsed && (
          <>
            <ul className="mb-4 flex gap-2 overflow-x-auto scrollbar-thin pb-1">
              {entries.map(({ part, loc }) => {
                const node = loc ? getNode(state, loc.nodeId) : null
                const where = loc
                  ? `${node ? shelfLabel(node, loc.shelf) : `Shelf ${loc.shelf + 1}`} · ${loc.slot + 1}`
                  : "—"
                return (
                  <li
                    key={part.id}
                    className="relative flex w-28 shrink-0 flex-col items-center gap-1 rounded-xl border border-border bg-background/50 p-2"
                  >
                    <button
                      type="button"
                      onClick={() => dispatch({ type: "HW_QUEUE_TAKE_REMOVE", partId: part.id })}
                      aria-label={`Remove ${part.name} from take-out queue`}
                      className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <PartThumb color={part.color} size={40} imageUrl={part.imageUrl} name={part.name} />
                    <span className="line-clamp-2 text-center text-[11px] font-semibold leading-tight text-foreground">
                      {part.name}
                    </span>
                    <span className="flex items-center gap-0.5 font-mono text-[10px] text-muted-foreground">
                      <MapPin className="h-2.5 w-2.5 shrink-0" />
                      {where}
                    </span>
                  </li>
                )
              })}
            </ul>

            <p className="mb-3 text-[11px] text-muted-foreground text-pretty">
              You&apos;ll set how many to take from each box at the machine, one stop at a time.
            </p>

            <Button className="w-full" onClick={start} disabled={entries.length === 0}>
              <Play className="h-4 w-4" /> Ready to take out
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
