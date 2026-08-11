"use client"

import { MapPin } from "lucide-react"
import { useStore } from "@/lib/store"
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
  const { state } = useStore()
  const node = activeNode(state)

  return (
    <div
      id="pax-shelf-storage"
      className="min-h-[380px] scroll-mt-3 space-y-3 overflow-y-auto rounded-2xl border border-border bg-gradient-to-b from-card to-background p-3 scrollbar-thin lg:min-h-0 lg:flex-1"
    >
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
                return (
                  <button
                    key={slot}
                    type="button"
                    onClick={() => onSlotClick(shelf, slot)}
                    className={cn(
                      "flex w-[62px] flex-col items-center gap-1 rounded-xl p-1 transition-colors hover:bg-primary/10",
                      isHi && "animate-slot-flash",
                    )}
                  >
                    <span className="font-mono text-[11px] text-muted-foreground">{slot + 1}</span>
                    {spool ? (
                      <SpoolDisc color={spool.color} size={52} fill={spoolFill(spool)} boxed={!!spool.containerId} />
                    ) : (
                      <EmptySlot size={52} />
                    )}
                    <span className="mt-0.5 flex h-8 flex-col items-center justify-start leading-tight">
                      {spool && (
                        <>
                          <span
                            className="text-[10px] font-semibold"
                            style={{ color: spool.color === "#f4f4f5" ? "#e5e5e5" : spool.color }}
                          >
                            {spool.material}
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
