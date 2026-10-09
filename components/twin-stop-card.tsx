"use client"

import { useEffect, useState } from "react"
import { ArrowDownCircle, ArrowUpCircle, CheckCircle2, Loader2 } from "lucide-react"
import { useStore } from "@/lib/store"
import { Button } from "./ui/button"
import { Input } from "./ui/field"
import { PartBox } from "./hardware/part-box"

/**
 * The second twin carousel's own stop. It runs in parallel with the main
 * overlay stop: each side rotates, waits and is confirmed independently, so
 * finishing one side never holds up the other.
 */
export function TwinStopCard() {
  const { state, dispatch } = useStore()
  const job = state.job
  const index = job?.twinIndex
  const item = index != null ? job?.items[index] : undefined
  const node = item ? state.nodes.find((n) => n.id === item.nodeId) : undefined
  const part = item?.occupantKind === "part" ? state.parts[item.spoolId] : undefined
  const [takeQty, setTakeQty] = useState("1")
  const status = node?.machine.status

  useEffect(() => {
    if (status === "awaiting-pick-confirm") setTakeQty("1")
  }, [status, index])

  if (!job || index == null || !item || item.done || !node) return null

  const sideLabel = node.twinSide === "right" ? "Right carousel" : node.twinSide === "left" ? "Left carousel" : node.name
  const isPick = job.mode === "pick"
  const awaiting = status === "awaiting-pick-confirm" || status === "awaiting-store-confirm"
  const qty = Math.max(1, Math.min(part?.count ?? 1, Number.parseInt(takeQty, 10) || 1))

  return (
    <section
      aria-label={`${sideLabel} stop`}
      className="mb-5 flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{sideLabel}</p>
        <p className="font-mono text-xs text-muted-foreground">
          Shelf {item.shelf + 1} · Slot {item.slot + 1}
        </p>
      </div>

      <div className="flex items-center gap-3">
        {part && <PartBox color={part.color} size={44} imageUrl={part.imageUrl} name={part.name} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{part?.name ?? "Item"}</p>
          <p className="text-xs text-muted-foreground">
            {isPick ? "Take from" : "Place in"} shelf {item.shelf + 1}, slot {item.slot + 1}
          </p>
        </div>
      </div>

      {status === "moving" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Rotating to shelf {item.shelf + 1}
        </p>
      )}

      {status === "awaiting-move-confirm" && (
        <Button className="h-11 w-full" onClick={() => dispatch({ type: "CONFIRM_MOVE", nodeId: node.id })}>
          {node.machine.direction === "up" ? (
            <ArrowUpCircle className="h-5 w-5" />
          ) : (
            <ArrowDownCircle className="h-5 w-5" />
          )}
          Confirm & rotate
        </Button>
      )}

      {awaiting && (
        <div className="flex items-end gap-2">
          {isPick && part && (
            <label className="flex w-24 flex-col gap-1 text-xs text-muted-foreground">
              Take pcs
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={part.count}
                value={takeQty}
                onChange={(e) => setTakeQty(e.target.value)}
                className="h-11 text-base"
              />
            </label>
          )}
          <Button
            className="h-11 flex-1"
            onClick={() =>
              dispatch({ type: "CONFIRM_STOP", index, ...(isPick && part ? { takeCount: qty } : {}) })
            }
          >
            <CheckCircle2 className="h-5 w-5" /> Done
          </Button>
        </div>
      )}
    </section>
  )
}
