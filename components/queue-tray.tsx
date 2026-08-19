"use client"

import { useState } from "react"
import { Play, X, Plus, ListChecks, ChevronDown, ChevronUp } from "lucide-react"
import { useFlow } from "./flow-controller"
import { useStore } from "@/lib/store"
import { Button } from "./ui/button"
import { SpoolDisc, discColor2 } from "./spool"
import { printerSlotLabel, getNode, shelfLabel, orderQueueItems } from "@/lib/selectors"
import { nodeFreeSlots } from "@/lib/balance"
import { isLightColor, spoolFill } from "@/lib/filament"

/**
 * Bottom sheet that appears while the user assembles a queue. Shows queued
 * items and lets them add more or start the machine.
 */
export function QueueTray({ onAddMore }: { onAddMore: () => void }) {
  const { flow, cancel, run, reassignItemNode } = useFlow()
  const { state } = useStore()
  // Storage units a queued spool can be redirected into: a library is unbounded,
  // fixed grids need a free slot (the item's own current unit always qualifies).
  const nodeHasRoom = (nodeId: string, currentNodeId: string) => {
    if (nodeId === currentNodeId) return true
    const node = state.nodes.find((n) => n.id === nodeId)
    if (!node) return false
    return (node.type ?? "paternoster") === "library" || nodeFreeSlots(node) > 0
  }
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
            // A library has no shelves/slots, so a "Shelf·N" label would be a
            // meaningless phantom position — show the library's name instead.
            const where =
              itemNode && (itemNode.type ?? "paternoster") === "library"
                ? itemNode.name
                : `${itemNode ? shelfLabel(itemNode, it.shelf) : `Shelf ${it.shelf + 1}`}·${it.slot + 1}`
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
                <SpoolDisc color={it.spool.color} color2={discColor2(it.spool)} size={44} fill={spoolFill(it.spool)} />
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
                {flow.mode !== "pick" && state.nodes.length > 1 && (
                  <select
                    value={it.nodeId}
                    onChange={(e) => reassignItemNode(it.spool.id, e.target.value)}
                    aria-label={`Storage unit for ${it.spool.material} ${it.spool.colorName}`}
                    className="mt-0.5 max-w-[104px] rounded-md border border-border bg-background px-1.5 py-1 text-[10px] text-foreground focus:border-primary focus:outline-none"
                  >
                    {state.nodes.map((n) => (
                      <option key={n.id} value={n.id} disabled={!nodeHasRoom(n.id, it.nodeId)}>
                        {n.name}
                      </option>
                    ))}
                  </select>
                )}
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
