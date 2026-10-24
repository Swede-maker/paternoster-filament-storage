import { orderRebalanceMoves, planRebalance, shelfDeviations, shelfWeights } from "./balance"
import type { ActiveJob, AppState, QueueItem, StorageNode } from "./types"

export const DEFAULT_BALANCE_THRESHOLD = 500

/** The balance-warning setting with defaults applied. */
export function balanceWarningSetting(state: AppState): { enabled: boolean; thresholdGrams: number } {
  const s = state.settings.balanceWarning
  return {
    enabled: s?.enabled ?? false,
    thresholdGrams: s && s.thresholdGrams > 0 ? s.thresholdGrams : DEFAULT_BALANCE_THRESHOLD,
  }
}

/** Per-shelf weight + deviation from the average for a node. */
export function nodeShelfBalance(state: AppState, node: StorageNode) {
  const weights = shelfWeights(node, state.spools, state.settings.containers ?? [])
  return { weights, deviations: shelfDeviations(weights) }
}

/**
 * Build the guided rebalance job for a paternoster: for each planned move, a
 * "take" stop at the spool's current slot followed directly by a "put" stop at
 * its new slot, ordered nearest-first from the carousel's current shelf.
 * Returns null when nothing would improve the balance.
 */
export function buildRebalanceJob(state: AppState, node: StorageNode): ActiveJob | null {
  const { thresholdGrams } = balanceWarningSetting(state)
  const moves = planRebalance(node, state.spools, state.settings.containers ?? [], thresholdGrams)
  if (moves.length === 0) return null
  const ordered = orderRebalanceMoves(moves, node.machine.currentShelf, node.slots.length)
  const items: QueueItem[] = ordered.flatMap((m) => [
    {
      spoolId: m.spoolId,
      nodeId: node.id,
      shelf: m.from.shelf,
      slot: m.from.slot,
      rebalanceStep: "take" as const,
      done: false,
    },
    {
      spoolId: m.spoolId,
      nodeId: node.id,
      shelf: m.to.shelf,
      slot: m.to.slot,
      from: { nodeId: node.id, shelf: m.from.shelf, slot: m.from.slot },
      rebalanceStep: "put" as const,
      done: false,
    },
  ])
  return { mode: "rebalance", items, currentIndex: 0 }
}
