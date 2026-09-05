import type { AppState } from "./types"
import { bestSlotForNode, bestNodeSlot, containerWeight } from "./balance"
import { activeNode, nodeSystem, nodesForSystem } from "./selectors"

export interface SlotRef {
  nodeId: string
  shelf: number
  slot: number
}

/**
 * Choose where a stored/placed spool should go. When the caller names a
 * `preferredNodeId` (the unit the user explicitly picked), we place into that
 * unit using its own fill strategy — balanced for a paternoster, linear-from-slot-1
 * for a dumb shelf. If none is given we fall back to the active tab, and if the
 * chosen unit is full we spill over to the best slot across the other units.
 *
 * Filament ONLY: every candidate — preferred, active, or spill-over — must be a
 * filament unit. Hardware racks live in the same `state.nodes` list, and before
 * this guard a full filament unit could silently spill spools into one.
 *
 * `exclude` lists slots that must not be chosen: placements already queued in
 * this batch (so two spools never target one slot) and, for a re-pick, slots
 * the operator has already rejected as too tight for this spool.
 */
export function pickFilamentDestination(
  state: AppState,
  grams: number,
  exclude: SlotRef[],
  preferredNodeId?: string,
  containerId?: string,
): SlotRef | null {
  const containers = state.settings.containers ?? []
  // The spool being placed isn't in the grid yet, so fold its container's empty
  // weight into the search weight — the machine balances around the real mass
  // (filament + dry box), not just the filament.
  const weight = grams + containerWeight(containerId, containers)
  const filamentNodes = nodesForSystem(state, "filament")
  const preferred = preferredNodeId ? filamentNodes.find((n) => n.id === preferredNodeId) : undefined
  const active = activeNode(state)
  const node = preferred ?? (nodeSystem(active) === "filament" ? active : filamentNodes[0])
  if (!node) return null
  // A library only receives a spool when the user explicitly targets it. If it's
  // merely the active tab, auto-placement balances across the real storage pool
  // instead of dumping into the catalog.
  const canUseLocal = !!preferred || (node.type ?? "paternoster") !== "library"
  const localExclude = exclude.filter((r) => r.nodeId === node.id).map((r) => ({ shelf: r.shelf, slot: r.slot }))
  const local = canUseLocal ? bestSlotForNode(node, state.spools, weight, localExclude, containers) : null
  if (local) return { nodeId: node.id, shelf: local.shelf, slot: local.slot }
  return bestNodeSlot(filamentNodes, state.spools, weight, exclude, containers)
}
