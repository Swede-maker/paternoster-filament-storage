"use client"

import { useMemo } from "react"
import { Check, MapPin } from "lucide-react"
import { useStore } from "@/lib/store"
import { useSpoolSelection } from "@/lib/use-spool-selection"
import { SpoolSelectionBar, SelectModeButton } from "./spool-selection-bar"
import { activeNode, shelfArea, shelfLabel } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import { formatRemaining, spoolFill } from "@/lib/filament"
import { SpoolDisc, EmptySlot } from "./spool"

/**
 * Static rack view for manual (no-hardware) shelf storage. Unlike the
 * paternoster carousel there's no rotation — every shelf is shown at once so
 * the user can see the whole unit and walk to the right shelf/area by hand.
 */
export function ShelfStorageView({
  onSlotClick,
  highlight,
}: {
  onSlotClick: (shelf: number, slot: number) => void
  highlight?: { shelf: number; slot: number } | null
}) {
  const { state, dispatch } = useStore()
  const node = activeNode(state)
  const selection = useSpoolSelection()

  // Flat list of every occupied slot in the unit — powers select-all, the
  // selected count total, and the batch actions.
  const occupied = useMemo(() => {
    const out: { id: string; shelf: number; slot: number }[] = []
    node.slots.forEach((row, shelf) => {
      row.forEach((id, slot) => {
        if (id && state.spools[id]) out.push({ id, shelf, slot })
      })
    })
    return out
  }, [node.slots, state.spools])

  // Delete every ticked spool. DELETE_SPOOL also empties its slot.
  function deleteSelected() {
    for (const id of selection.selected) dispatch({ type: "DELETE_SPOOL", id })
    selection.exit()
  }

  return (
    <div
      id="pax-shelf-storage"
      className="min-h-[380px] scroll-mt-3 space-y-3 overflow-y-auto rounded-2xl border border-border bg-gradient-to-b from-card to-background p-3 scrollbar-thin lg:min-h-0 lg:flex-1"
    >
      {/* Multi-select control strip. Sticky so it stays reachable while the
          rack scrolls. */}
      <div className="sticky top-0 z-10 -mx-3 -mt-3 mb-1 border-b border-border bg-card/95 px-3 py-2 backdrop-blur">
        {selection.active ? (
          <SpoolSelectionBar
            count={selection.count}
            total={occupied.length}
            onDelete={deleteSelected}
            onSelectAll={() => selection.selectAll(occupied.map((o) => o.id))}
            onClear={selection.clear}
            onExit={selection.exit}
          />
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{node.name}</span>
            <span className="ml-auto">
              <SelectModeButton onClick={() => selection.enter()} disabled={!!state.job || occupied.length === 0} />
            </span>
          </div>
        )}
      </div>
      {node.slots.map((row, shelf) => {
        const area = shelfArea(node, shelf)
        const used = row.filter(Boolean).length
        return (
          <section
            key={shelf}
            className="rounded-xl border border-border bg-background/40 p-3"
            aria-label={shelfLabel(node, shelf)}
          >
            <header className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-sm font-semibold text-primary">{shelfLabel(node, shelf)}</span>
              {area && (
                <span className="inline-flex items-center gap-1 rounded-full bg-secondary/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                  <MapPin className="h-3 w-3" /> {area}
                </span>
              )}
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {used}/{row.length}
              </span>
            </header>

            <div className="flex flex-wrap items-start gap-2">
              {row.map((id, slot) => {
                const spool = id ? state.spools[id] : null
                const isHi = highlight && highlight.shelf === shelf && highlight.slot === slot
                const isSel = !!spool && selection.selected.has(spool.id)
                // In selection mode, empty slots are inert and occupied slots
                // toggle instead of opening the single-spool action dialog.
                const handleClick = () => {
                  if (selection.active) {
                    if (spool) selection.toggle(spool.id)
                  } else {
                    onSlotClick(shelf, slot)
                  }
                }
                return (
                  <button
                    key={slot}
                    type="button"
                    aria-pressed={selection.active && spool ? isSel : undefined}
                    disabled={selection.active && !spool}
                    onClick={handleClick}
                    className={cn(
                      "relative flex w-[62px] flex-col items-center gap-1 rounded-xl p-1 transition-colors hover:bg-primary/10",
                      isHi && "animate-slot-flash",
                      selection.active && spool && "ring-1 ring-inset ring-border",
                      selection.active && !spool && "opacity-40",
                      isSel && "bg-primary/15 ring-2 ring-primary",
                    )}
                  >
                    {selection.active && spool && (
                      <span
                        className={cn(
                          "absolute right-0.5 top-0.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border",
                          isSel ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background",
                        )}
                        aria-hidden
                      >
                        {isSel && <Check className="h-3 w-3" />}
                      </span>
                    )}
                    <span className="font-mono text-[11px] text-muted-foreground">{slot + 1}</span>
                    {spool ? (
                      <SpoolDisc color={spool.color} size={52} fill={spoolFill(spool)} boxed={!!spool.containerId} />
                    ) : (
                      <EmptySlot size={52} />
                    )}
                    <span className="mt-0.5 flex h-11 flex-col items-center justify-start leading-tight">
                      {spool && (
                        <>
                          {/* Material always uses the foreground token so it stays
                              legible no matter how dark/light the spool colour is. */}
                          <span className="text-[10px] font-semibold text-foreground">{spool.material}</span>
                          {/* Colour is shown as a swatch dot + name (like the library)
                              so a black or white spool is still readable. */}
                          <span className="flex max-w-full items-center gap-1 text-[9px] text-muted-foreground">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full border border-border"
                              style={{ backgroundColor: spool.color }}
                              aria-hidden
                            />
                            <span className="truncate">{spool.colorName?.trim() || spool.color}</span>
                          </span>
                          <span className="text-[9px] text-muted-foreground">{formatRemaining(spool)}</span>
                        </>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
