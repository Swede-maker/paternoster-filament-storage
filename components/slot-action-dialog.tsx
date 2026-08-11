"use client"

import { useEffect, useState } from "react"
import {
  Pencil,
  Trash2,
  PackagePlus,
  PackageCheck,
  Save,
  Printer as PrinterIcon,
  HandMetal,
  ArrowLeftRight,
  ArrowLeft,
  Server,
  Package,
  MapPin,
  Plus,
  X,
} from "lucide-react"
import { useStore } from "@/lib/store"
import { activeNode, shelfLabel } from "@/lib/selectors"
import { nodeFreeSlots } from "@/lib/balance"
import { cn } from "@/lib/utils"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { SpoolForm, emptyDraft, type SpoolDraft } from "./spool-form"
import { SpoolDisc } from "./spool"
import { newId, spoolFill } from "@/lib/filament"
import type { NodeLocation } from "./flow-controller"
import type { Printer, Spool } from "@/lib/types"

/**
 * Action sheet for a tapped storage slot.
 *
 * Empty slots can be filled directly. Occupied slots open an action hub: load
 * the spool onto a printer, take it out into your hand, move it to another
 * storage unit, or edit / delete it — so a stored spool can leave its slot
 * without first forcing the user to pick a printer.
 */
export function SlotActionDialog({
  target,
  canLoad,
  fillPrinters = [],
  onLoad,
  onTakeOut,
  onMove,
  onPickFillPrinter,
  onClose,
}: {
  target: { shelf: number; slot: number } | null
  /** Whether at least one printer has a free slot to load into. */
  canLoad: boolean
  /**
   * Printers that currently hold a removable spool. When filling an empty slot
   * these appear as tabs above the create form so the user can instead pull a
   * spool straight off a printer. */
  fillPrinters?: Printer[]
  onLoad: (spool: Spool, loc: NodeLocation) => void
  onTakeOut: (spool: Spool, loc: NodeLocation) => void
  onMove: (spool: Spool, loc: NodeLocation, destNodeId: string) => void
  /** User picked a printer tab while filling an empty slot. */
  onPickFillPrinter?: (printer: Printer) => void
  onClose: () => void
}) {
  const { state, dispatch } = useStore()
  const node = activeNode(state)
  const open = target !== null

  const existingId = target ? node.slots[target.shelf]?.[target.slot] : null
  const existing: Spool | null = existingId ? state.spools[existingId] ?? null : null

  // "actions" hub, inline "edit" form, or "move" destination picker.
  const [view, setView] = useState<"actions" | "edit" | "move">("actions")
  const [draft, setDraft] = useState<SpoolDraft>(emptyDraft(state.settings.defaultSpoolWeight))

  // Reset editor state whenever the target changes.
  useEffect(() => {
    if (!target) return
    if (existing) {
      setView("actions")
      setDraft({
        material: existing.material,
        brand: existing.brand,
        color: existing.color,
        colorName: existing.colorName,
        grams: Math.round(existing.grams),
        capacity: Math.round(existing.capacity ?? existing.grams),
        nozzleTemp: existing.nozzleTemp,
        // Carry the current container through so the editor reflects reality and a
        // save doesn't silently keep a stale container the form never showed.
        containerId: existing.containerId,
      })
    } else {
      // Empty slot → create-new form. (Filling from a printer is handled upstream
      // by the tabbed spool picker before this dialog ever opens.)
      setView("edit")
      setDraft(emptyDraft(state.settings.defaultSpoolWeight))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.shelf, target?.slot])

  if (!target) return null

  const loc: NodeLocation = { nodeId: node.id, shelf: target.shelf, slot: target.slot }
  // Other units with room — the possible destinations for a move.
  const moveTargets = state.nodes.filter((n) => n.id !== node.id && nodeFreeSlots(n) > 0)

  function saveEdit() {
    if (!existing) return
    dispatch({ type: "UPDATE_SPOOL", id: existing.id, changes: { ...draft } })
    onClose()
  }

  function fillEmpty() {
    const spool: Spool = { id: newId("spool"), createdAt: Date.now(), ...draft }
    dispatch({ type: "UPSERT_SPOOL", spool })
    dispatch({ type: "SET_STORAGE_SLOT", nodeId: node.id, shelf: target!.shelf, slot: target!.slot, spoolId: spool.id })
    onClose()
  }

  function del() {
    if (!existing) return
    if (confirm(`Delete ${existing.material} ${existing.colorName}? This cannot be undone.`)) {
      dispatch({ type: "DELETE_SPOOL", id: existing.id })
      onClose()
    }
  }

  const slotLabel = `${shelfLabel(node, target.shelf)} · Slot ${target.slot + 1}`

  // ---- Occupied slot: action hub ----
  if (existing && view === "actions") {
    return (
      <Dialog open={open} onClose={onClose}>
        <DialogHeader icon={<PackageCheck className="h-5 w-5" />} title="What do you want to do?" description={slotLabel} />
        <DialogBody className="space-y-5">
          <SpoolSummary spool={existing} />
          <div className="flex flex-col gap-2">
            <Button size="lg" className="w-full justify-start" onClick={() => onLoad(existing, loc)} disabled={!canLoad}>
              <PrinterIcon className="h-5 w-5" /> Load onto a printer
            </Button>
            {!canLoad && (
              <p className="-mt-1 px-1 text-xs text-muted-foreground">
                No printer with a free slot. Add a printer or free a slot first.
              </p>
            )}
            <Button
              size="lg"
              variant="secondary"
              className="w-full justify-start"
              onClick={() => onTakeOut(existing, loc)}
            >
              <HandMetal className="h-5 w-5" /> Take out of storage
            </Button>
            {moveTargets.length > 0 && (
              <Button
                size="lg"
                variant="secondary"
                className="w-full justify-start"
                onClick={() => setView("move")}
              >
                <ArrowLeftRight className="h-5 w-5" /> Move to another unit
              </Button>
            )}
            <div className="mt-1 flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setView("edit")}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
              <Button variant="destructive" className="flex-1" onClick={del}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </div>
          </div>
        </DialogBody>
      </Dialog>
    )
  }

  // ---- Move: choose a destination unit ----
  if (existing && view === "move") {
    return (
      <Dialog open={open} onClose={onClose}>
        <DialogHeader icon={<ArrowLeftRight className="h-5 w-5" />} title="Move to which unit?" description={slotLabel} />
        <DialogBody className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {moveTargets.map((n) => {
              const isShelf = (n.type ?? "paternoster") === "shelf"
              const Icon = isShelf ? Package : Server
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => onMove(existing, loc, n.id)}
                  className="flex items-start gap-2 rounded-xl border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/60"
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{n.name}</span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      {n.area && (
                        <>
                          <MapPin className="h-3 w-3" />
                          {n.area}
                          <span aria-hidden>·</span>
                        </>
                      )}
                      {isShelf ? "Shelf" : "Paternoster"}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{nodeFreeSlots(n)} free</span>
                  </span>
                </button>
              )
            })}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setView("actions")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  // Empty-slot create form gets a printer-tab row so the user can instead pull a
  // spool off a printer. "New spool" (this form) is the active default tab.
  const showFillTabs = !existing && fillPrinters.length > 0 && !!onPickFillPrinter

  // ---- Edit an existing spool, or fill an empty slot ----
  return (
    <Dialog open={open} onClose={onClose} hideClose={showFillTabs}>
      {showFillTabs && (
        <div className="-mx-5 -mt-5 mb-4 flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="flex flex-1 items-center justify-center gap-1.5 overflow-x-auto scrollbar-thin">
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded-lg border border-primary bg-primary/15 px-3 py-1.5 text-sm font-medium text-primary"
            >
              <Plus className="h-4 w-4" /> New spool
            </button>
            {fillPrinters.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPickFillPrinter?.(p)}
                className={cn(
                  "shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
                  "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
      <DialogHeader
        icon={existing ? <Pencil className="h-5 w-5" /> : <PackagePlus className="h-5 w-5" />}
        title={existing ? "Edit spool" : "Fill this slot"}
        description={slotLabel}
      />
      <DialogBody>
        <SpoolForm value={draft} onChange={setDraft} />
      </DialogBody>
      <DialogFooter>
        {existing ? (
          <>
            <Button variant="ghost" onClick={() => setView("actions")}>
              <ArrowLeft className="h-4 w-4" /> Back
            </Button>
            <Button onClick={saveEdit}>
              <Save className="h-4 w-4" /> Save changes
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={fillEmpty}>
              <PackagePlus className="h-4 w-4" /> Place here
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  )
}

/** Compact spool identity row shown atop the action hub. */
function SpoolSummary({ spool }: { spool: Spool }) {
  return (
    <div className="flex items-center gap-3">
      <SpoolDisc color={spool.color} size={48} fill={spoolFill(spool)} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">
          {spool.material} · {spool.colorName}
        </p>
        <p className="truncate text-xs text-muted-foreground">{spool.brand}</p>
      </div>
    </div>
  )
}
