import type { Container, Settings, Spool, StorageLocation, StorageNode } from "./types"

/**
 * The carousel is a vertical loop (paternoster). Each shelf sits at an angle
 * around the drive axis. Keeping the center of mass close to the axis keeps the
 * motor load balanced, so we model every shelf's angle and pick placements that
 * minimize the magnitude of the summed weight vector.
 *
 * All balance math is per-node: each paternoster unit balances itself.
 */

type Spools = Record<string, Spool>

/** Empty weight (g) of the container a spool sits in, or 0 for a bare spool. */
export function containerWeight(containerId: string | undefined, containers: Container[] = []): number {
  if (!containerId) return 0
  const c = containers.find((x) => x.id === containerId)
  return c && c.weightGrams > 0 ? c.weightGrams : 0
}

/**
 * The mass the carousel actually has to balance for a spool: its remaining
 * filament PLUS the empty weight of any storage container / dry box it sits in.
 * All balance math uses this instead of the bare `grams` so a heavy dry box is
 * accounted for when choosing the best-balanced slot.
 */
export function effectiveWeight(spool: Spool, containers: Container[] = []): number {
  return spool.grams + containerWeight(spool.containerId, containers)
}

function shelfAngle(shelf: number, shelves: number): number {
  return (shelf / shelves) * Math.PI * 2
}

/** Total grams stored on each shelf of a node (filament + container weight). */
export function shelfWeights(node: StorageNode, spools: Spools, containers: Container[] = []): number[] {
  const { shelves } = node.storage
  const weights = new Array(shelves).fill(0)
  for (let s = 0; s < shelves; s++) {
    const row = node.slots[s] ?? []
    for (const spoolId of row) {
      if (spoolId && spools[spoolId]) weights[s] += effectiveWeight(spools[spoolId], containers)
    }
  }
  return weights
}

/** Magnitude of the center-of-mass vector for a given per-shelf weight array. */
export function imbalance(weights: number[]): number {
  const shelves = weights.length
  let x = 0
  let y = 0
  for (let s = 0; s < shelves; s++) {
    const a = shelfAngle(s, shelves)
    x += weights[s] * Math.cos(a)
    y += weights[s] * Math.sin(a)
  }
  return Math.hypot(x, y)
}

/**
 * Normalized horizontal position of a slot within a shelf, from -1 (far left)
 * through 0 (center) to +1 (far right). Used to keep the machine balanced
 * left-to-right and to prefer center slots first.
 */
export function slotOffset(slot: number, slotsPerShelf: number): number {
  const half = (slotsPerShelf - 1) / 2
  if (half <= 0) return 0
  return (slot - half) / half
}

/** Summed left/right moment across every filled slot in the node (grams). */
export function lateralMoment(node: StorageNode, spools: Spools, containers: Container[] = []): number {
  let moment = 0
  for (let s = 0; s < node.slots.length; s++) {
    const row = node.slots[s] ?? []
    for (let slot = 0; slot < row.length; slot++) {
      const id = row[slot]
      if (id && spools[id]) moment += effectiveWeight(spools[id], containers) * slotOffset(slot, row.length)
    }
  }
  return moment
}

/** All empty storage locations in a node. */
export function emptyLocations(node: StorageNode): StorageLocation[] {
  const out: StorageLocation[] = []
  for (let s = 0; s < node.slots.length; s++) {
    const row = node.slots[s] ?? []
    for (let slot = 0; slot < row.length; slot++) {
      if (!row[slot]) out.push({ shelf: s, slot })
    }
  }
  return out
}

/** Total free slots across a node. */
export function nodeFreeSlots(node: StorageNode): number {
  return emptyLocations(node).length
}

/**
 * Choose the empty slot in a node that keeps it most balanced when adding a
 * spool of `grams`. Balance has two axes:
 *   - rotational: the summed weight vector around the drive axis (per shelf),
 *   - lateral: the summed left/right moment across the shelf width (per slot).
 * Among equally balanced options we prefer center slots first, then shelves
 * with fewer spools, so the machine fills center-out and stays even side-to-side.
 */
export function bestBalancedSlot(
  node: StorageNode,
  spools: Spools,
  grams: number,
  exclude: StorageLocation[] = [],
  containers: Container[] = [],
): StorageLocation | null {
  const rowLen = (shelf: number) => (node.slots[shelf] ?? []).length
  const candidates = emptyLocations(node).filter(
    (loc) => !exclude.some((e) => e.shelf === loc.shelf && e.slot === loc.slot),
  )
  if (candidates.length === 0) return null

  const baseWeights = shelfWeights(node, spools, containers)
  let baseLateral = lateralMoment(node, spools, containers)
  // Account for reserved (queued) placements so multiple picks spread out.
  for (const e of exclude) {
    baseWeights[e.shelf] += grams
    baseLateral += grams * slotOffset(e.slot, rowLen(e.shelf))
  }

  const shelfFill = baseWeights.map((_, s) => (node.slots[s] ?? []).filter(Boolean).length)

  let best: StorageLocation | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const loc of candidates) {
    const trial = [...baseWeights]
    trial[loc.shelf] += grams
    const off = slotOffset(loc.slot, rowLen(loc.shelf))
    const trialLateral = baseLateral + grams * off
    const score =
      imbalance(trial) +
      Math.abs(trialLateral) +
      Math.abs(off) * grams * 0.01 +
      shelfFill[loc.shelf] * 0.001
    if (score < bestScore - 1e-9) {
      bestScore = score
      best = loc
    }
  }
  return best
}

/**
 * First empty slot in a node scanning shelf-by-shelf, slot-by-slot (top-left to
 * bottom-right). Used for manual "dumb" shelf storage, which fills in order from
 * slot 1 upward rather than by any balance heuristic.
 */
export function firstEmptySlot(node: StorageNode, exclude: StorageLocation[] = []): StorageLocation | null {
  for (let s = 0; s < node.slots.length; s++) {
    const row = node.slots[s] ?? []
    for (let slot = 0; slot < row.length; slot++) {
      if (!row[slot] && !exclude.some((e) => e.shelf === s && e.slot === slot)) return { shelf: s, slot }
    }
  }
  return null
}

/**
 * Choose a slot for a node using the strategy that fits its type: paternosters
 * balance their load; manual shelf storage fills linearly from the first slot.
 */
export function bestSlotForNode(
  node: StorageNode,
  spools: Spools,
  grams: number,
  exclude: StorageLocation[] = [],
  containers: Container[] = [],
): StorageLocation | null {
  if ((node.type ?? "paternoster") === "shelf") return firstEmptySlot(node, exclude)
  return bestBalancedSlot(node, spools, grams, exclude, containers)
}

/**
 * Pick the best (node, slot) across a set of nodes for a new spool. Prefers the
 * node that ends up most balanced; ties break toward the emptier node so the
 * whole system fills evenly.
 */
export function bestNodeSlot(
  nodes: StorageNode[],
  spools: Spools,
  grams: number,
  reserved: { nodeId: string; shelf: number; slot: number }[] = [],
  containers: Container[] = [],
): { nodeId: string; shelf: number; slot: number } | null {
  let best: { nodeId: string; shelf: number; slot: number } | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    const exclude = reserved.filter((r) => r.nodeId === node.id).map((r) => ({ shelf: r.shelf, slot: r.slot }))
    const slot = bestSlotForNode(node, spools, grams, exclude, containers)
    if (!slot) continue
    // Score: resulting imbalance for the node, minus a small bonus for emptier
    // nodes so weight spreads across units.
    const weights = shelfWeights(node, spools, containers)
    weights[slot.shelf] += grams
    const totalSlots = node.slots.reduce((sum, row) => sum + row.length, 0)
    const fillPenalty = (totalSlots - nodeFreeSlots(node)) * 0.5
    const score = imbalance(weights) + fillPenalty
    if (score < bestScore - 1e-9) {
      bestScore = score
      best = { nodeId: node.id, shelf: slot.shelf, slot: slot.slot }
    }
  }
  return best
}

/**
 * Shortest rotation from `from` to `to` on a loop of `shelves` positions.
 * Returns the direction and number of steps. "up" moves toward higher indices.
 */
export function shortestRotation(
  from: number,
  to: number,
  shelves: number,
): { direction: "up" | "down"; steps: number } {
  if (from === to) return { direction: "up", steps: 0 }
  const up = (to - from + shelves) % shelves
  const down = (from - to + shelves) % shelves
  if (up <= down) return { direction: "up", steps: up }
  return { direction: "down", steps: down }
}
