"use client"

import { useState } from "react"
import { Play, X, Plus, ChevronDown, ChevronUp, ArrowDownToLine, ArrowUpFromLine } from "lucide-react"
import { useFlow, type QueueView, type PendingItem } from "./flow-controller"
import { useStore } from "@/lib/store"
import { Button } from "./ui/button"
import { SpoolDisc, discColor2 } from "./spool"
import { printerSlotLabel, getNode, shelfLabel, orderQueueItems, nodesForSystem } from "@/lib/selectors"
import { nodeFreeSlots } from "@/lib/balance"
import { isLightColor, spoolFill } from "@/lib/filament"
import { cn } from "@/lib/utils"

/**
 * Bottom sheet that appears while the user assembles queues. A toggle switches
 * between the Place-in and Take-out queues (both can hold items at once); on
 * Start the machine runs one whole queue at a time — take-out first, then
 * place-in.
 */
export function QueueTray({ onAddMore }: { onAddMore: (view: QueueView) => void }) {
  const { flow, inItems, outItems, view, setView, cancel, run, reassignItemNode } = useFlow()
  const { state } = useStore()
  // A spool can only be redirected into a FILAMENT unit. Hardware racks share the
  // same node list but must never be offered here — a spool queued into one would
  // then be driven to a hardware shelf at confirm time.
  const filamentNodes = nodesForSystem(state, "filament")
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

  if (!flow) return null

  // Always show the toggle's counts; the body renders whichever queue is active.
  const items = view === "in" ? inItems : outItems
  const bothActive = inItems.length > 0 && outItems.length > 0
  // A place-in queue made up only of spools coming off printers adds "another
  // store"; anything else (or an empty queue) adds a brand-new spool to place.
  const inStoreOnly = inItems.length > 0 && inItems.every((i) => i.printerId != null && !i.isNew && !i.from)
  const addLabel = view === "out" ? "Take out another" : inStoreOnly ? "Store another" : "Place another"

  return (
    <div className="fixed inset-x-0 bottom-14 z-40 mx-auto max-w-3xl px-4">
      <div className="rounded-2xl border border-primary/40 bg-card/95 p-4 shadow-2xl backdrop-blur">
        <div className={collapsed ? "flex items-center justify-between gap-2" : "mb-3 flex items-center justify-between gap-2"}>
          {/* Segmented toggle: Place in / Take out */}
          <div className="flex items-center gap-1 rounded-xl border border-border bg-background/60 p-1">
            <TabButton
              active={view === "in"}
              onClick={() => setView("in")}
              count={inItems.length}
              icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
              label="Place in"
            />
            <TabButton
              active={view === "out"}
              onClick={() => setView("out")}
              count={outItems.length}
              icon={<ArrowUpFromLine className="h-3.5 w-3.5" />}
              label="Take out"
            />
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand queue" : "Collapse queue"}
              className="rounded-md p-1.5 text-muted-foreground hover:text-primary"
            >
              {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive"
            >
              <X className="h-4 w-4" /> Cancel
            </button>
          </div>
        </div>

        {collapsed ? null : (
          <>
            {items.length === 0 ? (
              <p className="mb-4 rounded-xl border border-dashed border-border bg-background/40 px-3 py-6 text-center text-xs text-muted-foreground">
                {view === "in"
                  ? "No spools queued to place yet. Add one to store it in the system."
                  : "No spools queued to take out yet. Tap a stored spool to pick it."}
              </p>
            ) : (
              <ul className="mb-4 flex gap-2 overflow-x-auto scrollbar-thin pb-1">
                {orderQueueItems(items).map((it, i) => (
                  <QueueCard
                    key={it.spool.id}
                    it={it}
                    index={i}
                    view={view}
                    nodeHasRoom={nodeHasRoom}
                    reassignItemNode={reassignItemNode}
                    nodes={state.nodes}
                    destinationNodes={filamentNodes}
                    printers={state.printers}
                    getWhere={(item) => describeLocation(state, item)}
                  />
                ))}
              </ul>
            )}

            {bothActive && (
              <p className="mb-3 flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-[11px] text-primary">
                <Play className="h-3 w-3" />
                Runs the take-out queue first, then places the new spools.
              </p>
            )}

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => onAddMore(view)}>
                <Plus className="h-4 w-4" /> {addLabel}
              </Button>
              <Button className="flex-1" onClick={run}>
                <Play className="h-4 w-4" /> Start
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  count,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  count: number
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors",
        active ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
      <span
        className={cn(
          "rounded-md px-1.5 py-0.5 font-mono text-[10px]",
          active ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  )
}

/** Human-readable destination/source location for a queued item. */
function describeLocation(state: ReturnType<typeof useStore>["state"], it: PendingItem): string {
  const itemNode = getNode(state, it.nodeId)
  if (itemNode && (itemNode.type ?? "paternoster") === "library") return itemNode.name
  return `${itemNode ? shelfLabel(itemNode, it.shelf) : `Shelf ${it.shelf + 1}`}·${it.slot + 1}`
}

function QueueCard({
  it,
  index,
  view,
  nodeHasRoom,
  reassignItemNode,
  nodes,
  destinationNodes,
  printers,
  getWhere,
}: {
  it: PendingItem
  index: number
  view: QueueView
  nodeHasRoom: (nodeId: string, currentNodeId: string) => boolean
  reassignItemNode: (spoolId: string, nodeId: string) => void
  /** Every unit — used only to label where a moved spool is coming FROM. */
  nodes: ReturnType<typeof useStore>["state"]["nodes"]
  /** Units this spool may be redirected INTO (filament units only). */
  destinationNodes: ReturnType<typeof useStore>["state"]["nodes"]
  printers: ReturnType<typeof useStore>["state"]["printers"]
  getWhere: (it: PendingItem) => string
}) {
  const printer = it.printerId ? printers.find((p) => p.id === it.printerId) : undefined
  const where = getWhere(it)
  const fromNode = it.from ? nodes.find((n) => n.id === it.from!.nodeId) : undefined
  const fromWhere = it.from
    ? `${fromNode ? shelfLabel(fromNode, it.from.shelf) : `Shelf ${it.from.shelf + 1}`}·${it.from.slot + 1}`
    : null

  // Take-out reads "src → printer/hand"; place-in reads "→ dest" or "src → dest".
  const route =
    view === "out"
      ? `${where} → ${printer && it.printerSlot != null ? printerSlotLabel(printer, it.printerSlot) : "hand"}`
      : fromWhere
        ? `${fromWhere} → ${where}`
        : `→ ${where}`

  return (
    <li className="flex shrink-0 flex-col items-center gap-1 rounded-xl border border-border bg-background/50 p-2">
      <span className="font-mono text-[10px] text-muted-foreground">#{index + 1}</span>
      <SpoolDisc color={it.spool.color} color2={discColor2(it.spool)} size={44} fill={spoolFill(it.spool)} />
      <span
        className="text-[11px] font-semibold"
        style={{ color: isLightColor(it.spool.color) ? "#d4d4d8" : it.spool.color }}
      >
        {it.spool.material}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground">{route}</span>
      {view === "in" && destinationNodes.length > 1 && (
        <select
          value={it.nodeId}
          onChange={(e) => reassignItemNode(it.spool.id, e.target.value)}
          aria-label={`Storage unit for ${it.spool.material} ${it.spool.colorName}`}
          className="mt-0.5 max-w-[104px] rounded-md border border-border bg-background px-1.5 py-1 text-[10px] text-foreground focus:border-primary focus:outline-none"
        >
          {destinationNodes.map((n) => (
            <option key={n.id} value={n.id} disabled={!nodeHasRoom(n.id, it.nodeId)}>
              {n.name}
            </option>
          ))}
        </select>
      )}
    </li>
  )
}
