"use client"

import { OctagonX } from "lucide-react"
import { useStore } from "@/lib/store"
import type { StorageNode } from "@/lib/types"

/**
 * Screen-wide emergency stop that appears the moment any carousel starts
 * turning shelf-to-shelf (a task move, Go to shelf, one-shelf step or homing)
 * and disappears once it settles. Per-motor jogging is deliberately excluded:
 * those are short, operator-held nudges done from the jog panel, which has its
 * own stop.
 *
 * Mounted once at the app root above every other overlay so it is reachable
 * from any tab, including Settings.
 */
export function EmergencyStopBar() {
  const { state, dispatch } = useStore()

  const rotating = state.nodes.filter(isRotating)
  if (rotating.length === 0) return null

  return (
    <div
      role="region"
      aria-label="Emergency stop"
      className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex justify-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))]"
    >
      <div className="pointer-events-auto flex w-full max-w-md flex-col gap-2">
        {rotating.map((node) => (
          <button
            key={node.id}
            type="button"
            onClick={() => dispatch({ type: "EMERGENCY_STOP", nodeId: node.id })}
            aria-label={`Emergency stop ${node.name}`}
            className="flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 border-destructive-foreground/30 bg-destructive px-4 py-3 text-left text-destructive-foreground shadow-2xl ring-4 ring-destructive/30 transition-transform active:scale-[0.98]"
          >
            <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-destructive-foreground/30" aria-hidden="true" />
              <OctagonX className="relative h-8 w-8" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-base font-bold uppercase tracking-wider">Emergency stop</span>
              <span className="truncate text-sm text-destructive-foreground/85">{describeMotion(node)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function isRotating(node: StorageNode): boolean {
  if (node.type === "shelf") return false
  const { status } = node.machine
  if (status !== "moving" && status !== "homing") return false
  if (node.servo?.jogging === true) return false
  return true
}

function describeMotion(node: StorageNode): string {
  const { status, targetShelf } = node.machine
  if (status === "homing") return `${node.name} is homing — tap to stop`
  if (targetShelf !== null) return `${node.name} rotating to shelf ${targetShelf + 1} — tap to stop`
  return `${node.name} is rotating — tap to stop`
}
