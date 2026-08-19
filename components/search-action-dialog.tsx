"use client"

import { PackageCheck, HandMetal, Printer as PrinterIcon } from "lucide-react"
import { Dialog, DialogHeader, DialogBody } from "./ui/dialog"
import { Button } from "./ui/button"
import { SpoolDisc, discColor2 } from "./spool"
import { formatGrams, isLightColor, spoolFill } from "@/lib/filament"
import { useStore } from "@/lib/store"
import { getNode, shelfLabel } from "@/lib/selectors"
import type { Spool } from "@/lib/types"

/**
 * Shown when the user taps a spool in the search browser. Offers to load the
 * spool onto a printer, take it out of storage (into their hand), or cancel.
 */
export function SearchActionDialog({
  target,
  canLoad,
  onLoad,
  onTakeOut,
  onClose,
}: {
  target: { spool: Spool; loc: { nodeId: string; shelf: number; slot: number } } | null
  /** Whether at least one printer has an empty slot to load into. */
  canLoad: boolean
  onLoad: () => void
  onTakeOut: () => void
  onClose: () => void
}) {
  const { state } = useStore()
  const open = target != null
  const spool = target?.spool
  const loc = target?.loc

  // Describe the source with the unit's real names (e.g. "Garage Rack · Middle ·
  // Slot 5") instead of raw indices, which read wrong for named shelf storage.
  let description = ""
  if (loc) {
    const node = getNode(state, loc.nodeId)
    const shelf = node ? shelfLabel(node, loc.shelf) : `Shelf ${loc.shelf + 1}`
    description = `Currently in ${node ? `${node.name} · ` : ""}${shelf} · Slot ${loc.slot + 1}.`
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader
        icon={<PackageCheck className="h-5 w-5" />}
        title="What do you want to do?"
        description={description}
      />
      <DialogBody className="space-y-5">
        {spool && (
          <div className="flex items-center gap-4">
            <SpoolDisc color={spool.color} color2={discColor2(spool)} size={64} fill={spoolFill(spool)} />
            <div className="min-w-0">
              <p
                className="text-base font-semibold"
                style={{ color: isLightColor(spool.color) ? "#d4d4d8" : spool.color }}
              >
                {spool.material} · {spool.colorName}
              </p>
              <p className="text-sm text-muted-foreground">
                {spool.brand} · {formatGrams(spool.grams)}
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Button size="lg" className="w-full justify-start" onClick={onLoad} disabled={!canLoad}>
            <PrinterIcon className="h-5 w-5" /> Load onto a printer
          </Button>
          {!canLoad && (
            <p className="-mt-1 px-1 text-xs text-muted-foreground">
              No printer with a free slot. Add a printer or free a slot first.
            </p>
          )}
          <Button size="lg" variant="secondary" className="w-full justify-start" onClick={onTakeOut}>
            <HandMetal className="h-5 w-5" /> Take out of storage
          </Button>
          <Button size="lg" variant="ghost" className="w-full justify-start" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  )
}
