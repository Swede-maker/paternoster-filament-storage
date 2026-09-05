/**
 * Shared, framework-agnostic helpers for the printer-facing API.
 *
 * These operate on a plain `PersistedState`/`AppState` snapshot so they can be
 * used both server-side (the /api/printers routes reading the SQLite document)
 * and client-side (the dispense-queue runner resolving a request to a spool).
 * Keeping the slot-addressing + token logic here means the read endpoint and
 * the executor can never disagree about what "node + shelf + slot" points to.
 */

import type { AppState, PersistedState } from "./types"
import { shelfLabel, nodeSystem } from "./selectors"

/** A spool as exposed to an external printer UI. Slot is addressed by
 *  node + shelf + slot (all 0-based) to match PAX's internal model exactly. */
export interface ApiSpool {
  spoolId: string
  material: string
  brand: string
  /** Primary hex color, e.g. "#e11d2f". */
  color: string
  colorName: string
  /** Grams of filament remaining. */
  gramsRemaining: number
  /** Full-spool weight when new, or null when unknown. */
  capacity: number | null
  /** Storage location — unambiguous across multiple paternosters. */
  nodeId: string
  nodeName: string
  /** 0-based shelf index within the node. */
  shelf: number
  /** 0-based slot index within the shelf. */
  slot: number
  /** Human-readable shelf label, e.g. "Shelf 3". */
  shelfLabel: string
  /** Fully-qualified human location, e.g. "Paternoster 1 · Shelf 3 · Slot 2". */
  location: string
}

/** A state snapshot that carries enough to enumerate spools + check the token.
 *  Both AppState and PersistedState satisfy this. */
type StateLike = Pick<AppState, "nodes" | "spools"> & { apiToken?: string }

/**
 * Build the live list of filament spools available in every filament storage
 * node. Hardware nodes are skipped. Grams reflect current remaining weight.
 */
export function apiSpoolList(state: StateLike): ApiSpool[] {
  const out: ApiSpool[] = []
  for (const node of state.nodes) {
    if (nodeSystem(node) !== "filament") continue
    for (let shelf = 0; shelf < node.slots.length; shelf++) {
      const row = node.slots[shelf]
      for (let slot = 0; slot < row.length; slot++) {
        const id = row[slot]
        const spool = id ? state.spools[id] : null
        if (!id || !spool) continue
        const label = shelfLabel(node, shelf)
        out.push({
          spoolId: spool.id,
          material: spool.material,
          brand: spool.brand,
          color: spool.color,
          colorName: spool.colorName,
          gramsRemaining: Math.max(0, Math.round(spool.grams)),
          capacity: typeof spool.capacity === "number" ? spool.capacity : null,
          nodeId: node.id,
          nodeName: node.name,
          shelf,
          slot,
          shelfLabel: label,
          location: `${node.name} · ${label} · Slot ${slot + 1}`,
        })
      }
    }
  }
  return out
}

/** Resolve the spool id currently stored at a given node/shelf/slot, or null. */
export function spoolIdAt(state: StateLike, nodeId: string, shelf: number, slot: number): string | null {
  const node = state.nodes.find((n) => n.id === nodeId)
  if (!node) return null
  const row = node.slots[shelf]
  if (!row) return null
  return row[slot] ?? null
}

export interface SlotValidation {
  ok: boolean
  /** Populated when ok is false. */
  reason?: string
  /** The resolved spool id when ok is true. */
  spoolId?: string
}

/**
 * Validate a dispense target: the node must exist and be a filament unit, the
 * shelf/slot must be in range, and a spool must actually occupy the slot.
 */
export function validateDispenseTarget(
  state: StateLike,
  nodeId: string,
  shelf: number,
  slot: number,
): SlotValidation {
  const node = state.nodes.find((n) => n.id === nodeId)
  if (!node) return { ok: false, reason: `No storage unit with id "${nodeId}"` }
  if (nodeSystem(node) !== "filament") return { ok: false, reason: `Unit "${node.name}" is not a filament unit` }
  if (!Number.isInteger(shelf) || !Number.isInteger(slot)) return { ok: false, reason: "shelf and slot must be integers" }
  const row = node.slots[shelf]
  if (!row) return { ok: false, reason: `Shelf ${shelf} is out of range for "${node.name}"` }
  if (slot < 0 || slot >= row.length) return { ok: false, reason: `Slot ${slot} is out of range on shelf ${shelf}` }
  const spoolId = row[slot]
  if (!spoolId || !state.spools[spoolId]) return { ok: false, reason: "That slot is empty" }
  return { ok: true, spoolId }
}

/**
 * Enforce the optional shared token. When no token is configured the endpoints
 * are open on the trusted LAN; when one is set, callers must present it in the
 * `x-pax-token` header (or `?token=` query param).
 */
export function checkApiToken(configured: string | undefined, provided: string | null): boolean {
  if (!configured) return true
  return !!provided && provided === configured
}

/** Narrow a loaded document to the shape the helpers need. */
export function stateFromPersisted(data: PersistedState): StateLike {
  return { nodes: data.nodes, spools: data.spools, apiToken: data.apiToken }
}
