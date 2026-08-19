"use client"

import { PackagePlus, ListChecks } from "lucide-react"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { SpoolDisc, discColor2 } from "./spool"
import { isLightColor, spoolFill } from "@/lib/filament"
import type { PendingItem } from "./flow-controller"

/**
 * Manual shelf placement chooser. When spools are waiting in the store/place
 * queue and the user taps an EMPTY shelf slot, this lets them either drop one of
 * the queued spools straight into that slot, or create a brand-new spool for it
 * (leaving the rest of the queue untouched). Shelf storage only — a paternoster
 * needs the carousel to rotate, so it keeps the Start-driven flow.
 */
export function QueuePlaceDialog({
  target,
  items,
  slotLabel,
  onPickQueued,
  onCreateNew,
  onClose,
}: {
  /** null = closed. */
  target: { shelf: number; slot: number } | null
  items: PendingItem[]
  slotLabel: string
  onPickQueued: (spoolId: string) => void
  onCreateNew: () => void
  onClose: () => void
}) {
  return (
    <Dialog open={target !== null} onClose={onClose}>
      <DialogHeader
        icon={<ListChecks className="h-5 w-5" />}
        title="Place into this slot"
        description={slotLabel}
      />
      <DialogBody className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Choose from the queue
          </p>
          {items.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">No spools waiting in the queue.</p>
          ) : (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {items.map((it) => (
                <li key={it.spool.id}>
                  <button
                    type="button"
                    onClick={() => onPickQueued(it.spool.id)}
                    className="flex w-full flex-col items-center gap-2 rounded-xl border border-border bg-background/50 p-3 transition-colors hover:border-primary/60 hover:bg-primary/5"
                  >
                    <SpoolDisc
                      color={it.spool.color}
                      color2={discColor2(it.spool)}
                      size={48}
                      fill={spoolFill(it.spool)}
                      boxed={!!it.spool.containerId}
                    />
                    <span
                      className="text-[11px] font-semibold leading-none"
                      style={{ color: isLightColor(it.spool.color) ? "#d4d4d8" : it.spool.color }}
                    >
                      {it.spool.material}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{it.spool.colorName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={onCreateNew}>
          <PackagePlus className="h-4 w-4" /> Create new spool
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
