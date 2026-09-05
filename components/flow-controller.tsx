"use client"

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { useStore } from "@/lib/store"
import { orderQueueItems } from "@/lib/selectors"
import { pickFilamentDestination } from "@/lib/filament-flow"
import { newId } from "@/lib/filament"
import type { AppState } from "@/lib/types"
import type { ActiveJob, Printer, QueueItem, Spool } from "@/lib/types"
import type { SpoolDraft } from "./spool-form"
import { draftToSpoolFields } from "./spool-form"

/** A storage location qualified by which node (paternoster unit) it lives in. */
export interface NodeLocation {
  nodeId: string
  shelf: number
  slot: number
}

/**
 * A pending queue entry the user is assembling before the machine starts moving.
 * `spool` is the actual spool object (already created for "place").
 */
export interface PendingItem {
  spool: Spool
  /** storage location (source for pick, destination for store/place) */
  nodeId: string
  shelf: number
  slot: number
  /** printer target (pick) or source (store) */
  printerId?: string
  printerSlot?: number
  /** source storage slot to clear on confirm (set only for a move) */
  from?: NodeLocation
  /** grams override supplied while storing */
  grams?: number
  /** true when this spool was freshly created by `startPlace` (for cancel rollback) */
  isNew?: boolean
}

/** Which queue the tray is currently showing. */
export type QueueView = "in" | "out"

/**
 * Two coexisting draft queues the user assembles at once:
 * - `inItems`  — things going INTO storage: place (new), store (from printer),
 *   move (from another unit). All execute as one job with store semantics.
 * - `outItems` — things coming OUT of storage: pick (onto a printer) and
 *   retrieve (into the hand). All execute as one job with pick semantics.
 * On run they execute one WHOLE job at a time (take-out first, then place-in).
 */
interface FlowState {
  inItems: PendingItem[]
  outItems: PendingItem[]
  view: QueueView
}

interface FlowContextValue {
  /** null when nothing is queued at all. */
  flow: FlowState | null
  inItems: PendingItem[]
  outItems: PendingItem[]
  view: QueueView
  setView: (v: QueueView) => void
  /** queued printer slots for a given printer id (for highlighting) */
  queuedPrinterSlots: (printerId: string) => number[]
  /** queued storage locations for a given node (for highlighting) */
  queuedStorage: (nodeId: string) => { shelf: number; slot: number }[]
  startPick: (spool: Spool, from: NodeLocation, printer: Printer, printerSlot: number) => void
  /** Retrieve a spool out of storage into the user's hand (no printer target). */
  startRetrieve: (spool: Spool, from: NodeLocation) => void
  startStore: (spool: Spool, printer: Printer, printerSlot: number, grams?: number, nodeId?: string) => void
  /** Relocate a stored spool from its slot into another storage unit. */
  startMove: (spool: Spool, from: NodeLocation, destNodeId: string) => void
  startPlace: (draft: SpoolDraft, preferredNodeId?: string) => void
  /**
   * Redirect a queued store/place item into a different storage unit. Recomputes
   * a slot in the chosen unit (balanced for a paternoster, linear for a shelf,
   * appended for a library) while reserving the other queued placements so they
   * don't collide. Only affects in-items (out-items have no storage destination). */
  reassignItemNode: (spoolId: string, nodeId: string) => void
  /**
   * Manual shelf placement: immediately commit ONE queued in-item into an
   * explicit slot the user tapped — no motion, no "Start" press — and drop it
   * from the queue. Leaves the remaining queued spools waiting. */
  assignItemToSlot: (spoolId: string, nodeId: string, shelf: number, slot: number) => void
  cancel: () => void
  /** commit both assembled queues to the machine (take-out first, then place-in) */
  run: () => void
  /**
   * Cross-tab bridge for "act on this spool" from the All Filament In Storage
   * tab: the inventory view records a spool+location here and switches to Home,
   * where HomeView consumes it to open the action hub (load / take out).
   */
  inspectRequest: { spool: Spool; loc: NodeLocation } | null
  requestInspect: (spool: Spool, loc: NodeLocation) => void
  consumeInspect: () => void
}

const FlowContext = createContext<FlowContextValue | null>(null)

// Filament-only slot chooser, shared with the store's "different slot" re-pick.
const pickDestination = pickFilamentDestination

/** Empty draft state: both queues empty, showing the place-in tab. */
const EMPTY: FlowState = { inItems: [], outItems: [], view: "in" }

export function FlowProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useStore()
  const [draft, setDraft] = useState<FlowState>(EMPTY)
  // Pending "act on this spool" request handed off from the inventory tab.
  const [inspectRequest, setInspectRequest] = useState<{ spool: Spool; loc: NodeLocation } | null>(null)

  // ----- external dispense queue runner -----
  // Requests arrive from the printer API (written into the shared doc). Any open
  // PAX screen runs them, and the whole lifecycle is derived from SHARED STATE
  // only — no refs — so it survives reloads and works across devices:
  //
  //   pending  -> START_DISPENSE (atomic: running + job)  -> running
  //   running  + target slot now empty                    -> done
  //   running  + no job + slot still full                 -> error (interrupted)
  //
  // Marking a request "running" persists, so it doubles as a cross-device mutex:
  // a second screen sees one already running and won't start another.

  // Start the oldest pending request when the machine is free and nothing else
  // is mid-dispense.
  useEffect(() => {
    if (state.job) return
    if (state.dispenseRequests.some((r) => r.status === "running")) return
    const pending = state.dispenseRequests.find((r) => r.status === "pending")
    if (!pending) return

    const node = state.nodes.find((n) => n.id === pending.nodeId)
    const spoolId = node?.slots[pending.shelf]?.[pending.slot] ?? null
    const spool = spoolId ? state.spools[spoolId] : null
    if (!node || !spoolId || !spool) {
      dispatch({
        type: "UPDATE_DISPENSE",
        id: pending.id,
        changes: { status: "error", error: "That slot is now empty — nothing to dispense." },
      })
      return
    }

    // SAFETY: never start motion on a carousel that has lost its position. An
    // external request must not be the thing that makes a stopped machine move
    // again; the operator has to home it (via the position-lost dialog) first.
    // Fail the request so the printer can resubmit afterwards.
    if (node.machine.fault || !node.machine.homed) {
      dispatch({
        type: "UPDATE_DISPENSE",
        id: pending.id,
        changes: { status: "error", error: "Carousel position is unknown — home it in PAX, then resubmit." },
      })
      return
    }

    // A dispense is a retrieve-to-hand: rotate to the slot and take the spool
    // out. The printer's own load sequence pulls it in from there. Atomic start
    // guarantees there's never a "running" render without a live job.
    const item: QueueItem = { spoolId, nodeId: pending.nodeId, shelf: pending.shelf, slot: pending.slot, done: false }
    dispatch({ type: "START_DISPENSE", id: pending.id, item })
  }, [state.job, state.dispenseRequests, state.nodes, state.spools, dispatch])

  // Resolve the running request from shared state. Because the start is atomic,
  // any "running" request seen WITHOUT a live job has lost its operation (the
  // running screen reloaded, or the operator cancelled) — recover by erroring so
  // the printer can resubmit rather than hanging forever.
  useEffect(() => {
    if (state.job) return // an operation is live; wait for it to finish
    const running = state.dispenseRequests.find((r) => r.status === "running")
    if (!running) return

    const node = state.nodes.find((n) => n.id === running.nodeId)
    const slotSpool = node?.slots[running.shelf]?.[running.slot] ?? null
    const emptied = running.spoolId ? slotSpool !== running.spoolId : slotSpool == null
    dispatch({
      type: "UPDATE_DISPENSE",
      id: running.id,
      changes: emptied
        ? { status: "done" }
        : { status: "error", error: "Operation ended before the spool was taken out — resubmit to retry." },
    })
  }, [state.job, state.dispenseRequests, state.nodes, dispatch])

  const value = useMemo<FlowContextValue>(() => {
    const { inItems, outItems, view } = draft
    const hasAny = inItems.length > 0 || outItems.length > 0
    const allItems = [...inItems, ...outItems]

    return {
      flow: hasAny ? draft : null,
      inItems,
      outItems,
      view,
      setView: (v) => setDraft((prev) => ({ ...prev, view: v })),

      queuedStorage: (nodeId: string) =>
        allItems.filter((i) => i.nodeId === nodeId).map((i) => ({ shelf: i.shelf, slot: i.slot })),
      queuedPrinterSlots: (printerId: string) =>
        allItems.filter((i) => i.printerId === printerId && i.printerSlot != null).map((i) => i.printerSlot!),

      startPick(spool, from, printer, printerSlot) {
        setDraft((prev) => {
          if (prev.outItems.some((i) => i.spool.id === spool.id)) return prev
          return {
            ...prev,
            view: "out",
            outItems: [
              ...prev.outItems,
              { spool, nodeId: from.nodeId, shelf: from.shelf, slot: from.slot, printerId: printer.id, printerSlot },
            ],
          }
        })
      },

      startRetrieve(spool, from) {
        setDraft((prev) => {
          if (prev.outItems.some((i) => i.spool.id === spool.id)) return prev
          // No printerId/printerSlot → the spool comes out to the user's hand.
          return {
            ...prev,
            view: "out",
            outItems: [...prev.outItems, { spool, nodeId: from.nodeId, shelf: from.shelf, slot: from.slot }],
          }
        })
      },

      startStore(spool, printer, printerSlot, grams, nodeId) {
        setDraft((prev) => {
          if (prev.inItems.some((i) => i.spool.id === spool.id)) return prev
          const reserved = prev.inItems.map((i) => ({ nodeId: i.nodeId, shelf: i.shelf, slot: i.slot }))
          // Size the destination search by the override the user just entered so a
          // paternoster balances around the real stored weight, not the old one.
          const dest = pickDestination(state, grams ?? spool.grams, reserved, nodeId, spool.containerId)
          if (!dest) return prev
          return {
            ...prev,
            view: "in",
            inItems: [
              ...prev.inItems,
              { spool, nodeId: dest.nodeId, shelf: dest.shelf, slot: dest.slot, printerId: printer.id, printerSlot, grams },
            ],
          }
        })
      },

      startMove(spool, from, destNodeId) {
        setDraft((prev) => {
          if (prev.inItems.some((i) => i.spool.id === spool.id)) return prev
          const reserved = prev.inItems.map((i) => ({ nodeId: i.nodeId, shelf: i.shelf, slot: i.slot }))
          // Find a slot in the chosen destination unit; the source slot is still
          // occupied so it can never be picked as the destination.
          const dest = pickDestination(state, spool.grams, reserved, destNodeId, spool.containerId)
          if (!dest) return prev
          // A move is a store from the hand (no printer) that also clears `from`.
          return {
            ...prev,
            view: "in",
            inItems: [...prev.inItems, { spool, nodeId: dest.nodeId, shelf: dest.shelf, slot: dest.slot, from }],
          }
        })
      },

      startPlace(draftSpool, preferredNodeId) {
        // A draft may request several identical spools; queue each into its own
        // best slot for the chosen unit (or the balanced default when none is
        // given), reserving destinations as we go so they don't collide.
        // `preferredNodeId` defaults placement to the unit the user is on (the
        // active section) — including a library, which auto-placement otherwise
        // skips. `quantity` is a form-only field and never stored on a spool.
        const count = Math.max(1, Math.round(draftSpool.quantity ?? 1))
        setDraft((prev) => {
          const created: PendingItem[] = []
          for (let n = 0; n < count; n++) {
            // Each physical spool in a batch gets its OWN minted QR/tag id (the
            // Nth of draft.tagIds), so every spool is individually scannable.
            const spool: Spool = { id: newId("spool"), createdAt: Date.now(), ...draftToSpoolFields(draftSpool, n) }
            // Register the spool immediately so it exists during placement.
            dispatch({ type: "UPSERT_SPOOL", spool })
            const reserved = [...prev.inItems, ...created].map((i) => ({ nodeId: i.nodeId, shelf: i.shelf, slot: i.slot }))
            const dest = pickDestination(state, spool.grams, reserved, preferredNodeId, spool.containerId)
            if (!dest) break
            created.push({ spool, nodeId: dest.nodeId, shelf: dest.shelf, slot: dest.slot, grams: spool.grams, isNew: true })
          }
          if (created.length === 0) return prev
          return { ...prev, view: "in", inItems: [...prev.inItems, ...created] }
        })
      },

      reassignItemNode(spoolId, nodeId) {
        setDraft((prev) => {
          const item = prev.inItems.find((i) => i.spool.id === spoolId)
          if (!item || item.nodeId === nodeId) return prev
          // Reserve every OTHER queued placement so the new slot doesn't collide.
          const reserved = prev.inItems
            .filter((i) => i.spool.id !== spoolId)
            .map((i) => ({ nodeId: i.nodeId, shelf: i.shelf, slot: i.slot }))
          const dest = pickDestination(state, item.grams ?? item.spool.grams, reserved, nodeId, item.spool.containerId)
          // If the chosen unit is full there's nowhere to go — keep the old slot.
          if (!dest || dest.nodeId !== nodeId) return prev
          return {
            ...prev,
            inItems: prev.inItems.map((i) =>
              i.spool.id === spoolId ? { ...i, nodeId: dest.nodeId, shelf: dest.shelf, slot: dest.slot } : i,
            ),
          }
        })
      },

      assignItemToSlot(spoolId, nodeId, shelf, slot) {
        const item = draft.inItems.find((i) => i.spool.id === spoolId)
        if (!item) return
        // Replicate the single-item store/place commit (see CONFIRM_STOP): clear
        // the printer slot it was loaded on, empty the source slot if it's a move,
        // apply any weight override, then drop it into the tapped storage slot.
        if (item.printerId != null && item.printerSlot != null) {
          dispatch({ type: "SET_PRINTER_SLOT", printerId: item.printerId, slot: item.printerSlot, spoolId: null })
        }
        if (item.from) {
          dispatch({
            type: "SET_STORAGE_SLOT",
            nodeId: item.from.nodeId,
            shelf: item.from.shelf,
            slot: item.from.slot,
            spoolId: null,
          })
        }
        if (typeof item.grams === "number") {
          dispatch({ type: "UPDATE_SPOOL", id: item.spool.id, changes: { grams: item.grams } })
        }
        dispatch({ type: "SET_STORAGE_SLOT", nodeId, shelf, slot, spoolId: item.spool.id })
        setDraft((prev) => ({ ...prev, inItems: prev.inItems.filter((i) => i.spool.id !== spoolId) }))
      },

      cancel() {
        // Roll back any brand-new spools created for an un-run "place" that never
        // made it into a slot, so cancelling leaves no orphans in the registry.
        for (const it of inItems) {
          if (!it.isNew) continue
          const placed = state.nodes.some((n) => n.slots.some((row) => row.includes(it.spool.id)))
          if (!placed) dispatch({ type: "DELETE_SPOOL", id: it.spool.id })
        }
        setDraft(EMPTY)
      },

      run() {
        if (!hasAny) return

        // Route a set of pending items by proximity within each motorized
        // carousel so the job grabs the nearest queued shelf first; manual
        // shelves/libraries keep a stable order.
        const nodePos: Record<string, { currentShelf: number; shelves: number }> = {}
        for (const n of state.nodes) {
          if ((n.type ?? "paternoster") === "paternoster") {
            nodePos[n.id] = { currentShelf: n.machine.currentShelf, shelves: n.storage.shelves }
          }
        }
        const toQueueItems = (items: PendingItem[]): QueueItem[] =>
          orderQueueItems(items, nodePos).map((i) => ({
            spoolId: i.spool.id,
            nodeId: i.nodeId,
            shelf: i.shelf,
            slot: i.slot,
            printerId: i.printerId,
            printerSlot: i.printerSlot,
            from: i.from,
            grams: i.grams,
            done: false,
          }))

        // In-items into a library have no physical location to travel to, so they
        // commit INSTANTLY here (no motion overlay, no confirm) — mirroring the
        // Add-to-library flow. Everything else becomes a moving job item.
        const inJobItems = inItems.filter((it) => {
          const node = state.nodes.find((n) => n.id === it.nodeId)
          if (!node || (node.type ?? "paternoster") !== "library") return true
          if (it.printerId != null && it.printerSlot != null) {
            dispatch({ type: "SET_PRINTER_SLOT", printerId: it.printerId, slot: it.printerSlot, spoolId: null })
          }
          if (it.from) {
            dispatch({
              type: "SET_STORAGE_SLOT",
              nodeId: it.from.nodeId,
              shelf: it.from.shelf,
              slot: it.from.slot,
              spoolId: null,
            })
          }
          if (typeof it.grams === "number") {
            dispatch({ type: "UPDATE_SPOOL", id: it.spool.id, changes: { grams: it.grams } })
          }
          // slot beyond the row length appends (see SET_STORAGE_SLOT library branch).
          dispatch({ type: "SET_STORAGE_SLOT", nodeId: it.nodeId, shelf: 0, slot: it.slot, spoolId: it.spool.id })
          return false
        })

        const jobs: ActiveJob[] = []
        // Take-out first, then place-in — one whole job at a time, no interleaving.
        if (outItems.length > 0) jobs.push({ mode: "pick", items: toQueueItems(outItems), currentIndex: 0 })
        if (inJobItems.length > 0) jobs.push({ mode: "store", items: toQueueItems(inJobItems), currentIndex: 0 })

        if (jobs.length > 0) dispatch({ type: "START_JOBS", jobs })
        setDraft(EMPTY)
      },

      inspectRequest,
      requestInspect: (spool, loc) => setInspectRequest({ spool, loc }),
      consumeInspect: () => setInspectRequest(null),
    }
  }, [draft, state, dispatch, inspectRequest])

  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>
}

export function useFlow() {
  const ctx = useContext(FlowContext)
  if (!ctx) throw new Error("useFlow must be used within FlowProvider")
  return ctx
}
