"use client"

import { ChevronRight, Cog } from "lucide-react"
import { useStore } from "@/lib/store"
import { shelfLabel } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import { EmptySlot } from "../spool"
import { ManualControl } from "../manual-control"
import { ResizableSidebar } from "../resizable-sidebar"
import { DEFAULT_TOTE_COLOR } from "./part-box"
import type { StorageNode } from "@/lib/types"

/**
 * Left control panel for a HARDWARE paternoster — the mirror of the filament
 * sidebar (shelf overview + manual control) but bound to the hardware unit and
 * rendering part-colored tote dots instead of spool discs. Composed inside the
 * shared {@link ResizableSidebar} so the draggable divider behaves identically.
 */
export function HardwareSidebar({ node }: { node: StorageNode }) {
  return (
    <>
      <HardwareSidebarHeader node={node} />
      <ResizableSidebar
        storageKey="pax:hw-sidebar:shelfHeightV1"
        overview={<HardwareShelfOverview node={node} />}
        control={<ManualControl node={node} />}
      />
    </>
  )
}

function HardwareSidebarHeader({ node }: { node: StorageNode }) {
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-3">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <Cog className="h-6 w-6" />
      </div>
      <div className="min-w-0">
        <h1 className="truncate text-lg font-bold leading-tight">Hardware Storage</h1>
        <p className="truncate text-xs text-muted-foreground">{node.name}</p>
      </div>
    </header>
  )
}

/** Shelf list with a compact colored tote per occupied slot. */
function HardwareShelfOverview({ node }: { node: StorageNode }) {
  const { state, dispatch } = useStore()
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
                    {isCurrent ? <ChevronRight className="h-4 w-4 text-primary" /> : <span className="h-4 w-4" />}
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
                  <span className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-0.5">
                    {row.map((id, slot) => {
                      const part = id ? state.parts?.[id] : null
                      return part ? (
                        <span
                          key={slot}
                          className="h-3.5 w-3.5 shrink-0 rounded-[3px] border border-black/25"
                          style={{ backgroundColor: part.color || DEFAULT_TOTE_COLOR }}
                        />
                      ) : (
                        <EmptySlot key={slot} size={14} />
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
