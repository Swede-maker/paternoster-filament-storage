// RFID / QR tag helpers.
//
// A "tag" is identified by a stable string id:
//   - an NFC tag  → its hardware serial number (read-only, unique), or
//   - a printed QR → the `PAX:<uuid>` value encoded in the code.
//
// The binding (id → spool / shelf / printer slot) lives in
// `Settings.tagBindings`, so it syncs across every device. These helpers
// resolve and describe bindings and encode/parse the QR payload.

import type { AppState, Printer, Spool, StorageNode, TagBinding, TagTarget } from "./types"
import { printerSlotLabel, shelfLabel } from "./selectors"
import { newId } from "./filament"

/** Prefix identifying a v0/PAX QR payload, so we never confuse it with a random QR. */
export const QR_PREFIX = "PAX:"

/** Mint a fresh QR tag id (used when generating a printable code). */
export function newQrTagId(): string {
  return `${QR_PREFIX}${newId("tag")}`
}

/**
 * A short, human-readable form of a tag id for on-screen matching against a
 * printed label, e.g. `PAX:tag_9f3a2b7c` → `9F3A`. Uppercased and trimmed to the
 * last few identifying characters so it's quick to eyeball against a QR caption.
 */
export function shortTagId(id: string): string {
  const bare = id.startsWith(QR_PREFIX) ? id.slice(QR_PREFIX.length) : id
  const tail = bare.replace(/^tag[_-]?/i, "").replace(/[^A-Za-z0-9]/g, "")
  return (tail.slice(-4) || bare).toUpperCase()
}

/** The string encoded into a printable QR for a given tag id. */
export function qrPayload(id: string): string {
  // NFC serials aren't PAX-prefixed; a printed QR always carries the prefix so a
  // camera scan of it is recognised. If the id is already a PAX id, keep it.
  return id.startsWith(QR_PREFIX) ? id : `${QR_PREFIX}${id}`
}

/**
 * Normalise a raw scan (QR text, NFC serial, or manual entry) to a tag id.
 * Strips the `PAX:` prefix wrapper only for the *outer* transport — the stored
 * id keeps whatever form it was created with (a PAX id stays PAX-prefixed).
 */
export function parseScan(raw: string): string {
  const s = raw.trim()
  // A QR we generated is `PAX:PAX:tag_x` only if double-wrapped; qrPayload avoids
  // that. A normal PAX QR is `PAX:tag_x` → the id is `PAX:tag_x`. A bare NFC
  // serial has no prefix and is used as-is.
  return s
}

/** Find the binding for a tag id, if any. */
export function findBinding(state: AppState, id: string): TagBinding | undefined {
  return (state.settings.tagBindings ?? []).find((b) => b.id === id)
}

/** All bindings, newest first. */
export function allBindings(state: AppState): TagBinding[] {
  return [...(state.settings.tagBindings ?? [])].sort((a, b) => b.boundAt - a.boundAt)
}

export function getSpool(state: AppState, id: string): Spool | undefined {
  return state.spools[id]
}

export function getNode(state: AppState, id: string): StorageNode | undefined {
  return state.nodes.find((n) => n.id === id)
}

export function getPrinter(state: AppState, id: string): Printer | undefined {
  return state.printers.find((p) => p.id === id)
}

/** A human description of what a target points at (for cards + the manager). */
export interface TargetInfo {
  /** "spool" | "shelf" | "printerSlot" — the kind, echoed for convenience. */
  kind: TagTarget["kind"]
  /** Short kind label, e.g. "Spool", "Storage", "Printer". */
  typeLabel: string
  /** Primary line, e.g. the spool name or shelf label. */
  title: string
  /** Secondary line, e.g. the unit name or brand. */
  subtitle?: string
  /** False when the underlying spool/shelf/printer no longer exists (dangling). */
  valid: boolean
}

/** Describe a target for display; flags dangling bindings so the UI can warn. */
export function describeTarget(state: AppState, target: TagTarget): TargetInfo {
  switch (target.kind) {
    case "spool": {
      const spool = state.spools[target.spoolId]
      return {
        kind: "spool",
        typeLabel: "Spool",
        title: spool ? `${spool.material} · ${spool.colorName}` : "Missing spool",
        subtitle: spool?.brand,
        valid: !!spool,
      }
    }
    case "shelf": {
      const node = getNode(state, target.nodeId)
      const type = node?.type ?? "paternoster"
      const multiShelf = (node?.slots.length ?? 1) > 1 && type !== "library"
      return {
        kind: "shelf",
        typeLabel: "Storage",
        title: node ? (multiShelf ? shelfLabel(node, target.shelf) : node.name) : "Missing unit",
        subtitle: node ? (multiShelf ? node.name : type === "library" ? "Library" : "Shelf") : undefined,
        valid: !!node && (type === "library" || target.shelf < node.slots.length),
      }
    }
    case "printerSlot": {
      const printer = getPrinter(state, target.printerId)
      return {
        kind: "printerSlot",
        typeLabel: "Printer",
        title: printer ? printer.name : "Missing printer",
        subtitle: printer ? `Slot ${printerSlotLabel(printer, target.slot)}` : undefined,
        valid: !!printer && target.slot < printer.loaded.length,
      }
    }
  }
}

/** Which spool (if any) currently sits at a non-spool target. */
export function spoolAtTarget(state: AppState, target: TagTarget): Spool | undefined {
  if (target.kind === "spool") return state.spools[target.spoolId]
  if (target.kind === "shelf") return undefined // a shelf holds many; handled by the shelf view
  if (target.kind === "printerSlot") {
    const printer = getPrinter(state, target.printerId)
    const id = printer?.loaded[target.slot]
    return id ? state.spools[id] : undefined
  }
  return undefined
}

/** Find where a spool currently lives, for the "scan a spool" action hub. */
export type SpoolPlace =
  | { kind: "storage"; nodeId: string; shelf: number; slot: number }
  | { kind: "printer"; printerId: string; slot: number }
  | { kind: "none" }

export function locateSpool(state: AppState, spoolId: string): SpoolPlace {
  for (const node of state.nodes) {
    for (let shelf = 0; shelf < node.slots.length; shelf++) {
      const row = node.slots[shelf]
      for (let slot = 0; slot < row.length; slot++) {
        if (row[slot] === spoolId) return { kind: "storage", nodeId: node.id, shelf, slot }
      }
    }
  }
  for (const printer of state.printers) {
    const slot = printer.loaded.indexOf(spoolId)
    if (slot >= 0) return { kind: "printer", printerId: printer.id, slot }
  }
  return { kind: "none" }
}
