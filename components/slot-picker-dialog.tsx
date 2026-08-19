"use client"

import * as React from "react"
import { Boxes, Plus, X } from "lucide-react"
import { Dialog, DialogHeader, DialogBody } from "./ui/dialog"
import { printerSlotLabel } from "@/lib/selectors"
import { spoolFill, isLightColor } from "@/lib/filament"
import { SpoolDisc, discColor2 } from "./spool"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import type { Printer } from "@/lib/types"

/**
 * Choose which printer slot to act on next.
 *
 * - mode "empty"  → lists empty slots (the "Pick more" / load step)
 * - mode "loaded" → lists loaded slots (the "Take out more" / store step)
 *
 * When `printers` holds more than one candidate, a printer-tab row is shown at
 * the top so the user can switch printers in-place (no separate picker dialog).
 * Slots already in the current queue are excluded.
 */
export function SlotPickerDialog({
  printer,
  printers,
  queuedSlots = [],
  queuedSlotsFor,
  mode = "empty",
  onClose,
  onPick,
  onCreateNew,
}: {
  /** The initially-selected printer. null = closed. */
  printer: Printer | null
  /** Candidate printers to show as switchable tabs. Defaults to [printer]. */
  printers?: Printer[]
  queuedSlots?: number[]
  /** Per-printer queued slots (used when tabs let the user switch printer). */
  queuedSlotsFor?: (printerId: string) => number[]
  mode?: "empty" | "loaded"
  onClose: () => void
  onPick: (printer: Printer, slot: number) => void
  /** When set, adds a trailing "New spool" tab that opens a create form instead. */
  onCreateNew?: () => void
}) {
  const { state } = useStore()
  const open = printer != null
  const loadedMode = mode === "loaded"

  const tabs = printers && printers.length > 0 ? printers : printer ? [printer] : []
  // Show the tab row when the user can switch printers, or when a "New spool"
  // escape hatch is offered (so it's reachable even with a single printer).
  const showTabs = tabs.length > 1 || !!onCreateNew

  // Track which tab is selected; (re)seed from the incoming printer each open.
  const [selectedId, setSelectedId] = React.useState<string | null>(printer?.id ?? null)
  const seedId = printer?.id
  React.useEffect(() => {
    if (seedId) setSelectedId(seedId)
  }, [seedId])

  const selected = tabs.find((p) => p.id === selectedId) ?? printer
  const queued = selected ? (queuedSlotsFor ? queuedSlotsFor(selected.id) : queuedSlots) : []

  const slots =
    selected == null
      ? []
      : selected.loaded
          .map((id, i) => ({ id, i }))
          .filter(({ id, i }) => (loadedMode ? id != null : id == null) && !queued.includes(i))
          .map(({ id, i }) => ({ slot: i, spoolId: id }))

  return (
    <Dialog open={open} onClose={onClose} hideClose={showTabs}>
      {showTabs && (
        <div className="-mx-5 -mt-5 mb-4 flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="flex flex-1 items-center justify-center gap-1.5 overflow-x-auto scrollbar-thin">
            {onCreateNew && (
              <button
                type="button"
                onClick={onCreateNew}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Plus className="h-4 w-4" /> New spool
              </button>
            )}
            {tabs.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  "shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
                  p.id === selectedId
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
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
        icon={<Boxes className="h-5 w-5" />}
        title={loadedMode ? "Pick a spool to take out" : "Pick a slot to load"}
        description={selected ? `Choose a ${loadedMode ? "loaded" : "empty"} slot on ${selected.name}.` : ""}
      />
      <DialogBody>
        {!selected || slots.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {loadedMode ? "No other loaded spools on this printer." : "No empty slots left on this printer."}
          </p>
        ) : (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {slots.map(({ slot, spoolId }) => {
              const spool = spoolId ? state.spools[spoolId] : undefined
              return (
                <li key={slot}>
                  <button
                    type="button"
                    onClick={() => onPick(selected, slot)}
                    className="flex w-full flex-col items-center gap-2 rounded-xl border border-border bg-background/50 p-3 transition-colors hover:border-primary/60 hover:bg-primary/5"
                  >
                    {spool ? (
                      <SpoolDisc color={spool.color} color2={discColor2(spool)} size={48} fill={spoolFill(spool)} />
                    ) : (
                      <span className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-border bg-background/60 text-muted-foreground/60">
                        <Plus className="h-5 w-5" />
                      </span>
                    )}
                    {spool && (
                      <span
                        className="text-[11px] font-semibold leading-none"
                        style={{ color: isLightColor(spool.color) ? "#d4d4d8" : spool.color }}
                      >
                        {spool.material}
                      </span>
                    )}
                    <span className="font-mono text-sm font-semibold text-foreground">
                      {printerSlotLabel(selected, slot)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </DialogBody>
    </Dialog>
  )
}
