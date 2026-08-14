import type { AppState, NodeType, Spool, StorageLocation, StorageNode } from "./types"

export interface Stats {
  totalSlots: number
  usedSlots: number
  emptySlots: number
  totalGrams: number
}

/** Total physical slots in a node (sums the actual per-shelf row lengths, so
 *  jagged shelf layouts are counted correctly). */
export function nodeSlotCount(node: StorageNode): number {
  return node.slots.reduce((sum, row) => sum + row.length, 0)
}

/** Display label for a shelf: its custom name, or "Shelf N" when unnamed. */
export function shelfLabel(node: StorageNode, shelf: number): string {
  return node.shelfMeta?.[shelf]?.name?.trim() || `Shelf ${shelf + 1}`
}

/** The physical area for a shelf: its own area, falling back to the node area. */
export function shelfArea(node: StorageNode, shelf: number): string | undefined {
  return node.shelfMeta?.[shelf]?.area?.trim() || node.area?.trim() || undefined
}

/** A stored spool together with the node + location it sits in. */
export interface StoredEntry {
  spool: Spool
  nodeId: string
  nodeName: string
  nodeType: NodeType
  /** Physical area of the shelf it's on (falls back to the node area). */
  area?: string
  /** Display name of the shelf (custom name or "Shelf N"). */
  shelfName: string
  loc: StorageLocation
}

/** Current carousel position + shelf count for a node, to route by proximity. */
export interface NodePosition {
  currentShelf: number
  shelves: number
}

/** Steps between two shelves on the loop, taking the shorter direction. */
function loopSteps(from: number, to: number, shelves: number): number {
  if (shelves <= 0) return 0
  const up = (((to - from) % shelves) + shelves) % shelves
  return Math.min(up, shelves - up)
}

/**
 * Order one node's items as a nearest-first route from `start`: repeatedly go to
 * whichever remaining item is closest to the current position (fewest shelves of
 * travel), so the carousel never rotates past a queued shelf only to come back
 * for it. Ties break toward the lower slot, then original insertion order.
 */
function nearestRoute<T extends { shelf: number; slot: number }>(
  group: { item: T; index: number }[],
  start: number,
  shelves: number,
): T[] {
  const remaining = [...group]
  const route: T[] = []
  let cur = start
  while (remaining.length > 0) {
    let bestI = 0
    let best = remaining[0]
    let bestDist = loopSteps(cur, best.item.shelf, shelves)
    for (let i = 1; i < remaining.length; i++) {
      const cand = remaining[i]
      const dist = loopSteps(cur, cand.item.shelf, shelves)
      const better =
        dist < bestDist ||
        (dist === bestDist &&
          (cand.item.slot < best.item.slot ||
            (cand.item.slot === best.item.slot && cand.index < best.index)))
      if (better) {
        best = cand
        bestDist = dist
        bestI = i
      }
    }
    remaining.splice(bestI, 1)
    route.push(best.item)
    cur = best.item.shelf
  }
  return route
}

/**
 * Order a queue of pick/store/place items so the user finishes one storage unit
 * before moving to the next — never hopping back and forth between locations.
 *
 * Nodes keep the order they first appear in the queue (so the unit you started
 * with stays first). Within each node, when the carousel's current position is
 * known (`nodePos`), items are ordered as a nearest-first route from where the
 * carousel already is, minimizing rotation. Without a position we fall back to a
 * stable shelf-then-slot order.
 */
export function orderQueueItems<T extends { nodeId: string; shelf: number; slot: number }>(
  items: T[],
  nodePos?: Record<string, NodePosition>,
): T[] {
  const nodeOrder: string[] = []
  const byNode = new Map<string, { item: T; index: number }[]>()
  items.forEach((item, index) => {
    if (!nodeOrder.includes(item.nodeId)) nodeOrder.push(item.nodeId)
    const group = byNode.get(item.nodeId) ?? []
    group.push({ item, index })
    byNode.set(item.nodeId, group)
  })

  const out: T[] = []
  for (const nodeId of nodeOrder) {
    const group = byNode.get(nodeId)!
    const pos = nodePos?.[nodeId]
    if (pos) {
      out.push(...nearestRoute(group, pos.currentShelf, pos.shelves))
    } else {
      const sorted = [...group].sort((a, b) => {
        if (a.item.shelf !== b.item.shelf) return a.item.shelf - b.item.shelf
        if (a.item.slot !== b.item.slot) return a.item.slot - b.item.slot
        return a.index - b.index
      })
      out.push(...sorted.map((e) => e.item))
    }
  }
  return out
}

/** The node the storage UI is currently focused on (falls back to the first). */
export function activeNode(state: AppState): StorageNode {
  return state.nodes.find((n) => n.id === state.activeNodeId) ?? state.nodes[0]
}

export function getNode(state: AppState, nodeId: string): StorageNode | undefined {
  return state.nodes.find((n) => n.id === nodeId)
}

export function masterNode(state: AppState): StorageNode {
  return state.nodes.find((n) => n.role === "master") ?? state.nodes[0]
}

/** Aggregate stats across every linked node (the whole storage pool). */
export function getStats(state: AppState): Stats {
  let totalSlots = 0
  let usedSlots = 0
  let totalGrams = 0
  for (const node of state.nodes) {
    totalSlots += nodeSlotCount(node)
    for (const row of node.slots) {
      for (const spoolId of row) {
        if (spoolId) {
          usedSlots++
          totalGrams += state.spools[spoolId]?.grams ?? 0
        }
      }
    }
  }
  return { totalSlots, usedSlots, emptySlots: totalSlots - usedSlots, totalGrams }
}

/** Stats for a single node. */
export function getNodeStats(state: AppState, node: StorageNode): Stats {
  const totalSlots = nodeSlotCount(node)
  let usedSlots = 0
  let totalGrams = 0
  for (const row of node.slots) {
    for (const spoolId of row) {
      if (spoolId) {
        usedSlots++
        totalGrams += state.spools[spoolId]?.grams ?? 0
      }
    }
  }
  return { totalSlots, usedSlots, emptySlots: totalSlots - usedSlots, totalGrams }
}

/** Every spool currently sitting in storage across ALL nodes. */
export function storedSpools(state: AppState): StoredEntry[] {
  const out: StoredEntry[] = []
  for (const node of state.nodes) {
    for (let shelf = 0; shelf < node.slots.length; shelf++) {
      const row = node.slots[shelf]
      for (let slot = 0; slot < row.length; slot++) {
        const id = row[slot]
        if (id && state.spools[id]) {
          out.push({
            spool: state.spools[id],
            nodeId: node.id,
            nodeName: node.name,
            nodeType: node.type ?? "paternoster",
            area: shelfArea(node, shelf),
            shelfName: shelfLabel(node, shelf),
            loc: { shelf, slot },
          })
        }
      }
    }
  }
  return out
}

export function searchSpools(entries: StoredEntry[], query: string): StoredEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter(({ spool, nodeName, shelfName, area, loc }) => {
    const haystack = [
      spool.material,
      spool.brand,
      spool.colorName,
      spool.color,
      nodeName,
      shelfName,
      area ?? "",
      `shelf ${loc.shelf + 1}`,
      `slot ${loc.slot + 1}`,
    ]
      .join(" ")
      .toLowerCase()
    return haystack.includes(q)
  })
}

export function activePrinter(state: AppState) {
  return state.printers.find((p) => p.id === state.activePrinterId) ?? null
}

/** Human-readable label for a printer slot index (AMS unit/slot or tool number). */
export function printerSlotLabel(
  printer: { kind: string; slotsPerAms: number; amsUnits: number; toolheads: number },
  index: number,
): string {
  if (printer.kind === "single") return "Spool"
  if (printer.kind === "toolchanger") return `T${index + 1}`
  const unit = Math.floor(index / printer.slotsPerAms) + 1
  const slot = (index % printer.slotsPerAms) + 1
  return `${unit}-${slot}`
}

// ---------------------------------------------------------------------------
// Dry reminders
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

/** When a spool's dry reminder becomes due (ms epoch), or null if none set. */
export function reminderDueAt(spool: Spool): number | null {
  if (!spool.dryReminder) return null
  return spool.dryReminder.setAt + spool.dryReminder.days * DAY_MS
}

/** Whether a spool's dry reminder is currently due (overdue to dry). */
export function isReminderDue(spool: Spool, now: number = Date.now()): boolean {
  const due = reminderDueAt(spool)
  return due !== null && now >= due
}

/** Every spool whose dry reminder is due right now, most overdue first. */
export function dueReminders(state: AppState, now: number = Date.now()): Spool[] {
  return Object.values(state.spools)
    .filter((s) => isReminderDue(s, now))
    .sort((a, b) => (reminderDueAt(a) ?? 0) - (reminderDueAt(b) ?? 0))
}
