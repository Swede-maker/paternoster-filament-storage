"use client"

import { useEffect, useState } from "react"
import { Loader2, CheckCircle2, ArrowUpCircle, ArrowDownCircle, MapPin, Layers, QrCode, ScanLine, Plus } from "lucide-react"
import { useStore } from "@/lib/store"
import { Button } from "./ui/button"
import { Input, Field } from "./ui/field"
import { SpoolDisc, discColor2 } from "./spool"
import { PartBox } from "./hardware/part-box"
import { HardwareForm } from "./hardware/hardware-form"
import { placeNewPart } from "@/lib/hardware-flow"
import { formatGrams, isLightColor } from "@/lib/filament"
import { printerSlotLabel, shelfLabel, getNode, partWeightGrams } from "@/lib/selectors"
import { findBinding, shortTagId } from "@/lib/tags"
import { TagScanner } from "./tag-scanner"
import type { HardwarePart, Printer, Spool, StorageNode } from "@/lib/types"

/**
 * Full-screen operation overlay shown whenever a job is running. Displays the
 * rotating state and the "confirm pick / confirm store" gate, plus the optional
 * grams prompt when storing.
 */
export function MotionOverlay() {
  const { state, dispatch } = useStore()
  const job = state.job
  const [grams, setGrams] = useState<string>("")
  // How many pieces to take out at a hardware pick stop, entered live per box.
  const [takeQty, setTakeQty] = useState<string>("1")
  // Scan-to-confirm state for disambiguating identical spools (see below).
  const [scanOpen, setScanOpen] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  // "Queue another part" form, opened from the + in the progress row so the
  // operator can pile up placements without leaving the running operation.
  const [addOpen, setAddOpen] = useState(false)
  const [queueError, setQueueError] = useState<string | null>(null)
  // Clear any stale scan warning whenever we advance to a new stop.
  useEffect(() => setScanError(null), [job?.currentIndex])

  const item = job?.items[job.currentIndex] ?? null
  // The overlay follows the node that hosts the current job item.
  const node = item ? state.nodes.find((n) => n.id === item.nodeId) ?? null : null
  const { status, direction, targetShelf, currentShelf } = node?.machine ?? {
    status: "idle" as const,
    direction: null,
    targetShelf: null,
    currentShelf: 0,
  }
  // An item is either a filament spool or a hardware part box. For a part,
  // `spool` stays null (so all spool-only UI — disc, grams prompt, tag scan —
  // is skipped) and we render the part identity instead.
  const isPart = item?.occupantKind === "part"
  const spool = item && !isPart ? state.spools[item.spoolId] : null
  const part = item && isPart ? state.parts[item.spoolId] ?? null : null
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

  // Reset the take-out quantity to 1 each time the carousel reaches a new
  // hardware pick stop, so the operator deliberately dials in the amount.
  useEffect(() => {
    if (status === "awaiting-pick-confirm" && part) setTakeQty("1")
  }, [status, part?.id])

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

  // --- Identical-spool disambiguation ---------------------------------------
  // When several physically identical spools (same material + colour) are being
  // stored in one job, the operator can't tell which one a given slot wants. We
  // detect that here, surface the expected spool's QR id, and offer a scan that
  // auto-corrects the plan so the scanned spool takes the current slot.
  const sig = (s: Spool) =>
    `${s.material}|${(s.color || "").toLowerCase()}|${(s.color2 || "").toLowerCase()}|${(s.colorName || "").trim().toLowerCase()}`
  const group =
    isStore && spool
      ? job.items.filter((it) => {
          if (it.done) return false
          const s = state.spools[it.spoolId]
          return s ? sig(s) === sig(spool) : false
        })
      : []
  const expectedTagId = spool?.tagId
  // Only caution when the operator actually has a way to tell the spools apart:
  // more than one indistinguishable spool is still unplaced AND this spool
  // carries a QR/RFID tag. If tags aren't in use there's no ID to verify, so we
  // stay out of the way entirely.
  const ambiguous = group.length > 1 && !!expectedTagId
  const canScan = ambiguous

  const commitStore = () => {
    const g = Number.parseInt(grams)
    dispatch({ type: "CONFIRM_STOP", grams: Number.isFinite(g) ? Math.max(0, g) : undefined })
  }

  // Queue another hardware part behind the running operation. placeNewPart
  // reserves already-queued slots, so the new box gets its own balanced slot and
  // is appended to the current place job (or runs right after a pick/store one).
  const handleQueue = (part: HardwarePart) => {
    const ok = placeNewPart(state, dispatch, part, item?.nodeId)
    setQueueError(ok ? null : "All hardware storage is full. Free a slot or add a unit first.")
  }

  // Resolve a raw scan to a spool id: prefer a direct spool-tag match among the
  // job's spools, then fall back to a stored binding.
  const resolveScannedSpool = (scanned: string): string | null => {
    const direct = job.items.find((it) => state.spools[it.spoolId]?.tagId === scanned)
    if (direct) return direct.spoolId
    const b = findBinding(state, scanned)
    return b?.target.kind === "spool" ? b.target.spoolId : null
  }

  const handleConfirmScan = (scanned: string) => {
    setScanOpen(false)
    if (!item) return
    const sid = resolveScannedSpool(scanned)
    if (!sid) {
      setScanError(`QR ${shortTagId(scanned)} isn't recognised. Scan one of the spools from this batch.`)
      return
    }
    // Right spool already — just store it.
    if (sid === item.spoolId) {
      setScanError(null)
      commitStore()
      return
    }
    // A different but identical spool still waiting in this job → auto-correct
    // so the one in hand takes this slot, then store.
    const scannedSpool = state.spools[sid]
    const inGroup =
      !!scannedSpool &&
      !!spool &&
      sig(scannedSpool) === sig(spool) &&
      job.items.some((it) => !it.done && it.spoolId === sid)
    if (inGroup) {
      setScanError(null)
      dispatch({ type: "SWAP_JOB_SPOOL", scannedSpoolId: sid })
      commitStore()
      return
    }
    setScanError(`That spool (QR ${shortTagId(scanned)}) isn't one of the spools left in this batch.`)
  }

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto max-h-[58vh] w-full max-w-md overflow-y-auto rounded-2xl border border-primary/30 bg-card/95 p-5 shadow-2xl backdrop-blur-md scrollbar-thin lg:max-h-[85vh]">
        {/* progress */}
        <div className="mb-4 flex items-center justify-between text-xs text-muted-foreground">
          <span className="uppercase tracking-wider">
            {isPart
              ? job.mode === "pick"
                ? "Retrieving hardware"
                : "Placing hardware"
              : job.mode === "pick"
              ? "Picking filament"
              : // A single store-mode job can carry placements (brand-new spools),
                // stores (off a printer), and moves. Label by the current item so
                // the wording matches what's actually happening.
                item && !item.from && item.printerId == null
                ? "Placing filament"
                : "Storing filament"}
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono">
              {step} / {total}
            </span>
            {isPart && (
              <button
                type="button"
                onClick={() => {
                  setQueueError(null)
                  setAddOpen(true)
                }}
                className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 py-2.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
                aria-label="Queue another part behind this operation"
                title="Queue another part"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} /> Queue
              </button>
            )}
          </div>
        </div>
        {queueError && (
          <p className="-mt-2 mb-3 text-xs font-medium text-warning text-pretty">{queueError}</p>
        )}

        {/* spool identity */}
        {spool && (
          <div className="mb-5 flex items-center gap-4">
            <SpoolDisc color={spool.color} color2={discColor2(spool)} size={72} />
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

        {/* hardware part identity */}
        {part && (
          <div className="mb-5 flex items-center gap-4">
            <PartBox color={part.color} size={72} imageUrl={part.imageUrl} name={part.name} />
            <div>
              <p className="text-lg font-semibold text-foreground">{part.name}</p>
              <p className="text-sm text-muted-foreground">
                {part.category ? `${part.category} · ` : ""}
                {part.count} pcs · {formatGrams(partWeightGrams(part))}
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
              verb={isPart ? "Take hardware from" : "Take spool from"}
            />
            {printer && item.printerSlot != null && (
              <p className="mb-4 text-sm text-muted-foreground">
                Load into <span className="font-semibold text-primary">{printer.name}</span> slot{" "}
                <span className="font-mono text-foreground">{printerSlotLabel(printer, item.printerSlot)}</span>
              </p>
            )}
            {isPart && part && item.partOp?.kind === "take" ? (
              (() => {
                const qty = Math.max(0, Math.round(Number.parseFloat(takeQty) || 0))
                const capped = Math.min(qty, part.count)
                return (
                  <>
                    <Field label={`How many to take out? (max ${part.count})`} className="mb-4 text-left">
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={part.count}
                        value={takeQty}
                        autoFocus
                        onChange={(e) => setTakeQty(e.target.value)}
                      />
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Leaves <span className="font-mono text-foreground">{Math.max(0, part.count - capped)}</span> pcs.
                        Taking all empties the slot.
                      </p>
                    </Field>
                    <Button
                      size="lg"
                      className="w-full"
                      disabled={capped <= 0}
                      onClick={() => dispatch({ type: "CONFIRM_STOP", takeCount: capped })}
                    >
                      <CheckCircle2 className="h-5 w-5" /> Take {capped} &amp; confirm
                    </Button>
                  </>
                )
              })()
            ) : (
              <Button size="lg" className="w-full" onClick={() => dispatch({ type: "CONFIRM_STOP" })}>
                <CheckCircle2 className="h-5 w-5" /> Confirm pick
              </Button>
            )}
          </div>
        )}

        {status === "awaiting-store-confirm" && item && (
          <div>
            <StopLocation
              node={node}
              showNodeName={multiNode}
              shelf={item.shelf}
              slot={item.slot}
              verb={
                isPart
                  ? "Place hardware in"
                  : item.from
                  ? "Move spool to"
                  : item.printerId != null
                  ? "Store spool in"
                  : "Place spool in"
              }
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
            {ambiguous && (
              <div className="mb-4 rounded-xl border border-warning/40 bg-warning/5 p-3">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Layers className="h-4 w-4 text-warning" />
                  {group.length} identical spools left in this batch
                </p>
                <p className="mt-1 text-xs text-muted-foreground text-pretty">
                  They look the same, so make sure you grab the right one.
                  {expectedTagId && (
                    <>
                      {" "}
                      This slot expects the spool labelled{" "}
                      <span className="font-mono font-semibold text-foreground">QR {shortTagId(expectedTagId)}</span>.
                    </>
                  )}
                </p>
                {canScan && (
                  <Button variant="outline" size="sm" className="mt-2 w-full" onClick={() => setScanOpen(true)}>
                    <ScanLine className="h-4 w-4" /> Scan spool to confirm
                  </Button>
                )}
                {scanError && <p className="mt-2 text-xs font-medium text-destructive text-pretty">{scanError}</p>}
              </div>
            )}
            {isStore && !isPart && (
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
              variant={ambiguous ? "outline" : "primary"}
              className="w-full"
              onClick={commitStore}
            >
              <CheckCircle2 className="h-5 w-5" /> {ambiguous ? "Confirm without scanning" : "Confirm store"}
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

      <TagScanner
        open={scanOpen}
        title="Scan this spool"
        description="Point the camera at the spool's QR label, or use a wireless reader, to confirm which spool goes in this slot."
        onScan={handleConfirmScan}
        onClose={() => setScanOpen(false)}
      />

      {/* Queue-another-part form, launched from the + in the progress row. */}
      <HardwareForm open={addOpen} onClose={() => setAddOpen(false)} onSubmit={handleQueue} />
    </>
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
