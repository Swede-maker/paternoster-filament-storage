"use client"

import { useEffect, useState } from "react"
import { Loader2, CheckCircle2, ArrowUpCircle, ArrowDownCircle, MapPin } from "lucide-react"
import { useStore } from "@/lib/store"
import { Button } from "./ui/button"
import { Input, Field } from "./ui/field"
import { SpoolDisc } from "./spool"
import { formatGrams, isLightColor } from "@/lib/filament"
import { printerSlotLabel, shelfLabel, getNode } from "@/lib/selectors"
import type { Printer, StorageNode } from "@/lib/types"

/**
 * Full-screen operation overlay shown whenever a job is running. Displays the
 * rotating state and the "confirm pick / confirm store" gate, plus the optional
 * grams prompt when storing.
 */
export function MotionOverlay() {
  const { state, dispatch } = useStore()
  const job = state.job
  const [grams, setGrams] = useState<string>("")

  const item = job?.items[job.currentIndex] ?? null
  // The overlay follows the node that hosts the current job item.
  const node = item ? state.nodes.find((n) => n.id === item.nodeId) ?? null : null
  const { status, direction, targetShelf, currentShelf } = node?.machine ?? {
    status: "idle" as const,
    direction: null,
    targetShelf: null,
    currentShelf: 0,
  }
  const spool = item ? state.spools[item.spoolId] : null
  const printer: Printer | undefined = item?.printerId
    ? state.printers.find((p) => p.id === item.printerId)
    : undefined

  // Other linked units that are rotating into place in the background.
  const multiNode = state.nodes.length > 1
  const prepping = multiNode
    ? state.nodes.filter((n) => n.id !== item?.nodeId && n.machine.status === "moving")
    : []

  // Seed grams input when arriving at a store/place stop. Prefer the override the
  // user entered while assembling the queue (item.grams) so it isn't lost and they
  // don't have to re-type it; fall back to the spool's last known weight.
  useEffect(() => {
    if (status === "awaiting-store-confirm" && spool) {
      setGrams(String(Math.round(item?.grams ?? spool.grams)))
    }
  }, [status, spool, item?.grams])

  // When the machine stops at a shelf awaiting a pick/store confirm, bring the
  // carousel (with its flashing target slot) to the top of the screen so it
  // stays visible above the docked panel on small screens.
  useEffect(() => {
    if (status === "awaiting-pick-confirm" || status === "awaiting-store-confirm") {
      document.getElementById("pax-carousel")?.scrollIntoView({ behavior: "smooth", block: "start" })
    }
  }, [status])

  if (!job) return null

  const total = job.items.length
  const step = job.currentIndex + 1
  const isStore = job.mode === "store" || job.mode === "place"

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto max-h-[58vh] w-full max-w-md overflow-y-auto rounded-2xl border border-primary/30 bg-card/95 p-5 shadow-2xl backdrop-blur-md scrollbar-thin lg:max-h-[85vh]">
        {/* progress */}
        <div className="mb-4 flex items-center justify-between text-xs text-muted-foreground">
          <span className="uppercase tracking-wider">
            {job.mode === "pick" ? "Picking filament" : job.mode === "store" ? "Storing filament" : "Placing filament"}
          </span>
          <span className="font-mono">
            {step} / {total}
          </span>
        </div>

        {/* spool identity */}
        {spool && (
          <div className="mb-5 flex items-center gap-4">
            <SpoolDisc color={spool.color} size={72} />
            <div>
              <p className="text-lg font-semibold" style={{ color: isLightColor(spool.color) ? "#d4d4d8" : spool.color }}>
                {spool.material} · {spool.colorName}
              </p>
              <p className="text-sm text-muted-foreground">
                {spool.brand} · {formatGrams(spool.grams)}
              </p>
            </div>
          </div>
        )}

        {/* body per status */}
        {status === "moving" && (
          <MovingState direction={direction} from={currentShelf} to={targetShelf} />
        )}

        {status === "awaiting-move-confirm" && (
          <div className="text-center">
            <p className="mb-4 text-sm text-muted-foreground">
              Ready to rotate to <span className="font-semibold text-foreground">Shelf {(targetShelf ?? 0) + 1}</span>.
              Confirm to start the carousel.
            </p>
            <Button
              size="lg"
              className="w-full"
              onClick={() => node && dispatch({ type: "CONFIRM_MOVE", nodeId: node.id })}
            >
              {direction === "up" ? <ArrowUpCircle className="h-5 w-5" /> : <ArrowDownCircle className="h-5 w-5" />}
              Confirm & rotate
            </Button>
          </div>
        )}

        {status === "awaiting-pick-confirm" && item && (
          <div className="text-center">
            <StopLocation
              node={node}
              showNodeName={multiNode}
              shelf={item.shelf}
              slot={item.slot}
              verb="Take spool from"
            />
            {printer && item.printerSlot != null && (
              <p className="mb-4 text-sm text-muted-foreground">
                Load into <span className="font-semibold text-primary">{printer.name}</span> slot{" "}
                <span className="font-mono text-foreground">{printerSlotLabel(printer, item.printerSlot)}</span>
              </p>
            )}
            <Button size="lg" className="w-full" onClick={() => dispatch({ type: "CONFIRM_STOP" })}>
              <CheckCircle2 className="h-5 w-5" /> Confirm pick
            </Button>
          </div>
        )}

        {status === "awaiting-store-confirm" && item && (
          <div>
            <StopLocation
              node={node}
              showNodeName={multiNode}
              shelf={item.shelf}
              slot={item.slot}
              verb={job.mode === "place" ? "Place spool in" : item.from ? "Move spool to" : "Store spool in"}
            />
            {item.from &&
              (() => {
                // Remind the user where the spool is coming from during a move.
                const src = getNode(state, item.from.nodeId)
                const srcShelf = src ? shelfLabel(src, item.from.shelf) : `Shelf ${item.from.shelf + 1}`
                return (
                  <p className="-mt-2 mb-4 text-center text-xs text-muted-foreground">
                    Taking from{" "}
                    <span className="font-mono text-foreground">
                      {src ? `${src.name} · ` : ""}
                      {srcShelf} · Slot {item.from.slot + 1}
                    </span>
                  </p>
                )
              })()}
            {isStore && (
              <Field label="Update remaining weight (optional)" className="mb-4">
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={grams}
                    onChange={(e) => setGrams(e.target.value)}
                    placeholder="grams"
                  />
                  <span className="text-sm text-muted-foreground">g</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Leave as-is to keep the last known weight, or update it if the printer already did.
                </p>
              </Field>
            )}
            <Button
              size="lg"
              className="w-full"
              onClick={() => {
                const g = Number.parseInt(grams)
                dispatch({ type: "CONFIRM_STOP", grams: Number.isFinite(g) ? Math.max(0, g) : undefined })
              }}
            >
              <CheckCircle2 className="h-5 w-5" /> Confirm store
            </Button>
          </div>
        )}

        {/* other units getting ready in parallel */}
        {prepping.length > 0 && (status === "awaiting-pick-confirm" || status === "awaiting-store-confirm") && (
          <p className="mt-3 flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            {prepping.map((n) => n.name).join(", ")} rotating into place…
          </p>
        )}

        {/* cancel */}
        <button
          type="button"
          onClick={() => {
            if (confirm("Cancel the current operation? Remaining items in the queue will be dropped.")) {
              dispatch({ type: "CANCEL_JOB" })
            }
          }}
          className="mx-auto mt-4 block text-xs text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
        >
          Cancel operation
        </button>
      </div>
    </div>
  )
}

function MovingState({
  direction,
  from,
  to,
}: {
  direction: "up" | "down" | null
  from: number
  to: number | null
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <div className="relative flex h-16 w-16 items-center justify-center">
        <Loader2 className="h-16 w-16 animate-spin text-primary/30" />
        {direction === "up" ? (
          <ArrowUpCircle className="absolute h-8 w-8 text-primary" />
        ) : (
          <ArrowDownCircle className="absolute h-8 w-8 text-primary" />
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Rotating {direction === "up" ? "up" : "down"} · Shelf{" "}
        <span className="font-mono text-foreground">{from + 1}</span> →{" "}
        <span className="font-mono text-primary">{(to ?? 0) + 1}</span>
      </p>
    </div>
  )
}

function StopLocation({
  node,
  showNodeName,
  shelf,
  slot,
  verb,
}: {
  node: StorageNode | null
  showNodeName?: boolean
  shelf: number
  slot: number
  verb: string
}) {
  const isShelf = (node?.type ?? "paternoster") === "shelf"
  // Shelf nodes get their custom shelf name (e.g. "Middle"); paternosters keep
  // their numbered shelves. The node prefix appears when several units exist.
  const shelfName = node ? shelfLabel(node, shelf) : `Shelf ${shelf + 1}`
  const area = node?.shelfMeta?.[shelf]?.area?.trim() || node?.area?.trim()
  return (
    <div className="mb-3">
      <div className="flex items-center justify-center gap-2 rounded-xl border border-warning/50 bg-warning/10 p-3">
        <MapPin className="h-5 w-5 text-warning" />
        <span className="text-sm text-muted-foreground">
          {verb}{" "}
          <span className="font-mono font-semibold text-foreground">
            {showNodeName && node ? `${node.name} · ` : ""}
            {shelfName} · Slot {slot + 1}
          </span>
        </span>
      </div>
      <p className="mt-1.5 text-center text-xs text-muted-foreground">
        {area ? `Area: ${area}. ` : ""}
        {isShelf ? "The slot is highlighted on the shelf view." : "The slot is flashing yellow in the carousel."}
      </p>
    </div>
  )
}
