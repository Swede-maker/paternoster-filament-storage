import type { AppState, HardwarePart, QueueItem, StorageNode } from "./types"
import type { Action } from "./store"
import { bestSlotForNode, bestNodeSlot, type BalanceOccupant } from "./balance"
import { getNode, nodesForSystem, orderQueueItems, partWeightGrams } from "./selectors"

type Dispatch = (action: Action) => void

/**
 * Present the hardware parts already in storage as balance occupants, so the
 * exact same carousel-balancing math used for filament can place a part box. A
 * box's mass is its piece count × per-piece weight.
 */
function partsOccupancy(state: AppState): Record<string, BalanceOccupant> {
  const out: Record<string, BalanceOccupant> = {}
  for (const [id, p] of Object.entries(state.parts ?? {})) {
    out[id] = { grams: partWeightGrams(p) }
  }
  return out
}

/**
 * Slots already claimed by an operation in flight (the active job's not-yet-done
 * stops plus every pending job). New placements reserve these so two queued
 * parts never target the same slot and the balance math spreads them out.
 */
function queuedReservations(state: AppState): { nodeId: string; shelf: number; slot: number }[] {
  const out: { nodeId: string; shelf: number; slot: number }[] = []
  const collect = (items: { nodeId: string; shelf: number; slot: number; done?: boolean }[]) => {
    for (const it of items) if (!it.done) out.push({ nodeId: it.nodeId, shelf: it.shelf, slot: it.slot })
  }
  if (state.job) collect(state.job.items.slice(state.job.currentIndex))
  for (const j of state.pendingJobs ?? []) collect(j.items)
  return out
}

/** Find the node/shelf/slot a part currently occupies within a hardware unit. */
export function findPartLocation(
  state: AppState,
  partId: string,
): { nodeId: string; shelf: number; slot: number } | null {
  for (const node of nodesForSystem(state, "hardware")) {
    for (let shelf = 0; shelf < node.slots.length; shelf++) {
      const row = node.slots[shelf] ?? []
      for (let slot = 0; slot < row.length; slot++) {
        if (row[slot] === partId) return { nodeId: node.id, shelf, slot }
      }
    }
  }
  return null
}

/**
 * Choose the best-balanced empty slot for a new part box: try the unit the user
 * picked first, then spill over to the best slot across all hardware units.
 * Returns null when every hardware unit is full.
 */
function pickHardwareSlot(
  state: AppState,
  weight: number,
  preferredNodeId?: string,
  reserved: { nodeId: string; shelf: number; slot: number }[] = [],
): { nodeId: string; shelf: number; slot: number } | null {
  const occ = partsOccupancy(state)
  const hwNodes = nodesForSystem(state, "hardware")
  const preferred = preferredNodeId ? getNode(state, preferredNodeId) : undefined
  const node: StorageNode | undefined = preferred ?? hwNodes[0]
  if (!node) return null
  const localReserved = reserved.filter((r) => r.nodeId === node.id).map((r) => ({ shelf: r.shelf, slot: r.slot }))
  const local = bestSlotForNode(node, occ, weight, localReserved)
  if (local) return { nodeId: node.id, shelf: local.shelf, slot: local.slot }
  // Chosen unit full → balance across the rest of the hardware pool.
  return bestNodeSlot(hwNodes, occ, weight, reserved)
}

/**
 * Register a brand-new part box and start a carousel job to place it into its
 * best-balanced slot. Returns false (and registers nothing) when storage is
 * full. The part is created first so the motion overlay can render it while the
 * unit rotates to the target slot.
 */
export function placeNewPart(
  state: AppState,
  dispatch: Dispatch,
  part: HardwarePart,
  preferredNodeId?: string,
  /**
   * Exact slot the user tapped. When given and that slot is genuinely empty
   * (and not already reserved by a queued job), the part goes there instead of
   * the auto-balanced pick — so tapping an empty box places right there.
   */
  target?: { nodeId: string; shelf: number; slot: number },
): boolean {
  // Reserve any slots already claimed by an in-flight placement so a part added
  // mid-operation lands in its own balanced slot instead of colliding.
  const reserved = queuedReservations(state)
  let dest = pickHardwareSlot(state, partWeightGrams(part), preferredNodeId, reserved)
  if (target) {
    const node = getNode(state, target.nodeId)
    const free = node && !node.slots[target.shelf]?.[target.slot]
    const taken = reserved.some(
      (r) => r.nodeId === target.nodeId && r.shelf === target.shelf && r.slot === target.slot,
    )
    if (free && !taken) dest = target
  }
  if (!dest) return false
  dispatch({ type: "UPSERT_PART", part })
  // ENQUEUE appends to the running place job (so the machine keeps its current
  // stop and adds this one behind it) or starts a fresh job when idle.
  dispatch({
    type: "ENQUEUE_JOB_ITEM",
    mode: "place",
    item: {
      spoolId: part.id,
      occupantKind: "part",
      nodeId: dest.nodeId,
      shelf: dest.shelf,
      slot: dest.slot,
      done: false,
    },
  })
  return true
}

/**
 * Start a carousel job that rotates to an existing part box so the user can add
 * `addCount` more pieces to it, applied on confirm. No-op if the part isn't in
 * storage.
 */
export function storeMorePart(state: AppState, dispatch: Dispatch, partId: string, addCount: number): boolean {
  const loc = findPartLocation(state, partId)
  if (!loc || addCount <= 0) return false
  dispatch({
    type: "START_JOBS",
    jobs: [
      {
        mode: "store",
        currentIndex: 0,
        items: [
          {
            spoolId: partId,
            occupantKind: "part",
            nodeId: loc.nodeId,
            shelf: loc.shelf,
            slot: loc.slot,
            partOp: { kind: "add", count: Math.floor(addCount) },
            done: false,
          },
        ],
      },
    ],
  })
  return true
}

/**
 * Start a carousel job that rotates to an existing part box so the user can take
 * `takeCount` pieces out, applied on confirm. A take that empties the box frees
 * its slot and deletes the part (handled by the HW_TAKE reducer).
 */
export function takeOutPart(state: AppState, dispatch: Dispatch, partId: string, takeCount: number): boolean {
  const loc = findPartLocation(state, partId)
  if (!loc || takeCount <= 0) return false
  dispatch({
    type: "START_JOBS",
    jobs: [
      {
        mode: "pick",
        currentIndex: 0,
        items: [
          {
            spoolId: partId,
            occupantKind: "part",
            nodeId: loc.nodeId,
            shelf: loc.shelf,
            slot: loc.slot,
            partOp: { kind: "take", count: Math.floor(takeCount) },
            done: false,
          },
        ],
      },
    ],
  })
  return true
}

/**
 * Start ONE take-out job that visits every queued part in turn. Unlike
 * {@link takeOutPart}, the quantity for each box is NOT known yet: it is entered
 * live at each stop (the motion overlay passes it to CONFIRM_STOP). Each item
 * carries `partOp.count: 0` as a placeholder. Stops are ordered by proximity
 * within each unit so the carousel takes the shortest route. Parts no longer in
 * storage are skipped; returns false if nothing runnable remains.
 */
export function takeOutParts(state: AppState, dispatch: Dispatch, partIds: string[]): boolean {
  const located = partIds
    .map((partId) => {
      const loc = findPartLocation(state, partId)
      return loc ? { partId, ...loc } : null
    })
    .filter((x): x is { partId: string; nodeId: string; shelf: number; slot: number } => x != null)
  if (located.length === 0) return false

  // Shortest-route ordering per motorized unit (matches the filament run()).
  const nodePos: Record<string, { currentShelf: number; shelves: number }> = {}
  for (const n of nodesForSystem(state, "hardware")) {
    if ((n.type ?? "paternoster") === "paternoster") {
      nodePos[n.id] = { currentShelf: n.machine.currentShelf, shelves: n.storage.shelves }
    }
  }

  const items: QueueItem[] = orderQueueItems(located, nodePos).map((it) => ({
    spoolId: it.partId,
    occupantKind: "part",
    nodeId: it.nodeId,
    shelf: it.shelf,
    slot: it.slot,
    partOp: { kind: "take", count: 0 },
    done: false,
  }))

  dispatch({ type: "START_JOBS", jobs: [{ mode: "pick", currentIndex: 0, items }] })
  return true
}
