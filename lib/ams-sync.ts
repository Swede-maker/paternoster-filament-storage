import type { BambuAmsTray } from "./bambu"
import type { Printer, Spool } from "./types"
import { densityFor, newId, type MaterialDefaults } from "./filament"

/**
 * Reconcile what the app thinks is loaded in a Bambu AMS with what the printer
 * actually reports. Pure: returns ordered operations + a human-readable report,
 * the caller dispatches them.
 *
 * Rules:
 * - RFID (Bambu) spools are tracked by tag uid: a known tag is re-seated (even if
 *   it moved slot/AMS or was in storage); an unknown tag creates a new spool.
 *   A slot whose app spool carries a *different* tag is a certain swap.
 * - When the app's spool has no tag and doesn't match what the printer reports
 *   (material or color differs), it may be the same spool set up differently in
 *   Bambu. Those slots are returned as `conflicts` for the user to decide.
 * - Untagged spools swapped between slots of this AMS are re-seated, not duplicated.
 */

export type AmsSyncOp =
  | { kind: "clear"; slot: number }
  | { kind: "seat"; slot: number; spoolId: string }
  | { kind: "ingest"; slot: number; spool: Spool }
  | { kind: "update"; id: string; changes: Partial<Spool> }
  | { kind: "toHand"; id: string }

export type AmsSyncEntry = {
  kind: "created" | "relinked" | "moved" | "updated" | "toHand" | "kept"
  slotLabel: string
  label: string
  color: string
  detail?: string
}

/** A slot where the app and the printer disagree and the user must decide. */
export type AmsSyncConflict = {
  slot: number
  slotLabel: string
  tray: BambuAmsTray
  current: Spool
  /** What the printer reports, as it would be created. */
  reported: { material: string; color: string; colorName: string; grams: number; capacity: number; weightKnown: boolean }
}

export type AmsConflictChoice = "keep" | "update" | "replace"

export type AmsSyncPlan = { ops: AmsSyncOp[]; entries: AmsSyncEntry[]; conflicts: AmsSyncConflict[] }

type Options = {
  /** Background mode: only act on RFID-tagged trays and never guess or ask. */
  rfidOnly?: boolean
  materialDefaults?: MaterialDefaults
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim())
  if (!m) return null
  const n = Number.parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function colorDistance(a: string, b: string): number {
  const ra = hexToRgb(a)
  const rb = hexToRgb(b)
  if (!ra || !rb) return Number.POSITIVE_INFINITY
  return Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2])
}

/** Nearest common color name for a hex, e.g. "#FFE133" → "Yellow". */
export function nearestColorName(hex: string | undefined): string {
  const rgb = hex ? hexToRgb(hex) : null
  if (!rgb) return "Unknown"
  const [r, g, b] = rgb.map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  // Hue-based naming reads pastels correctly (pink isn't "silver"), which a
  // plain nearest-RGB match against the presets gets wrong.
  if (s < 0.15 || d < 0.08) {
    if (l < 0.18) return "Black"
    if (l > 0.88) return "White"
    return l > 0.6 ? "Silver" : "Gray"
  }
  let h = 0
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = (h * 60 + 360) % 360
  if (h < 15 || h >= 345) return l > 0.7 ? "Pink" : "Red"
  if (h < 40) return l < 0.35 ? "Brown" : "Orange"
  if (h < 50) return l < 0.45 ? "Gold" : "Orange"
  if (h < 70) return l < 0.4 ? "Olive" : "Yellow"
  if (h < 160) return "Green"
  if (h < 185) return "Teal"
  if (h < 205) return "Sky"
  if (h < 250) return "Blue"
  if (h < 285) return "Purple"
  if (h < 320) return "Magenta"
  return "Pink"
}

// Close shades (e.g. Peach vs Apricot) count as the same spool. A different
// material, or a clearly different color, becomes a question for the user.
const SAME_SLOT_COLOR_DISTANCE = 70
const SWAP_COLOR_DISTANCE = 70

function sameMaterial(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")
  return norm(a) === norm(b)
}

/** Fingerprint of a tray's setup, remembered when the user confirms "same spool". */
export function trayKey(tray: BambuAmsTray) {
  return `${(tray.material ?? "").toUpperCase()}|${(tray.color ?? "").toUpperCase()}`
}

function matchesTray(spool: Spool, tray: BambuAmsTray, maxDistance = SAME_SLOT_COLOR_DISTANCE) {
  if (spool.amsAck && spool.amsAck === trayKey(tray)) return true
  if (!sameMaterial(spool.material, tray.material)) return false
  if (!tray.color) return true
  return colorDistance(spool.color, tray.color) <= maxDistance
}

/** Bambu reports `remain: -1` for spools it can't measure. */
function knownRemain(tray: BambuAmsTray): number | null {
  return typeof tray.remainPct === "number" && tray.remainPct >= 0 ? tray.remainPct : null
}

function capacityOf(spool: Spool | null, tray: BambuAmsTray) {
  if (spool?.capacity && spool.capacity > 0) return spool.capacity
  if (tray.capacityG && tray.capacityG > 0) return tray.capacityG
  return 1000
}

export function spoolLabel(s: Pick<Spool, "colorName" | "material">) {
  return `${s.colorName} ${s.material}`.trim()
}

function slotLabelFor(trays: BambuAmsTray[]) {
  const multiUnit = new Set(trays.map((t) => t.amsIndex)).size > 1
  return (t: BambuAmsTray) => (multiUnit ? `AMS ${t.amsIndex + 1} · slot ${t.trayIndex + 1}` : `Slot ${t.trayIndex + 1}`)
}

function newSpoolFromTray(tray: BambuAmsTray, opts: Options): Spool {
  const remain = knownRemain(tray)
  const material = tray.material || "PLA"
  const capacity = tray.capacityG && tray.capacityG > 0 ? tray.capacityG : 1000
  return {
    id: newId("spool"),
    material,
    brand: tray.rfid ? "Bambu Lab" : "Generic",
    color: tray.color || "#8b5cf6",
    colorName: nearestColorName(tray.color),
    grams: Math.round(((remain ?? 100) / 100) * capacity),
    capacity,
    density: densityFor(material, opts.materialDefaults),
    createdAt: Date.now(),
    ...(tray.rfid ? { rfidUid: tray.rfid } : {}),
  }
}

function createdEntry(spool: Spool, tray: BambuAmsTray, slotLabel: string): AmsSyncEntry {
  return {
    kind: "created",
    slotLabel,
    label: spoolLabel(spool),
    color: spool.color,
    detail: `${spool.grams} / ${spool.capacity} g${knownRemain(tray) === null ? " (weight unknown, assumed full)" : ""}`,
  }
}

const OP_RANK: Record<AmsSyncOp["kind"], number> = { clear: 0, update: 1, seat: 2, ingest: 3, toHand: 4 }

/** Clears first so seats/ingests land on vacated slots; hand moves last. */
export function sortOps(ops: AmsSyncOp[]) {
  return [...ops].sort((a, b) => OP_RANK[a.kind] - OP_RANK[b.kind])
}

export function planAmsSync(
  printer: Printer,
  trays: BambuAmsTray[],
  spools: Record<string, Spool>,
  opts: Options = {},
): AmsSyncPlan {
  const ops: AmsSyncOp[] = []
  const entries: AmsSyncEntry[] = []
  const conflicts: AmsSyncConflict[] = []
  const slotLabel = slotLabelFor(trays)

  const reported = trays.filter((t) => t.globalIndex >= 0 && t.globalIndex < printer.loaded.length)
  const trayTags = new Set(reported.filter((t) => t.present && t.rfid).map((t) => t.rfid!))
  const byTag = new Map<string, Spool>()
  for (const s of Object.values(spools)) if (s.rfidUid) byTag.set(s.rfidUid, s)

  // Spools leaving their slot; re-seated elsewhere in pass 2 or sent to the hand.
  const pool = new Map<string, { spool: Spool; tray: BambuAmsTray; reason: string }>()
  const needs: BambuAmsTray[] = []

  const free = (spool: Spool, tray: BambuAmsTray, reason: string) => {
    ops.push({ kind: "clear", slot: tray.globalIndex })
    // A tag still seen in another tray is re-seated by its own ingest.
    if (spool.rfidUid && trayTags.has(spool.rfidUid)) return
    pool.set(spool.id, { spool, tray, reason })
  }

  const conflict = (tray: BambuAmsTray, current: Spool) => {
    const remain = knownRemain(tray)
    const capacity = tray.capacityG && tray.capacityG > 0 ? tray.capacityG : 1000
    conflicts.push({
      slot: tray.globalIndex,
      slotLabel: slotLabel(tray),
      tray,
      current,
      reported: {
        material: tray.material || "PLA",
        color: tray.color || "#8b5cf6",
        colorName: nearestColorName(tray.color),
        grams: Math.round(((remain ?? 100) / 100) * capacity),
        capacity,
        weightKnown: remain !== null,
      },
    })
  }

  const refreshGrams = (spool: Spool, tray: BambuAmsTray) => {
    const remain = knownRemain(tray)
    if (remain === null) return
    const grams = Math.round((remain / 100) * capacityOf(spool, tray))
    if (Math.abs(grams - spool.grams) >= 1) ops.push({ kind: "update", id: spool.id, changes: { grams } })
  }

  // Pass 1: decide per slot whether the current spool stays.
  for (const tray of reported) {
    const currentId = printer.loaded[tray.globalIndex]
    const current = currentId ? spools[currentId] ?? null : null

    if (!tray.present) {
      if (current && !opts.rfidOnly) free(current, tray, `${slotLabel(tray)} is empty in the AMS`)
      continue
    }
    if (opts.rfidOnly && !tray.rfid) continue

    if (tray.rfid) {
      if (current?.rfidUid === tray.rfid) {
        refreshGrams(current, tray)
        continue
      }
      const knownElsewhere = byTag.has(tray.rfid)
      if (current && !current.rfidUid && !knownElsewhere) {
        if (matchesTray(current, tray)) {
          const changes: Partial<Spool> = { rfidUid: tray.rfid }
          const remain = knownRemain(tray)
          if (remain !== null) changes.grams = Math.round((remain / 100) * capacityOf(current, tray))
          ops.push({ kind: "update", id: current.id, changes })
          entries.push({
            kind: "updated",
            slotLabel: slotLabel(tray),
            label: spoolLabel(current),
            color: current.color,
            detail: "Linked to its RFID tag",
          })
        } else if (!opts.rfidOnly) {
          conflict(tray, current)
        }
        // Background mode leaves the mismatch for a manual Sync to ask about.
        continue
      }
      if (current) free(current, tray, `Replaced in ${slotLabel(tray)}`)
      needs.push(tray)
      continue
    }

    if (!tray.material) continue
    if (current && matchesTray(current, tray)) {
      refreshGrams(current, tray)
      continue
    }
    if (current && !current.rfidUid) {
      conflict(tray, current)
      continue
    }
    if (current) free(current, tray, `Replaced in ${slotLabel(tray)}`)
    needs.push(tray)
  }

  // Pass 2: fill slots that need a spool.
  for (const tray of needs) {
    const remain = knownRemain(tray)
    const known = tray.rfid ? byTag.get(tray.rfid) : undefined
    if (known) {
      const grams = remain !== null ? Math.round((remain / 100) * capacityOf(known, tray)) : known.grams
      ops.push({ kind: "ingest", slot: tray.globalIndex, spool: { ...known, grams } })
      const wasHere = printer.loaded.includes(known.id)
      entries.push({
        kind: "relinked",
        slotLabel: slotLabel(tray),
        label: spoolLabel(known),
        color: known.color,
        detail: wasHere ? "Moved to this slot (RFID)" : "Recognised by RFID and placed here",
      })
      continue
    }

    if (!tray.rfid) {
      const swapped = [...pool.values()].find(
        (p) => !p.spool.rfidUid && matchesTray(p.spool, tray, SWAP_COLOR_DISTANCE),
      )
      if (swapped) {
        pool.delete(swapped.spool.id)
        ops.push({ kind: "seat", slot: tray.globalIndex, spoolId: swapped.spool.id })
        entries.push({
          kind: "moved",
          slotLabel: slotLabel(tray),
          label: spoolLabel(swapped.spool),
          color: swapped.spool.color,
          detail: `Moved from ${slotLabel(swapped.tray)}`,
        })
        continue
      }
    }

    const spool = newSpoolFromTray(tray, opts)
    ops.push({ kind: "ingest", slot: tray.globalIndex, spool })
    entries.push(createdEntry(spool, tray, slotLabel(tray)))
  }

  for (const { spool, reason } of pool.values()) {
    ops.push({ kind: "toHand", id: spool.id })
    entries.push({ kind: "toHand", slotLabel: "", label: spoolLabel(spool), color: spool.color, detail: reason })
  }

  return { ops: sortOps(ops), entries, conflicts }
}

/**
 * Turn the user's answer to a conflict into operations:
 * - keep:    it's the same spool, the app is right — remember this tray setup so
 *            the next Sync doesn't ask again.
 * - update:  it's the same spool, but take the printer's material/color.
 * - replace: it's a different spool — create it and send the app's spool to
 *            "In my hand".
 */
export function resolveAmsConflict(
  c: AmsSyncConflict,
  choice: AmsConflictChoice,
  spools: Record<string, Spool>,
  opts: Options = {},
): { ops: AmsSyncOp[]; entries: AmsSyncEntry[] } {
  const { tray, current } = c
  const remain = knownRemain(tray)

  if (choice === "keep") {
    const changes: Partial<Spool> = { amsAck: trayKey(tray) }
    if (tray.rfid) changes.rfidUid = tray.rfid
    if (remain !== null) changes.grams = Math.round((remain / 100) * capacityOf(current, tray))
    return {
      ops: [{ kind: "update", id: current.id, changes }],
      entries: [{ kind: "kept", slotLabel: c.slotLabel, label: spoolLabel(current), color: current.color, detail: "Confirmed as the same spool" }],
    }
  }

  if (choice === "update") {
    const changes: Partial<Spool> = {
      material: c.reported.material,
      color: c.reported.color,
      colorName: c.reported.colorName,
      density: densityFor(c.reported.material, opts.materialDefaults),
      amsAck: undefined,
    }
    if (tray.rfid) changes.rfidUid = tray.rfid
    if (remain !== null) changes.grams = Math.round((remain / 100) * capacityOf(current, tray))
    return {
      ops: [{ kind: "update", id: current.id, changes }],
      entries: [
        {
          kind: "updated",
          slotLabel: c.slotLabel,
          label: `${c.reported.colorName} ${c.reported.material}`,
          color: c.reported.color,
          detail: `Updated from ${spoolLabel(current)} to match the printer`,
        },
      ],
    }
  }

  const known = tray.rfid ? Object.values(spools).find((s) => s.rfidUid === tray.rfid) : undefined
  const spool = known
    ? { ...known, grams: remain !== null ? Math.round((remain / 100) * capacityOf(known, tray)) : known.grams }
    : newSpoolFromTray(tray, opts)
  return {
    ops: sortOps([
      { kind: "clear", slot: c.slot },
      { kind: "ingest", slot: c.slot, spool },
      { kind: "toHand", id: current.id },
    ]),
    entries: [
      known
        ? { kind: "relinked", slotLabel: c.slotLabel, label: spoolLabel(known), color: known.color, detail: "Recognised by RFID and placed here" }
        : createdEntry(spool, tray, c.slotLabel),
      { kind: "toHand", slotLabel: "", label: spoolLabel(current), color: current.color, detail: `Replaced in ${c.slotLabel}` },
    ],
  }
}
