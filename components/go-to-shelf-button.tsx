"use client"

import { Navigation } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/**
 * Rotates a paternoster so the given shelf faces the user, without starting a
 * pick or place. Shelf and library units have no motor, so nothing renders.
 */
export function GoToShelfButton({
  nodeId,
  shelf,
  onDone,
  className,
}: {
  nodeId: string
  shelf: number
  onDone?: () => void
  className?: string
}) {
  const { state, dispatch } = useStore()
  const node = state.nodes.find((n) => n.id === nodeId)
  if (!node || (node.type ?? "paternoster") !== "paternoster") return null

  const { machine } = node
  const here = machine.homed && machine.status === "idle" && machine.currentShelf === shelf
  const blocked =
    state.job
      ? "Finish the current queue first"
      : node.driver === "hardware" && node.link !== "online"
        ? "Carousel is offline"
        : !machine.homed
          ? "Home the carousel first"
          : machine.status !== "idle"
            ? "Carousel is busy"
            : null

  function go() {
    if (blocked || here) return
    dispatch({ type: "SET_ACTIVE_NODE", id: nodeId })
    dispatch({ type: "GOTO_SHELF", nodeId, shelf })
    onDone?.()
  }

  const label = here ? "Shelf is in front" : "Go to shelf"

  return (
    <button
      type="button"
      onClick={go}
      disabled={!!blocked || here}
      title={blocked ?? label}
      aria-label={`${label}: shelf ${shelf + 1}${blocked ? ` (${blocked})` : ""}`}
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 text-xs font-semibold text-primary transition-colors",
        "hover:bg-primary/20 disabled:cursor-not-allowed disabled:border-border disabled:bg-transparent disabled:text-muted-foreground",
        className,
      )}
    >
      <Navigation className="h-4 w-4" aria-hidden />
      <span>{here ? "Here" : "Go to shelf"}</span>
    </button>
  )
}
