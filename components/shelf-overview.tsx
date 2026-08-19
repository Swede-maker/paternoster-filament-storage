"use client"

import { ChevronRight } from "lucide-react"
import { useStore } from "@/lib/store"
import { activeNode, shelfLabel } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import { spoolFill } from "@/lib/filament"
import { SpoolDisc, EmptySlot, discColor2 } from "./spool"

export function ShelfOverview() {
  const { state, dispatch } = useStore()
  const node = activeNode(state)
  const shelves = node.slots.length
  const { currentShelf, homed, status } = node.machine
  const canNavigate = homed && status === "idle" && !state.job

  return (
    <section aria-label="Shelf overview" className="flex flex-col lg:min-h-0 lg:flex-1">
      <h2 className="px-4 pb-2 pt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Shelf Overview <span className="text-muted-foreground/70">({shelves} shelves)</span>
      </h2>
      <div className="px-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:scrollbar-thin">
        <ul className="flex flex-col gap-1 pb-2">
          {Array.from({ length: shelves }).map((_, shelf) => {
            const row = node.slots[shelf] ?? []
            const isCurrent = shelf === currentShelf
            return (
              <li key={shelf}>
                <button
                  type="button"
                  disabled={!canNavigate}
                  onClick={() => dispatch({ type: "GOTO_SHELF", nodeId: node.id, shelf })}
                  aria-current={isCurrent ? "true" : undefined}
                  className={cn(
                    "group flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors",
                    isCurrent
                      ? "border-primary/60 bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-secondary/40",
                    !canNavigate && "cursor-default opacity-95",
                  )}
                >
                  <span className="flex w-6 shrink-0 items-center justify-center">
                    {isCurrent ? (
                      <ChevronRight className="h-4 w-4 text-primary" />
                    ) : (
                      <span className="h-4 w-4" />
                    )}
                  </span>
                  <span
                    className={cn(
                      "w-5 shrink-0 text-center font-mono text-sm font-semibold",
                      isCurrent ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {shelf + 1}
                  </span>
                  <span
                    className={cn(
                      "w-14 shrink-0 truncate text-sm",
                      isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {shelfLabel(node, shelf)}
                  </span>
                  {/* Keep every slot on one line: a tight gap and compact dots let
                      a full shelf fit the sidebar width without wrapping or clipping. */}
                  <span className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-0.5">
                    {row.map((id, slot) => {
                      const spool = id ? state.spools[id] : null
                      return (
                        <span key={slot} className="flex flex-col items-center gap-0.5">
                          {spool ? (
                            <SpoolDisc color={spool.color} color2={discColor2(spool)} size={14} fill={spoolFill(spool)} />
                          ) : (
                            <EmptySlot size={14} />
                          )}
                        </span>
                      )
                    })}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
