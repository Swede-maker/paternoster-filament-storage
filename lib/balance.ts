import type { Container, Settings, StorageLocation, StorageNode } from "./types"

/**
 * The minimal shape the balance engine needs from whatever lives in a slot. Both
 * a filament {@link Spool} and a hardware part-box (its total weight =
 * count × per-piece grams) satisfy this, so the exact same placement math serves
 * both areas — a "20 bolts × 3g = 60g" box is balanced like a 60g spool.
 */
export interface BalanceOccupant {
  grams: number
  containerId?: string
}

/**
 * The carousel is a vertical loop (paternoster). Each shelf sits at an angle
 * around the drive axis. Keeping the center of mass close to the axis keeps the
 * motor load balanced, so we model every shelf's angle and pick placements that
 * minimize the magnitude of the summed weight vector.
 *
 * All balance math is per-node: each paternoster unit balances itself.
 */

type Spools = Record<string, BalanceOccupant>

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
export function effectiveWeight(spool: BalanceOccupant, containers: Container[] = []): number {
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
 * Root-mean-square distance of every shelf from the average shelf weight
 * (grams). This is the same quantity the per-shelf balance warning and the
 * Rebalance planner judge, so placement minimizes it too — otherwise a queue of
 * new spools could land in a layout the Rebalance button immediately wants to
 * change.
 */
export function shelfSpread(weights: number[]): number {
  if (weights.length === 0) return 0
  const mean = weights.reduce((a, b) => a + b, 0) / weights.length
  const sumSq = weights.reduce((sum, w) => sum + (w - mean) * (w - mean), 0)
  return Math.sqrt(sumSq / weights.length)
}

/**
 * Weight given to the per-shelf spread in placement scores. It must dominate
 * the rotational term so spools fill the lightest shelves first (one per shelf
 * before doubling up), matching what the Rebalance planner aims for.
 */
const SPREAD_WEIGHT = 3

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
      shelfSpread(trial) * SPREAD_WEIGHT +
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
  const type = node.type ?? "paternoster"
  // A library is an unbounded single row, so a placement always appends to the
  // end. Each already-queued placement (`exclude`) also appends, so offset past
  // them to keep queued slot indices distinct.
  if (type === "library") {
    const base = node.slots[0]?.length ?? 0
    return { shelf: 0, slot: base + exclude.length }
  }
  if (type === "shelf") return firstEmptySlot(node, exclude)
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
    // A library is a manual catalog with no balancing role, so auto-placement
    // (find-best-slot across the pool) never spills into it — spools only enter
    // a library when the user explicitly targets it.
    if ((node.type ?? "paternoster") === "library") continue
    const exclude = reserved.filter((r) => r.nodeId === node.id).map((r) => ({ shelf: r.shelf, slot: r.slot }))
    const slot = bestSlotForNode(node, spools, grams, exclude, containers)
    if (!slot) continue
    // Score: resulting imbalance for the node, minus a small bonus for emptier
    // nodes so weight spreads across units.
    const weights = shelfWeights(node, spools, containers)
    for (const r of exclude) weights[r.shelf] += grams
    weights[slot.shelf] += grams
    const totalSlots = node.slots.reduce((sum, row) => sum + row.length, 0)
    const fillPenalty = (totalSlots - nodeFreeSlots(node)) * 0.5
    const score = shelfSpread(weights) * SPREAD_WEIGHT + imbalance(weights) + fillPenalty
    if (score < bestScore - 1e-9) {
      bestScore = score
      best = { nodeId: node.id, shelf: slot.shelf, slot: slot.slot }
    }
  }
  return best
}

/**
 * How far each shelf sits from the unit's average shelf weight (grams). Positive
 * = heavier than average, negative = lighter. A perfectly even carousel is all
 * zeros, which is also the zero-torque condition for a paternoster loop.
 */
export function shelfDeviations(weights: number[]): number[] {
  if (weights.length === 0) return []
  const mean = weights.reduce((a, b) => a + b, 0) / weights.length
  return weights.map((w) => w - mean)
}

/** One planned relocation inside a node. */
export interface RebalanceMove {
  spoolId: string
  from: StorageLocation
  to: StorageLocation
}

function loopDistance(from: number, to: number, shelves: number): number {
  if (shelves <= 0) return 0
  const d = (((to - from) % shelves) + shelves) % shelves
  return Math.min(d, shelves - d)
}

/**
 * Plan a set of spool relocations that brings every shelf of a paternoster
 * within `thresholdGrams` of the average shelf weight, using as few moves as a
 * greedy search finds.
 *
 * Each step tries every (stored spool → empty slot) move and keeps the one that
 * most reduces the spread of shelf weights (plus the left/right moment). It
 * stops once no shelf is outside the threshold, no move helps meaningfully, or
 * `maxMoves` is reached.
 *
 * Destinations are always slots that are empty BEFORE the plan starts, and each
 * spool moves at most once. That keeps every move independent of the others, so
 * the queue can be run in any order (nearest-first) without a spool ever being
 * sent to a slot that is still occupied.
 */
export function planRebalance(
  node: StorageNode,
  spools: Spools,
  containers: Container[] = [],
  thresholdGrams: number,
  maxMoves = 20,
): RebalanceMove[] {
  const shelves = node.slots.length
  if (shelves < 2) return []
  const weights = shelfWeights(node, spools, containers)
  let lateral = lateralMoment(node, spools, containers)
  const rowLen = (s: number) => (node.slots[s] ?? []).length

  const freeSlots = emptyLocations(node)
  const usedDest = new Set<string>()
  const movedSpools = new Set<string>()
  const key = (l: StorageLocation) => `${l.shelf}:${l.slot}`

  const stored: { spoolId: string; loc: StorageLocation; grams: number }[] = []
  for (let s = 0; s < shelves; s++) {
    const row = node.slots[s] ?? []
    for (let slot = 0; slot < row.length; slot++) {
      const id = row[slot]
      if (id && spools[id]) stored.push({ spoolId: id, loc: { shelf: s, slot }, grams: effectiveWeight(spools[id], containers) })
    }
  }

  const score = (w: number[], lat: number) => {
    const dev = shelfDeviations(w)
    return dev.reduce((sum, d) => sum + d * d, 0) + lat * lat
  }
  const outOfBalance = (w: number[]) => shelfDeviations(w).some((d) => Math.abs(d) > thresholdGrams)

  const moves: RebalanceMove[] = []
  while (moves.length < maxMoves && outOfBalance(weights)) {
    const current = score(weights, lateral)
    let best: { idx: number; to: StorageLocation; score: number; lat: number } | null = null
    for (let i = 0; i < stored.length; i++) {
      const sp = stored[i]
      if (movedSpools.has(sp.spoolId) || sp.grams <= 0) continue
      for (const to of freeSlots) {
        if (usedDest.has(key(to)) || to.shelf === sp.loc.shelf) continue
        weights[sp.loc.shelf] -= sp.grams
        weights[to.shelf] += sp.grams
        const lat =
          lateral - sp.grams * slotOffset(sp.loc.slot, rowLen(sp.loc.shelf)) + sp.grams * slotOffset(to.slot, rowLen(to.shelf))
        const sc = score(weights, lat)
        weights[sp.loc.shelf] += sp.grams
        weights[to.shelf] -= sp.grams
        if (!best || sc < best.score - 1e-6) best = { idx: i, to, score: sc, lat }
      }
    }
    // Require a real improvement (≥1%) so the plan never shuffles spools for
    // a few grams of difference.
    if (!best || best.score > current * 0.99) break
    const sp = stored[best.idx]
    weights[sp.loc.shelf] -= sp.grams
    weights[best.to.shelf] += sp.grams
    lateral = best.lat
    movedSpools.add(sp.spoolId)
    usedDest.add(key(best.to))
    moves.push({ spoolId: sp.spoolId, from: sp.loc, to: best.to })
  }
  return moves
}

/**
 * Order rebalance moves so the carousel travels as little as possible: from
 * where it is now, go to the nearest spool to pick, then to its destination,
 * then from there to the next-nearest spool, and so on.
 */
export function orderRebalanceMoves(moves: RebalanceMove[], startShelf: number, shelves: number): RebalanceMove[] {
  const remaining = [...moves]
  const ordered: RebalanceMove[] = []
  let pos = startShelf
  while (remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Number.POSITIVE_INFINITY
    remaining.forEach((m, i) => {
      const d = loopDistance(pos, m.from.shelf, shelves)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    })
    const [m] = remaining.splice(bestIdx, 1)
    ordered.push(m)
    pos = m.to.shelf
  }
  return ordered
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
