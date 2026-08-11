"use client"

import { useState } from "react"
import { Play, X, Plus, ListChecks, ChevronDown, ChevronUp } from "lucide-react"
import { useFlow } from "./flow-controller"
import { useStore } from "@/lib/store"
import { Button } from "./ui/button"
import { SpoolDisc } from "./spool"
import { printerSlotLabel, getNode, shelfLabel, orderQueueItems } from "@/lib/selectors"
import { isLightColor, spoolFill } from "@/lib/filament"

/**
 * Bottom sheet that appears while the user assembles a queue. Shows queued
 * items and lets them add more or start the machine.
 */
export function QueueTray({ onAddMore }: { onAddMore: () => void }) {
  const { flow, cancel, run } = useFlow()
  const { state } = useStore()
  // Let the user shrink the tray to just its header so it stops covering the
  // slots/printers they're navigating. Purely local UI state.
  const [collapsed, setCollapsed] = useState(false)

  if (!flow || flow.items.length === 0) return null

  const modeLabel =
    flow.mode === "pick" ? "Pick queue" : flow.mode === "store" ? "Store queue" : "Placement queue"
  const addLabel =
    flow.mode === "pick" ? "Pick more" : flow.mode === "store" ? "Take out more" : "Place another"
  const runLabel =
    flow.mode === "pick" ? "Start picking" : flow.mode === "store" ? "Start storing" : "Start placing"

  return (
    <div className="fixed inset-x-0 bottom-14 z-40 mx-auto max-w-3xl px-4">
      <div className="rounded-2xl border border-primary/40 bg-card/95 p-4 shadow-2xl backdrop-blur">
        <div className={collapsed ? "flex items-center justify-between" : "mb-3 flex items-center justify-between"}>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            className="flex items-center gap-2 rounded-md text-sm font-semibold hover:text-primary"
          >
            <ListChecks className="h-4 w-4 text-primary" />
            {modeLabel}
            <span className="rounded-md bg-primary/15 px-2 py-0.5 font-mono text-xs text-primary">
              {flow.items.length}
            </span>
            {collapsed ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
          <button
            type="button"
            onClick={cancel}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive"
          >
            <X className="h-4 w-4" /> Cancel
          </button>
        </div>

        {collapsed ? null : (
          <>
        <ul className="mb-4 flex gap-2 overflow-x-auto scrollbar-thin pb-1">
          {orderQueueItems(flow.items).map((it, i) => {
            const printer = it.printerId ? state.printers.find((p) => p.id === it.printerId) : undefined
            // Use the shelf's real name so shelf storage reads correctly (e.g.
            // "Middle·5") instead of a raw index ("S2·5") pointing at a phantom shelf.
            const itemNode = getNode(state, it.nodeId)
            const where = `${itemNode ? shelfLabel(itemNode, it.shelf) : `Shelf ${it.shelf + 1}`}·${it.slot + 1}`
            // A move shows its source too, so "src → dest" reads as a relocation.
            const fromNode = it.from ? getNode(state, it.from.nodeId) : undefined
            const fromWhere = it.from
              ? `${fromNode ? shelfLabel(fromNode, it.from.shelf) : `Shelf ${it.from.shelf + 1}`}·${it.from.slot + 1}`
              : null
            return (
              <li
                key={it.spool.id}
                className="flex shrink-0 flex-col items-center gap-1 rounded-xl border border-border bg-background/50 p-2"
              >
                <span className="font-mono text-[10px] text-muted-foreground">#{i + 1}</span>
                <SpoolDisc color={it.spool.color} size={44} fill={spoolFill(it.spool)} />
                <span
                  className="text-[11px] font-semibold"
                  style={{ color: isLightColor(it.spool.color) ? "#d4d4d8" : it.spool.color }}
                >
                  {it.spool.material}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {flow.mode === "pick"
                    ? `${where} → ${printer && it.printerSlot != null ? printerSlotLabel(printer, it.printerSlot) : "hand"}`
                    : fromWhere
                      ? `${fromWhere} → ${where}`
                      : `→ ${where}`}
                </span>
              </li>
            )
          })}
        </ul>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onAddMore}>
            <Plus className="h-4 w-4" /> {addLabel}
          </Button>
          <Button className="flex-1" onClick={run}>
            <Play className="h-4 w-4" /> {runLabel}
          </Button>
        </div>
          </>
        )}
      </div>
    </div>
  )
}
