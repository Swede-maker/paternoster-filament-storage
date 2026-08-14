"use client"

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react"
import type {
  ActiveJob,
  AppState,
  FilamentOrder,
  FilamentProfile,
  HistoryEvent,
  HistoryEventKind,
  Machine,
  NodeDriver,
  NodeRole,
  NodeType,
  OrderItem,
  PersistedState,
  Printer,
  PrinterLinkStatus,
  Settings,
  ShelfMeta,
  Spool,
  StorageConfig,
  StorageNode,
} from "./types"
import {
  printerSlotCount,
  secPerShelfToStepMs,
  rampStepMs,
  autoRampPct,
  newId,
  DEFAULT_SEC_PER_SHELF,
  DEFAULT_RAMP_PCT,
} from "./filament"
import { shelfLabel, printerSlotLabel } from "./selectors"
import { shortestRotation } from "./balance"
import { getSystemVersion, loadSystemState, saveSystemState } from "@/app/actions/system-state"

/**
 * Legacy localStorage key. Only used now to do a one-time migration of an
 * existing single-device save up into the shared database on first load.
 */
const STORAGE_KEY = "pax-filament-system-v1"

/** How often (ms) to poll the DB so edits from other devices show up here. */
const SYNC_POLL_MS = 4000

/**
 * Maximum number of filament-history events to retain. The log is a rolling
 * buffer (newest first); once full, the oldest events drop off so the shared
 * save stays small and fast.
 */
const HISTORY_CAP = 1000

/** Pull the durable, shareable subset out of the full runtime state. */
function toPersisted(state: AppState): PersistedState {
  return {
    configured: state.configured,
    settings: state.settings,
    spools: state.spools,
    // Reset live link status so a saved snapshot doesn't claim a unit is
    // online on a device that isn't actually connected to it. Also normalize the
    // volatile machine-motion fields (status/target/direction) to their idle
    // values: a carousel mid-home or mid-rotation is a per-device, per-session
    // concern, not shared state. Persisting it would churn the save signature on
    // every motion tick — flooding the DB with versions and letting the sync
    // poll clobber freshly-committed slot changes mid-operation.
    //
    // `homed` is likewise per-session runtime state — a homing pass is a LOCAL
    // calibration action, not something to command on other clients. We always
    // persist it as `homed: true` so that a client that is momentarily un-homed
    // (mid-home) never broadcasts `homed:false` to peers and makes THEM home
    // too. Combined with migrate() trusting the persisted value, a remote client
    // simply follows the shared position and never spontaneously re-homes.
    nodes: state.nodes.map((n) => ({
      ...n,
      link: n.driver === "hardware" ? "offline" : "online",
      machine: { ...n.machine, homed: true, status: "idle", targetShelf: null, direction: null, moveFrom: null },
    })),
    activeNodeId: state.activeNodeId,
    printers: state.printers,
    activePrinterId: state.activePrinterId,
    history: state.history ?? [],
  }
}

/** Serialize the persisted subset for cheap change-detection. */
function persistedSig(state: AppState): string {
  return JSON.stringify(toPersisted(state))
}

/**
 * Union two arrays of keyed items: keep every local item, then append any
 * remote item whose key we don't already have. Local wins on key conflicts.
 */
function unionByKey<T>(local: T[] | undefined, remote: T[] | undefined, key: (x: T) => string): T[] {
  const base = local ?? []
  const seen = new Set(base.map(key))
  const extras = (remote ?? []).filter((r) => !seen.has(key(r)))
  return extras.length ? [...base, ...extras] : base
}

/**
 * Merge the additive "catalog" registries — saved filament profiles, barcode
 * links, containers, custom materials/brands, and orders — from a remote
 * snapshot into our outgoing document.
 *
 * The system uses a single shared document with last-write-wins saves. Without
 * this, two devices editing at once would let the later save wipe the other's
 * newly added profiles (the reported "I can only keep one profile" bug). These
 * registries are purely additive and keyed, so a union preserves everyone's
 * additions. Positional / live state (nodes, slots, printers, spools) stays
 * last-write-wins, which is correct for a physical carousel's current layout.
 */
function mergeCatalog(local: PersistedState, remote: PersistedState): PersistedState {
  const ls = local.settings
  const rs = remote.settings
  // History is an append-only keyed log, so a union preserves events recorded on
  // every device. Re-sort newest-first and cap so the merged log stays bounded.
  const history = unionByKey(local.history, remote.history, (e) => e.id)
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_CAP)
  return {
    ...local,
    history,
    settings: {
      ...ls,
      filamentProfiles: unionByKey(ls.filamentProfiles, rs.filamentProfiles, (p) => p.id),
      barcodes: unionByKey(ls.barcodes, rs.barcodes, (b) => b.code),
      containers: unionByKey(ls.containers, rs.containers, (c) => c.id),
      customMaterials: unionByKey(ls.customMaterials, rs.customMaterials, (m) => m),
      customBrands: unionByKey(ls.customBrands, rs.customBrands, (b) => b),
      orders: unionByKey(ls.orders, rs.orders, (o) => o.id),
    },
  }
}

/** Homing duration (ms). Per-shelf rotation time is per-node (calibrated speed). */
const HOME_MS = 1300

// ---------------------------------------------------------------------------
// Initial / default state
// ---------------------------------------------------------------------------

const defaultSettings: Settings = {
  systemName: "PAX System",
  confirmBeforeMove: true,
  defaultSpoolWeight: 1000,
  customMaterials: [],
  customBrands: [],
  containers: [],
  defaultDiameter: 1.75,
  filamentProfiles: [],
  barcodes: [],
  orders: [],
}

/** Per-shelf slot counts for a config (jagged when `slotCounts` is present). */
export function slotCountsFor(config: StorageConfig): number[] {
  if (config.slotCounts && config.slotCounts.length === config.shelves) {
    return config.slotCounts.map((c) => Math.max(1, Math.floor(c)))
  }
  return Array.from({ length: config.shelves }, () => config.slotsPerShelf)
}

/** Build an empty (possibly jagged) slot grid from a storage config. */
function buildGrid(config: StorageConfig): (string | null)[][] {
  return slotCountsFor(config).map((count) => Array.from({ length: count }, () => null))
}

function freshMachine(): Machine {
  return { currentShelf: 0, homed: false, status: "idle", targetShelf: null, direction: null, moveFrom: null }
}

/** Shelf nodes have no hardware, so their "machine" is permanently homed/idle. */
function shelfMachine(): Machine {
  return { currentShelf: 0, homed: true, status: "idle", targetShelf: null, direction: null, moveFrom: null }
}

const DEFAULT_AGENT_PORT = 8765

let nodeCounter = 0
function makeNode(opts: {
  name: string
  ip: string
  role: NodeRole
  storage: StorageConfig
  type?: NodeType
  area?: string
  shelfMeta?: ShelfMeta[]
  driver?: NodeDriver
  port?: number
}): StorageNode {
  nodeCounter += 1
  const type: NodeType = opts.type ?? "paternoster"
  // Shelf and library storage have no controller, so they always run
  // "simulated" and stay online; only paternosters can be driven by real
  // hardware.
  const manual = type === "shelf" || type === "library"
  const driver = manual ? "simulated" : opts.driver ?? "simulated"
  return {
    id: `node-${Date.now().toString(36)}-${nodeCounter}`,
    name: opts.name,
    type,
    area: opts.area?.trim() || undefined,
    shelfMeta: opts.shelfMeta,
    ip: opts.ip,
    role: opts.role,
    driver,
    port: opts.port ?? DEFAULT_AGENT_PORT,
    // Simulated nodes are always "online"; hardware nodes start "offline"
    // until the WebSocket connection to the Pi agent is established.
    link: driver === "hardware" ? "offline" : "online",
    // Start at the target speed; a brand-new paternoster must be speed-calibrated
    // before it is allowed to home. Shelf storage has no motor, so it is always
    // considered calibrated.
    secPerShelf: DEFAULT_SEC_PER_SHELF,
    rampPct: DEFAULT_RAMP_PCT,
    calibrated: manual,
    storage: opts.storage,
    // A library is an unbounded single row of spools, so it ignores the
    // shelves/slots config and starts as one empty row that grows on demand.
    slots: type === "library" ? [[]] : buildGrid(opts.storage),
    machine: manual ? shelfMachine() : freshMachine(),
  }
}

function makeInitialState(): AppState {
  const master = makeNode({
    name: "Paternoster 1",
    ip: "127.0.0.1",
    role: "master",
    storage: { shelves: 9, slotsPerShelf: 8 },
  })
  return {
    configured: false,
    settings: defaultSettings,
    spools: {},
    nodes: [master],
    activeNodeId: master.id,
    printers: [],
    activePrinterId: null,
    job: null,
    history: [],
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
  | { type: "HYDRATE"; state: AppState }
  | {
      type: "SETUP"
      nodeType: NodeType
      name?: string
      area?: string
      storage: StorageConfig
      shelfMeta?: ShelfMeta[]
      settings: Partial<Settings>
    }
  | { type: "RESET_ALL" }
  | { type: "UPDATE_SETTINGS"; settings: Partial<Settings> }
  | { type: "ADD_PRESET"; kind: "material" | "brand"; value: string }
  | { type: "REMOVE_PRESET"; kind: "material" | "brand"; value: string }
  // Nodes
  | {
      type: "ADD_NODE"
      name: string
      nodeType: NodeType
      ip?: string
      area?: string
      storage: StorageConfig
      shelfMeta?: ShelfMeta[]
      driver?: NodeDriver
      port?: number
    }
  | {
      type: "UPDATE_NODE"
      id: string
      changes: Partial<Pick<StorageNode, "name" | "ip" | "role" | "link" | "driver" | "port" | "area" | "shelfMeta">>
    }
  /** Rebuild a node's shelf/slot layout, preserving spools that still fit. */
  | { type: "RESHAPE_NODE"; id: string; storage: StorageConfig; shelfMeta?: ShelfMeta[] }
  | { type: "REMOVE_NODE"; id: string }
  | { type: "SET_MASTER"; id: string }
  | { type: "SET_ACTIVE_NODE"; id: string }
  // Hardware bridge (events reported by a real Pi agent over WebSocket)
  | { type: "NODE_LINK"; nodeId: string; link: PrinterLinkStatus }
  | { type: "NODE_POS"; nodeId: string; currentShelf: number }
  | { type: "NODE_ARRIVED"; nodeId: string; shelf: number }
  | { type: "NODE_HOMED"; nodeId: string; currentShelf?: number }
  | { type: "NODE_FAULT"; nodeId: string; message: string }
  // Printers
  | { type: "ADD_PRINTER"; printer: Printer }
  | { type: "UPDATE_PRINTER"; id: string; changes: Partial<Printer> }
  | { type: "REMOVE_PRINTER"; id: string }
  | { type: "SET_ACTIVE_PRINTER"; id: string | null }
  // Spools
  | { type: "UPSERT_SPOOL"; spool: Spool }
  | { type: "UPDATE_SPOOL"; id: string; changes: Partial<Spool> }
  | { type: "DELETE_SPOOL"; id: string }
  /** Subtract consumed filament (g) from a spool, clamped at 0. */
  | { type: "CONSUME_FILAMENT"; spoolId: string; grams: number }
  /**
   * Upsert a spool auto-created from a Bambu AMS tray (matched by RFID uid) and
   * seat it in the given printer slot. Idempotent: an existing spool with the
   * same `rfidUid` is updated in place rather than duplicated.
   */
  | { type: "INGEST_AMS_TRAY"; printerId: string; slot: number; spool: Spool }
  // Filament profiles
  | { type: "ADD_PROFILE"; profile: FilamentProfile }
  | { type: "REMOVE_PROFILE"; id: string }
  // Barcode → profile mappings
  | { type: "ADD_BARCODE"; code: string; profileId: string }
  | { type: "REMOVE_BARCODE"; code: string }
  // Incoming orders / carts
  | { type: "ADD_ORDER"; order: FilamentOrder }
  | { type: "RENAME_ORDER"; id: string; name: string }
  | { type: "REMOVE_ORDER"; id: string }
  | { type: "ADD_ORDER_ITEM"; orderId: string; item: OrderItem }
  | { type: "REMOVE_ORDER_ITEM"; orderId: string; itemId: string }
  | { type: "SET_STORAGE_SLOT"; nodeId: string; shelf: number; slot: number; spoolId: string | null }
  /** Create a brand-new spool directly into a library node's inventory row. */
  | { type: "LIBRARY_ADD_SPOOL"; nodeId: string; spool: Spool }
  | { type: "SET_PRINTER_SLOT"; printerId: string; slot: number; spoolId: string | null }
  // Dry-reminder lifecycle (per spool)
  | { type: "SET_DRY_REMINDER"; spoolId: string; days: number }
  | { type: "RESET_DRY_REMINDER"; spoolId: string }
  | { type: "CLEAR_DRY_REMINDER"; spoolId: string }
  // Wipe the activity log (does not touch spools or reminders)
  | { type: "CLEAR_HISTORY" }
  // Machine / simulation (per node)
  | { type: "HOME_START"; nodeId: string }
  | { type: "HOME_DONE"; nodeId: string }
  | { type: "MANUAL_MOVE"; nodeId: string; direction: "up" | "down" }
  | { type: "GOTO_SHELF"; nodeId: string; shelf: number }
  | { type: "MOVE_TICK"; nodeId: string }
  | { type: "ARRIVED"; nodeId: string }
  | { type: "CONFIRM_MOVE"; nodeId: string }
  // Carousel speed: calibration routine + manual slider
  | { type: "CALIBRATE_START"; nodeId: string }
  | { type: "CALIBRATE_ADVANCE"; nodeId: string }
  | { type: "CALIBRATE_DONE"; nodeId: string; secPerShelf: number }
  | { type: "CALIBRATE_CANCEL"; nodeId: string }
  | { type: "SET_NODE_SPEED"; nodeId: string; secPerShelf: number }
  | { type: "SET_NODE_RAMP"; nodeId: string; rampPct: number }
  // Jobs
  | { type: "START_JOB"; job: ActiveJob }
  | { type: "CONFIRM_STOP"; grams?: number }
  | { type: "CANCEL_JOB" }

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

function getNode(state: AppState, nodeId: string): StorageNode | undefined {
  return state.nodes.find((n) => n.id === nodeId)
}

/** Replace one node via an updater, returning new state. */
function withNode(state: AppState, nodeId: string, fn: (n: StorageNode) => StorageNode): AppState {
  return { ...state, nodes: state.nodes.map((n) => (n.id === nodeId ? fn(n) : n)) }
}

function removeSpoolEverywhere(state: AppState, id: string): AppState {
  const nodes = state.nodes.map((n) => ({
    ...n,
    slots: n.slots.map((row) => row.map((s) => (s === id ? null : s))),
  }))
  const printers = state.printers.map((p) => ({
    ...p,
    loaded: p.loaded.map((s) => (s === id ? null : s)),
  }))
  return { ...state, nodes, printers }
}

// ---------------------------------------------------------------------------
// Per-node machine motion
// ---------------------------------------------------------------------------

/**
 * Begin moving a node's carousel toward `target`.
 * `serviced` = this move is for the current job item (gets the safety-confirm
 * gate + arrives into an awaiting-confirm state). Otherwise it's a background
 * pre-rotation that moves immediately and parks idle on arrival.
 */
function beginNodeMoveTo(state: AppState, nodeId: string, target: number, serviced: boolean): AppState {
  const node = getNode(state, nodeId)
  if (!node) return state
  // Shelf and library storage have no motor: "arrive" immediately (the confirm
  // step still runs so the user is told which spool to reach for by hand).
  if (node.type === "shelf" || node.type === "library") {
    return onNodeArrived(state, nodeId)
  }
  if (node.machine.currentShelf === target) {
    return onNodeArrived(state, nodeId)
  }
  // Already rotating toward this exact shelf (e.g. a background pre-rotation the
  // user has now caught up to) — let it keep going rather than restarting it.
  if (node.machine.status === "moving" && node.machine.targetShelf === target) {
    return state
  }
  const { direction } = shortestRotation(node.machine.currentShelf, target, node.storage.shelves)
  const needsConfirm = serviced && state.settings.confirmBeforeMove
  return withNode(state, nodeId, (n) => ({
    ...n,
    machine: {
      ...n.machine,
      targetShelf: target,
      direction,
      // Remember where this rotation started so the soft start/stop ramp knows
      // how far along the move each tick is.
      moveFrom: n.machine.currentShelf,
      status: needsConfirm ? "awaiting-move-confirm" : "moving",
    },
  }))
}

/** Handle a node reaching its target shelf. */
function onNodeArrived(state: AppState, nodeId: string): AppState {
  const node = getNode(state, nodeId)
  if (!node) return state
  const job = state.job
  const current = job?.items[job.currentIndex]
  const isServicing = !!current && current.nodeId === nodeId
  if (!isServicing) {
    // Background pre-rotation finished — park idle, ready for the user.
    return withNode(state, nodeId, (n) => ({
      ...n,
      machine: { ...n.machine, status: "idle", targetShelf: null, direction: null, moveFrom: null },
    }))
  }
  const status = job!.mode === "pick" ? "awaiting-pick-confirm" : "awaiting-store-confirm"
  return withNode(state, nodeId, (n) => ({
    ...n,
    machine: { ...n.machine, status, targetShelf: null, direction: null, moveFrom: null },
  }))
}

/** Kick off servicing the current job item, and pre-rotate the other nodes. */
function serviceCurrentItem(state: AppState): AppState {
  const job = state.job
  if (!job) return state
  const current = job.items[job.currentIndex]
  if (!current) return state
  // Follow the operation: make the item's storage unit the active tab so the
  // highlighted slot and the on-screen prompt always refer to the same unit.
  const withActive = getNode(state, current.nodeId)
    ? { ...state, activeNodeId: current.nodeId }
    : state
  let next = beginNodeMoveTo(withActive, current.nodeId, current.shelf, true)
  next = prefetchOtherNodes(next)
  return next
}

/**
 * For every node OTHER than the one currently being serviced, look ahead to its
 * next not-yet-done item and begin rotating it into place now (a background
 * move, no confirm gate). This way a second paternoster is already positioned by
 * the time the user finishes picking from the first.
 */
function prefetchOtherNodes(state: AppState): AppState {
  const job = state.job
  if (!job) return state
  const current = job.items[job.currentIndex]
  if (!current) return state

  let next = state
  const handled = new Set<string>([current.nodeId])
  for (let i = job.currentIndex + 1; i < job.items.length; i++) {
    const upcoming = job.items[i]
    if (upcoming.done || handled.has(upcoming.nodeId)) continue
    handled.add(upcoming.nodeId)
    const node = getNode(next, upcoming.nodeId)
    if (!node || node.machine.status !== "idle") continue
    if (node.machine.currentShelf === upcoming.shelf) continue
    next = beginNodeMoveTo(next, upcoming.nodeId, upcoming.shelf, false)
  }
  return next
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * The core state transition. Wrapped by `machineReducer`, which layers on
 * automatic filament-history logging around the mutations below.
 */
function coreReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "HYDRATE":
      return action.state

    case "SETUP": {
      const base = makeInitialState()
      const defaultName = action.nodeType === "shelf" ? "Shelf Storage 1" : "Paternoster 1"
      const master = makeNode({
        name: action.name?.trim() || defaultName,
        ip: "127.0.0.1",
        role: "master",
        type: action.nodeType,
        area: action.area,
        shelfMeta: action.shelfMeta,
        storage: action.storage,
      })
      return {
        ...base,
        configured: true,
        nodes: [master],
        activeNodeId: master.id,
        settings: { ...defaultSettings, ...action.settings },
      }
    }

    case "RESET_ALL":
      return makeInitialState()

    case "UPDATE_SETTINGS":
      return { ...state, settings: { ...state.settings, ...action.settings } }

    case "ADD_PRESET": {
      const key = action.kind === "material" ? "customMaterials" : "customBrands"
      const value = action.value.trim()
      if (!value) return state
      const current = state.settings[key] ?? []
      if (current.some((v) => v.toLowerCase() === value.toLowerCase())) return state
      return { ...state, settings: { ...state.settings, [key]: [...current, value] } }
    }

    case "REMOVE_PRESET": {
      const key = action.kind === "material" ? "customMaterials" : "customBrands"
      const current = state.settings[key] ?? []
      return {
        ...state,
        settings: { ...state.settings, [key]: current.filter((v) => v !== action.value) },
      }
    }

    // ----- nodes -----
    case "ADD_NODE": {
      const node = makeNode({
        name: action.name,
        ip: action.ip ?? "127.0.0.1",
        role: "slave",
        type: action.nodeType,
        area: action.area,
        shelfMeta: action.shelfMeta,
        storage: action.storage,
        driver: action.driver,
        port: action.port,
      })
      return { ...state, nodes: [...state.nodes, node] }
    }

    case "UPDATE_NODE":
      return withNode(state, action.id, (n) => {
        const merged = { ...n, ...action.changes }
        // If the driver mode changed, reset the link + re-home so the new
        // driver (sim timers vs. Pi agent) takes over from a clean state.
        if (action.changes.driver && action.changes.driver !== n.driver) {
          merged.link = action.changes.driver === "hardware" ? "offline" : "online"
          merged.machine = { ...freshMachine(), currentShelf: n.machine.currentShelf }
        }
        return merged
      })

    case "RESHAPE_NODE": {
      const target = getNode(state, action.id)
      if (!target) return state
      // A library has no configurable grid — it's an unbounded single row — so
      // reshaping must never rebuild/truncate it (that would drop spools). Its
      // rename/relocate is handled by UPDATE_NODE; leave its slots untouched.
      if (target.type === "library") return state
      const grid = buildGrid(action.storage)
      // Preserve spools that still fit the new shape; drop spool objects that
      // no longer have a home so the registry doesn't accumulate orphans.
      const spools = { ...state.spools }
      for (let s = 0; s < target.slots.length; s++) {
        const row = target.slots[s]
        for (let slot = 0; slot < row.length; slot++) {
          const id = row[slot]
          if (!id) continue
          if (grid[s] && slot < grid[s].length) {
            grid[s][slot] = id
          } else {
            delete spools[id]
          }
        }
      }
      const nodes = state.nodes.map((n) =>
        n.id === action.id
          ? { ...n, storage: action.storage, shelfMeta: action.shelfMeta ?? n.shelfMeta, slots: grid }
          : n,
      )
      return { ...state, nodes, spools }
    }

    case "REMOVE_NODE": {
      if (state.nodes.length <= 1) return state
      const target = getNode(state, action.id)
      if (!target) return state
      // Spools stored on the removed node are removed with it.
      const spools = { ...state.spools }
      for (const row of target.slots) for (const id of row) if (id) delete spools[id]
      let nodes = state.nodes.filter((n) => n.id !== action.id)
      // Guarantee exactly one master.
      if (target.role === "master" && !nodes.some((n) => n.role === "master")) {
        nodes = nodes.map((n, i) =>
          i === 0
            ? { ...n, role: "master", link: n.driver === "hardware" ? n.link : "online" }
            : n,
        )
      }
      const activeNodeId = state.activeNodeId === action.id ? nodes[0].id : state.activeNodeId
      return { ...state, nodes, activeNodeId, spools }
    }

    case "SET_MASTER": {
      if (!getNode(state, action.id)) return state
      const nodes = state.nodes.map((n) => {
        if (n.id === action.id) {
          // Simulated nodes are always "online"; hardware keeps its live link.
          const link: PrinterLinkStatus = n.driver === "hardware" ? n.link : "online"
          return { ...n, role: "master" as NodeRole, link }
        }
        return { ...n, role: "slave" as NodeRole }
      })
      return { ...state, nodes }
    }

    case "SET_ACTIVE_NODE":
      return getNode(state, action.id) ? { ...state, activeNodeId: action.id } : state

    // ----- printers -----
    case "ADD_PRINTER": {
      const printers = [...state.printers, action.printer]
      return { ...state, printers, activePrinterId: state.activePrinterId ?? action.printer.id }
    }

    case "UPDATE_PRINTER": {
      const printers = state.printers.map((p) => {
        if (p.id !== action.id) return p
        const merged = { ...p, ...action.changes }
        const count = printerSlotCount(merged)
        const loaded = Array.from({ length: count }, (_, i) => merged.loaded[i] ?? null)
        return { ...merged, loaded }
      })
      return { ...state, printers }
    }

    case "REMOVE_PRINTER": {
      const target = state.printers.find((p) => p.id === action.id)
      let next = state
      if (target) {
        const spools = { ...state.spools }
        for (const id of target.loaded) if (id) delete spools[id]
        next = { ...state, spools }
      }
      const printers = next.printers.filter((p) => p.id !== action.id)
      const activePrinterId =
        state.activePrinterId === action.id ? (printers[0]?.id ?? null) : state.activePrinterId
      return { ...next, printers, activePrinterId }
    }

    case "SET_ACTIVE_PRINTER":
      return { ...state, activePrinterId: action.id }

    // ----- spools -----
    case "UPSERT_SPOOL":
      return { ...state, spools: { ...state.spools, [action.spool.id]: action.spool } }

    case "UPDATE_SPOOL": {
      const existing = state.spools[action.id]
      if (!existing) return state
      return { ...state, spools: { ...state.spools, [action.id]: { ...existing, ...action.changes } } }
    }

    case "DELETE_SPOOL": {
      const cleared = removeSpoolEverywhere(state, action.id)
      const spools = { ...cleared.spools }
      delete spools[action.id]
      return { ...cleared, spools }
    }

    case "CONSUME_FILAMENT": {
      const existing = state.spools[action.spoolId]
      if (!existing || !(action.grams > 0)) return state
      const grams = Math.max(0, existing.grams - action.grams)
      if (grams === existing.grams) return state
      return { ...state, spools: { ...state.spools, [action.spoolId]: { ...existing, grams } } }
    }

    case "INGEST_AMS_TRAY": {
      // Match an existing spool by RFID uid so re-reads update in place instead
      // of piling up duplicates.
      const existing = action.spool.rfidUid
        ? Object.values(state.spools).find((s) => s.rfidUid && s.rfidUid === action.spool.rfidUid)
        : undefined
      const id = existing?.id ?? action.spool.id
      const merged: Spool = existing ? { ...existing, ...action.spool, id } : { ...action.spool, id }
      // A physical spool lives in exactly one place. If this same uid was already
      // seated in another slot/AMS or parked in storage, vacate it there first so
      // moving a spool between slots (or reconnecting a different AMS unit) never
      // leaves a ghost copy behind. New spools have no prior location to clear.
      const base = existing ? removeSpoolEverywhere(state, id) : state
      const spools = { ...base.spools, [id]: merged }
      const printers = base.printers.map((p) => {
        if (p.id !== action.printerId) return p
        const loaded = [...p.loaded]
        loaded[action.slot] = id
        return { ...p, loaded }
      })
      return { ...base, spools, printers }
    }

    // ----- filament profiles -----
    case "ADD_PROFILE": {
      const list = state.settings.filamentProfiles ?? []
      const idx = list.findIndex((p) => p.id === action.profile.id)
      const next = idx >= 0 ? list.map((p) => (p.id === action.profile.id ? action.profile : p)) : [...list, action.profile]
      return { ...state, settings: { ...state.settings, filamentProfiles: next } }
    }

    case "REMOVE_PROFILE": {
      const list = state.settings.filamentProfiles ?? []
      const barcodes = (state.settings.barcodes ?? []).filter((b) => b.profileId !== action.id)
      return {
        ...state,
        settings: { ...state.settings, filamentProfiles: list.filter((p) => p.id !== action.id), barcodes },
      }
    }

    // ----- barcode → profile mappings -----
    case "ADD_BARCODE": {
      const code = action.code.trim()
      if (!code) return state
      const list = (state.settings.barcodes ?? []).filter((b) => b.code !== code)
      return { ...state, settings: { ...state.settings, barcodes: [...list, { code, profileId: action.profileId }] } }
    }

    case "REMOVE_BARCODE": {
      const list = state.settings.barcodes ?? []
      return { ...state, settings: { ...state.settings, barcodes: list.filter((b) => b.code !== action.code) } }
    }

    // ----- incoming orders / carts -----
    case "ADD_ORDER":
      return { ...state, settings: { ...state.settings, orders: [...(state.settings.orders ?? []), action.order] } }

    case "RENAME_ORDER": {
      const name = action.name.trim()
      const orders = (state.settings.orders ?? []).map((o) => (o.id === action.id ? { ...o, name: name || o.name } : o))
      return { ...state, settings: { ...state.settings, orders } }
    }

    case "REMOVE_ORDER": {
      const orders = (state.settings.orders ?? []).filter((o) => o.id !== action.id)
      return { ...state, settings: { ...state.settings, orders } }
    }

    case "ADD_ORDER_ITEM": {
      const orders = (state.settings.orders ?? []).map((o) =>
        o.id === action.orderId ? { ...o, items: [...o.items, action.item] } : o,
      )
      return { ...state, settings: { ...state.settings, orders } }
    }

    case "REMOVE_ORDER_ITEM": {
      const orders = (state.settings.orders ?? []).map((o) =>
        o.id === action.orderId ? { ...o, items: o.items.filter((it) => it.id !== action.itemId) } : o,
      )
      return { ...state, settings: { ...state.settings, orders } }
    }

    case "SET_STORAGE_SLOT":
      return withNode(state, action.nodeId, (n) => {
        const slots = n.slots.map((row) => [...row])
        // A library is an unbounded single row: placing a spool at an index at
        // or beyond the current length appends (grows the row), and clearing a
        // spool removes that hole so the row stays compact instead of filling
        // with nulls. Fixed grids (paternoster/shelf) write in place as before.
        if (n.type === "library") {
          const row = slots[0] ?? []
          if (action.spoolId === null) {
            if (action.slot >= 0 && action.slot < row.length) row.splice(action.slot, 1)
          } else if (action.slot >= row.length) {
            row.push(action.spoolId)
          } else {
            row[action.slot] = action.spoolId
          }
          slots[0] = row
          return { ...n, slots }
        }
        slots[action.shelf][action.slot] = action.spoolId
        return { ...n, slots }
      })

    case "LIBRARY_ADD_SPOOL": {
      const target = getNode(state, action.nodeId)
      if (!target || target.type !== "library") return state
      const spools = { ...state.spools, [action.spool.id]: action.spool }
      const nodes = state.nodes.map((n) => {
        if (n.id !== action.nodeId) return n
        const row = [...(n.slots[0] ?? []), action.spool.id]
        return { ...n, slots: [row] }
      })
      return { ...state, spools, nodes }
    }

    case "SET_PRINTER_SLOT": {
      // Nozzle temperature is read-only (displayed live from the printer), so
      // loading/unloading a spool only changes which spool sits in the slot; the
      // app never commands the printer's heaters.
      const printers = state.printers.map((p) => {
        if (p.id !== action.printerId) return p
        const loaded = [...p.loaded]
        loaded[action.slot] = action.spoolId
        return { ...p, loaded }
      })
      return { ...state, printers }
    }

    case "SET_DRY_REMINDER": {
      const spool = state.spools[action.spoolId]
      if (!spool) return state
      const days = Math.max(1, Math.round(action.days))
      return {
        ...state,
        spools: {
          ...state.spools,
          [action.spoolId]: { ...spool, dryReminder: { setAt: Date.now(), days } },
        },
      }
    }

    case "RESET_DRY_REMINDER": {
      const spool = state.spools[action.spoolId]
      if (!spool?.dryReminder) return state
      return {
        ...state,
        spools: {
          ...state.spools,
          [action.spoolId]: { ...spool, dryReminder: { ...spool.dryReminder, setAt: Date.now() } },
        },
      }
    }

    case "CLEAR_DRY_REMINDER": {
      const spool = state.spools[action.spoolId]
      if (!spool?.dryReminder) return state
      const { dryReminder: _removed, ...rest } = spool
      return { ...state, spools: { ...state.spools, [action.spoolId]: rest } }
    }

    case "CLEAR_HISTORY": {
      // Already empty — return the same reference so machineReducer skips work.
      if (!state.history || state.history.length === 0) return state
      return { ...state, history: [] }
    }

    // ----- machine (per node) -----
    case "HOME_START":
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, status: "homing", homed: false, targetShelf: null, direction: null },
      }))

    case "HOME_DONE":
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, status: "idle", homed: true, currentShelf: 0, targetShelf: null, direction: null },
      }))

    case "MANUAL_MOVE": {
      const node = getNode(state, action.nodeId)
      if (!node || node.machine.status !== "idle" || !node.machine.homed) return state
      const { shelves } = node.storage
      const delta = action.direction === "down" ? 1 : -1
      const target = (node.machine.currentShelf + delta + shelves) % shelves
      // Hardware: request a real one-shelf move; the Pi drives the motor and
      // reports arrival. Simulated: step the position instantly.
      if (node.driver === "hardware") {
        return withNode(state, action.nodeId, (n) => ({
          ...n,
          machine: {
            ...n.machine,
            targetShelf: target,
            direction: action.direction,
            moveFrom: n.machine.currentShelf,
            status: "moving",
          },
        }))
      }
      return withNode(state, action.nodeId, (n) => ({ ...n, machine: { ...n.machine, currentShelf: target } }))
    }

    case "GOTO_SHELF": {
      const node = getNode(state, action.nodeId)
      if (!node || !node.machine.homed || node.machine.status !== "idle" || state.job) return state
      if (action.shelf === node.machine.currentShelf) return state
      const { direction } = shortestRotation(node.machine.currentShelf, action.shelf, node.storage.shelves)
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, targetShelf: action.shelf, direction, moveFrom: n.machine.currentShelf, status: "moving" },
      }))
    }

    case "MOVE_TICK": {
      const node = getNode(state, action.nodeId)
      if (!node) return state
      const { targetShelf, direction, currentShelf } = node.machine
      if (targetShelf === null || direction === null) return state
      const { shelves } = node.storage
      const delta = direction === "up" ? 1 : -1
      const nextShelf = (currentShelf + delta + shelves) % shelves
      const moved = withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, currentShelf: nextShelf },
      }))
      if (nextShelf === targetShelf) return onNodeArrived(moved, action.nodeId)
      return moved
    }

    case "ARRIVED":
      return onNodeArrived(state, action.nodeId)

    case "CONFIRM_MOVE": {
      const node = getNode(state, action.nodeId)
      if (!node || node.machine.status !== "awaiting-move-confirm") return state
      return withNode(state, action.nodeId, (n) => ({ ...n, machine: { ...n.machine, status: "moving" } }))
    }

    // ----- carousel speed calibration (per node) -----
    case "CALIBRATE_START": {
      const node = getNode(state, action.nodeId)
      // Only real (paternoster) carousels calibrate, and never mid-job/mid-motion.
      if (!node || node.type === "shelf") return state
      if (node.machine.status !== "idle" && node.machine.status !== "calibrating") return state
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, status: "calibrating", targetShelf: null, direction: null },
      }))
    }

    case "CALIBRATE_ADVANCE": {
      // Visibly index the carousel one shelf as calibration measures each pass.
      const node = getNode(state, action.nodeId)
      if (!node || node.machine.status !== "calibrating") return state
      const { shelves } = node.storage
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, currentShelf: (n.machine.currentShelf + 1) % shelves },
      }))
    }

    case "CALIBRATE_DONE": {
      const node = getNode(state, action.nodeId)
      if (!node) return state
      // Store the found speed and mark calibrated. Leave `homed` untouched: a
      // first-time calibration leaves the unit un-homed so the auto-home effect
      // then homes it (calibration runs BEFORE homing on first setup).
      const sec = Math.max(0.5, action.secPerShelf)
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        secPerShelf: sec,
        // Auto-calibration also derives a soft start/stop ramp from the found
        // speed (faster carousels get gentler easing). The user can still adjust.
        rampPct: autoRampPct(sec),
        calibrated: true,
        machine: { ...n.machine, status: "idle", targetShelf: null, direction: null },
      }))
    }

    case "CALIBRATE_CANCEL": {
      const node = getNode(state, action.nodeId)
      if (!node) return state
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, status: "idle", targetShelf: null, direction: null },
      }))
    }

    case "SET_NODE_SPEED": {
      const node = getNode(state, action.nodeId)
      if (!node || node.type === "shelf") return state
      return withNode(state, action.nodeId, (n) => ({ ...n, secPerShelf: Math.max(0.5, action.secPerShelf) }))
    }

    case "SET_NODE_RAMP": {
      const node = getNode(state, action.nodeId)
      if (!node || node.type === "shelf") return state
      const rampPct = Math.max(0, Math.min(100, Math.round(action.rampPct)))
      return withNode(state, action.nodeId, (n) => ({ ...n, rampPct }))
    }

    // ----- hardware bridge events (from a real Pi agent) -----
    case "NODE_LINK":
      return withNode(state, action.nodeId, (n) => (n.driver === "hardware" ? { ...n, link: action.link } : n))

    case "NODE_POS":
      // Live position update as the carousel passes each shelf sensor.
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, currentShelf: action.currentShelf },
      }))

    case "NODE_ARRIVED": {
      // The Pi reports it stopped at `shelf`. Snap position, then run the same
      // arrival logic the simulation uses (advance job / await confirm).
      const snapped = withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, currentShelf: action.shelf },
      }))
      return onNodeArrived(snapped, action.nodeId)
    }

    case "NODE_HOMED":
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: {
          ...n.machine,
          status: "idle",
          homed: true,
          currentShelf: action.currentShelf ?? 0,
          targetShelf: null,
          direction: null,
        },
      }))

    case "NODE_FAULT":
      // Hardware fault: drop any job and park the node so the user can re-home.
      return {
        ...withNode(state, action.nodeId, (n) => ({
          ...n,
          machine: { ...n.machine, status: "idle", homed: false, targetShelf: null, direction: null },
        })),
        job: null,
      }

    // ----- jobs -----
    case "START_JOB": {
      const job = action.job
      if (job.items.length === 0) return state
      const withJob = { ...state, job: { ...job, currentIndex: 0 } }
      return serviceCurrentItem(withJob)
    }

    case "CONFIRM_STOP": {
      const job = state.job
      if (!job) return state
      const idx = job.currentIndex
      const item = job.items[idx]
      if (!item) return state

      let next: AppState = state

      if (job.mode === "pick") {
        next = machineReducer(next, {
          type: "SET_STORAGE_SLOT",
          nodeId: item.nodeId,
          shelf: item.shelf,
          slot: item.slot,
          spoolId: null,
        })
        if (item.printerId != null && item.printerSlot != null) {
          next = machineReducer(next, {
            type: "SET_PRINTER_SLOT",
            printerId: item.printerId,
            slot: item.printerSlot,
            spoolId: item.spoolId,
          })
        }
      } else if (job.mode === "store") {
        if (item.printerId != null && item.printerSlot != null) {
          next = machineReducer(next, {
            type: "SET_PRINTER_SLOT",
            printerId: item.printerId,
            slot: item.printerSlot,
            spoolId: null,
          })
        }
        // A move also empties the source storage slot the spool came from, so it
        // ends up only in the destination and never in two places at once.
        if (item.from) {
          next = machineReducer(next, {
            type: "SET_STORAGE_SLOT",
            nodeId: item.from.nodeId,
            shelf: item.from.shelf,
            slot: item.from.slot,
            spoolId: null,
          })
        }
        if (typeof action.grams === "number") {
          next = machineReducer(next, { type: "UPDATE_SPOOL", id: item.spoolId, changes: { grams: action.grams } })
        }
        next = machineReducer(next, {
          type: "SET_STORAGE_SLOT",
          nodeId: item.nodeId,
          shelf: item.shelf,
          slot: item.slot,
          spoolId: item.spoolId,
        })
      } else {
        if (typeof action.grams === "number") {
          next = machineReducer(next, { type: "UPDATE_SPOOL", id: item.spoolId, changes: { grams: action.grams } })
        }
        next = machineReducer(next, {
          type: "SET_STORAGE_SLOT",
          nodeId: item.nodeId,
          shelf: item.shelf,
          slot: item.slot,
          spoolId: item.spoolId,
        })
      }

      // Park the just-serviced node back to idle.
      next = withNode(next, item.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, status: "idle", targetShelf: null, direction: null },
      }))

      const items = job.items.map((it, i) => (i === idx ? { ...it, done: true } : it))
      const nextIndex = idx + 1
      if (nextIndex >= items.length) {
        return { ...next, job: null }
      }
      const advanced = { ...next, job: { ...job, items, currentIndex: nextIndex } }
      return serviceCurrentItem(advanced)
    }

    case "CANCEL_JOB": {
      // Return every node that was involved in the job to idle.
      const nodes = state.nodes.map((n) =>
        n.machine.status === "moving" ||
        n.machine.status === "awaiting-move-confirm" ||
        n.machine.status === "awaiting-pick-confirm" ||
        n.machine.status === "awaiting-store-confirm"
          ? { ...n, machine: { ...n.machine, status: "idle" as const, targetShelf: null, direction: null } }
          : n,
      )
      // A store job registers its spool up front but only writes it into a slot
      // on confirm. If the job is cancelled, drop any spool that was created for
      // an unfinished store item so it doesn't linger unplaced in the registry.
      let spools = state.spools
      if (state.job && state.job.mode === "store") {
        const placed = new Set<string>()
        for (const n of nodes) for (const row of n.slots) for (const id of row) if (id) placed.add(id)
        const orphans = state.job.items.filter((it) => !it.done && !placed.has(it.spoolId)).map((it) => it.spoolId)
        if (orphans.length > 0) {
          spools = { ...state.spools }
          for (const id of orphans) delete spools[id]
        }
      }
      return { ...state, nodes, spools, job: null }
    }

    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** Upgrade older single-unit saves into the multi-node shape. */
// ---------------------------------------------------------------------------
// Filament history logging
// ---------------------------------------------------------------------------

/**
 * Derive the history events produced by an action, comparing the state before
 * and after it ran. Load / unload / place / move / remove all funnel through a
 * handful of atomic actions, so logging here captures every spool movement in
 * one place. Storage-slot CLEARS aren't logged: they're always half of a move
 * or a load (whose other half is logged), so logging them would double up.
 */
function historyFor(prev: AppState, next: AppState, action: Action): HistoryEvent[] {
  const make = (kind: HistoryEventKind, spool: Spool, extra: Partial<HistoryEvent>): HistoryEvent => ({
    id: newId("hist"),
    at: Date.now(),
    kind,
    spoolId: spool.id,
    material: spool.material,
    brand: spool.brand,
    color: spool.color,
    colorName: spool.colorName,
    ...extra,
  })

  switch (action.type) {
    case "SET_PRINTER_SLOT": {
      if (action.spoolId) {
        const printer = next.printers.find((p) => p.id === action.printerId)
        const spool = next.spools[action.spoolId]
        if (!spool) return []
        return [
          make("load", spool, {
            printerId: printer?.id,
            printerName: printer?.name,
            slotLabel: printer ? printerSlotLabel(printer, action.slot) : undefined,
          }),
        ]
      }
      // Unload: the spool that WAS in that slot is read from the previous state.
      const prevPrinter = prev.printers.find((p) => p.id === action.printerId)
      const oldId = prevPrinter?.loaded[action.slot]
      if (!oldId) return []
      const spool = next.spools[oldId] ?? prev.spools[oldId]
      if (!spool) return []
      return [
        make("unload", spool, {
          printerId: prevPrinter?.id,
          printerName: prevPrinter?.name,
          slotLabel: prevPrinter ? printerSlotLabel(prevPrinter, action.slot) : undefined,
        }),
      ]
    }

    case "SET_STORAGE_SLOT": {
      if (!action.spoolId) return []
      const spool = next.spools[action.spoolId]
      if (!spool) return []
      const node = getNode(next, action.nodeId)
      const isLibrary = (node?.type ?? "paternoster") === "library"
      const locationLabel = node
        ? isLibrary
          ? "Library"
          : `${shelfLabel(node, action.shelf)} · Slot ${action.slot + 1}`
        : undefined
      return [make("placed", spool, { nodeId: node?.id, nodeName: node?.name, locationLabel })]
    }

    case "LIBRARY_ADD_SPOOL": {
      const spool = next.spools[action.spool.id]
      if (!spool) return []
      const node = getNode(next, action.nodeId)
      return [make("placed", spool, { nodeId: node?.id, nodeName: node?.name, locationLabel: "Library" })]
    }

    case "SET_DRY_REMINDER": {
      const spool = next.spools[action.spoolId]
      if (!spool) return []
      return [make("dry-set", spool, { days: spool.dryReminder?.days })]
    }

    case "RESET_DRY_REMINDER": {
      const spool = next.spools[action.spoolId]
      if (!spool) return []
      return [make("dry-reset", spool, { days: spool.dryReminder?.days })]
    }

    case "CLEAR_DRY_REMINDER": {
      const spool = next.spools[action.spoolId] ?? prev.spools[action.spoolId]
      if (!spool) return []
      return [make("dry-cleared", spool, {})]
    }

    case "DELETE_SPOOL": {
      const spool = prev.spools[action.id]
      if (!spool) return []
      return [make("removed", spool, {})]
    }

    default:
      return []
  }
}

/**
 * The reducer the app actually uses: runs the core transition, then appends any
 * filament-history events it produced (newest first, capped at HISTORY_CAP).
 */
function machineReducer(state: AppState, action: Action): AppState {
  const next = coreReducer(state, action)
  // HYDRATE/RESET replace the whole state (history included); never log around them.
  if (next === state || action.type === "HYDRATE" || action.type === "RESET_ALL") return next
  const events = historyFor(state, next, action)
  if (events.length === 0) return next
  const history = [...events, ...(next.history ?? [])].slice(0, HISTORY_CAP)
  return { ...next, history }
}

function migrate(parsed: any): AppState {
  const base = makeInitialState()
  const settings: Settings = { ...defaultSettings, ...(parsed.settings ?? {}) }

  let nodes: StorageNode[]
  let activeNodeId: string
  if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
    nodes = parsed.nodes.map((n: StorageNode) => {
      // Preserve every known node type. Previously any non-shelf type collapsed
      // to "paternoster", which silently turned a persisted library back into a
      // carousel (SLAVE badge + carousel view) on every hydrate/sync.
      const type: NodeType = n.type === "shelf" ? "shelf" : n.type === "library" ? "library" : "paternoster"
      // Shelf and library storage are manual — no controller, so never hardware.
      const manual = type === "shelf" || type === "library"
      const driver: NodeDriver = manual ? "simulated" : n.driver === "hardware" ? "hardware" : "simulated"
      return {
        ...n,
        type,
        driver,
        // A library is an unbounded single row; guarantee it always has at least
        // one row so adding/rendering spools never hits an undefined slot array.
        slots: type === "library" ? (Array.isArray(n.slots) && n.slots.length > 0 ? n.slots : [[]]) : n.slots,
        // Manual units have no motor, so they're always calibrated.
        calibrated: manual ? true : n.calibrated,
        port: typeof n.port === "number" ? n.port : DEFAULT_AGENT_PORT,
        // Hardware nodes start offline until reconnected; simulated stay online.
        link: driver === "hardware" ? "offline" : "online",
        // Manual units (shelf + library) are permanently "homed". For a
        // paternoster we TRUST the last known position that was persisted: a
        // carousel with an absolute index sensor already knows where it is, so
        // opening a new tab, device, or session must NOT force a re-home. We
        // restore `homed` and `currentShelf` and only normalize the per-session
        // motion fields (status/target/direction) back to idle. A brand-new,
        // never-homed unit stays `homed: false` and is homed once by auto-home.
        machine: manual
          ? shelfMachine()
          : {
              ...freshMachine(),
              homed: n.machine?.homed ?? false,
              currentShelf: n.machine?.currentShelf ?? 0,
            },
      }
    })
    activeNodeId = parsed.activeNodeId && nodes.some((n) => n.id === parsed.activeNodeId) ? parsed.activeNodeId : nodes[0].id
  } else if (parsed.storage && parsed.slots) {
    // Legacy single-unit save.
    const master = makeNode({
      name: "Paternoster 1",
      ip: "127.0.0.1",
      role: "master",
      storage: parsed.storage,
    })
    master.slots = parsed.slots
    nodes = [master]
    activeNodeId = master.id
  } else {
    nodes = base.nodes
    activeNodeId = base.activeNodeId
  }

  return {
    configured: !!parsed.configured,
    settings,
    spools: parsed.spools ?? {},
    nodes,
    activeNodeId,
    printers: (parsed.printers ?? []).map((p: Printer) => ({ ...p, link: "offline" })),
    activePrinterId: parsed.activePrinterId ?? null,
    job: null,
    history: Array.isArray(parsed.history) ? parsed.history.slice(0, HISTORY_CAP) : [],
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface StoreContextValue {
  state: AppState
  dispatch: React.Dispatch<Action>
  ready: boolean
}

const StoreContext = createContext<StoreContextValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(machineReducer, undefined, makeInitialState)
  const readyRef = useRef(false)
  const [ready, setReady] = useReducer(() => true, false)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Sync bookkeeping. `dbVersion` is the last version we've seen from the
  // server; `lastSavedSig` is the persisted-subset signature we last wrote, so
  // we can skip redundant saves and skip reloading our own writes.
  const dbVersion = useRef(0)
  const lastSavedSig = useRef<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A save that has been scheduled/started but not yet acknowledged by the
  // server. While this is true, a poll must not reload — otherwise it can fetch
  // a version from before our write landed and clobber the local change.
  const saveInFlight = useRef(false)
  // Always-fresh view of state so the poll can consult the live job/state
  // without waiting for its effect to re-subscribe.
  const stateRef = useRef(state)
  stateRef.current = state

  // Load the shared system from the database on mount. If the DB is empty but
  // this browser has a legacy localStorage save, migrate it up into the DB so
  // existing single-device setups aren't lost.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const { data, version } = await loadSystemState()
        if (cancelled) return
        if (data) {
          dbVersion.current = version
          const hydrated = migrate(data)
          lastSavedSig.current = persistedSig(hydrated)
          dispatch({ type: "HYDRATE", state: hydrated })
        } else {
          // Nothing shared yet — attempt a one-time migration from localStorage.
          let legacy: PersistedState | null = null
          try {
            const raw = localStorage.getItem(STORAGE_KEY)
            if (raw) legacy = JSON.parse(raw)
          } catch {
            // ignore corrupt legacy storage
          }
          if (legacy) {
            const hydrated = migrate(legacy)
            dispatch({ type: "HYDRATE", state: hydrated })
            const { version: v } = await saveSystemState(toPersisted(hydrated))
            if (!cancelled) {
              dbVersion.current = v
              lastSavedSig.current = persistedSig(hydrated)
            }
          }
        }
      } catch (e) {
        console.log("[v0] initial system load failed:", (e as Error).message)
      } finally {
        if (!cancelled) {
          readyRef.current = true
          setReady()
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Save the durable subset to the database (debounced) whenever it changes.
  const sig = persistedSig(state)
  useEffect(() => {
    if (!readyRef.current) return
    if (sig === lastSavedSig.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveInFlight.current = true
    saveTimer.current = setTimeout(async () => {
      try {
        let payload = toPersisted(state)
        // Before a last-write-wins save, fold in any catalog additions another
        // device made since our last sync (profiles, barcodes, containers,
        // custom materials/brands, orders) so this save can't drop them. The
        // merged extras flow back into local state on the next poll.
        try {
          const latest = await loadSystemState()
          if (latest.data) payload = mergeCatalog(payload, latest.data)
        } catch {
          // Offline or load failed — save the local document as-is.
        }
        const { version } = await saveSystemState(payload)
        dbVersion.current = version
        lastSavedSig.current = sig
      } catch (e) {
        console.log("[v0] system save failed:", (e as Error).message)
      } finally {
        saveInFlight.current = false
      }
    }, 600)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [sig])

  // Poll the DB so edits made on OTHER devices show up here. If the server
  // version moved past ours and it wasn't our own write, reload the document.
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const iv = setInterval(async () => {
      try {
        // Never reload on top of an in-progress operation or a pending write:
        // a job mid-flight or an unacknowledged save is local truth that a stale
        // server snapshot must not overwrite.
        if (stateRef.current.job || saveInFlight.current) return
        const { version } = await getSystemVersion()
        if (cancelled || version === 0 || version === dbVersion.current) return
        // Re-check the guards after the await — a job/save may have started while
        // the version request was in flight.
        if (stateRef.current.job || saveInFlight.current) return
        const { data, version: v } = await loadSystemState()
        if (cancelled || !data || stateRef.current.job || saveInFlight.current) return
        const incoming = migrate(data)
        const incomingSig = persistedSig(incoming)
        dbVersion.current = v
        // Only apply if it actually differs from what we already have, so a
        // remote change doesn't clobber local live motion needlessly.
        if (incomingSig !== persistedSig(stateRef.current)) {
          lastSavedSig.current = incomingSig
          dispatch({ type: "HYDRATE", state: incoming })
        }
      } catch {
        // transient network error — try again next tick
      }
    }, SYNC_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [ready, sig])

  // Auto-home every node on power up once configured. Simulated nodes home
  // immediately; hardware nodes only home once their Pi agent is connected
  // (link "online"), so we don't get stuck homing an offline unit.
  useEffect(() => {
    if (!ready || !state.configured) return
    for (const n of state.nodes) {
      // Only a paternoster homes — manual shelf/library units have no motor.
      if (n.type === "shelf" || n.type === "library") continue
      if (n.machine.homed || n.machine.status !== "idle") continue
      if (n.driver === "hardware" && n.link !== "online") continue
      // A paternoster must be speed-calibrated before it may home.
      if (!n.calibrated) continue
      dispatch({ type: "HOME_START", nodeId: n.id })
    }
  }, [ready, state.configured, state.nodes])

  // Drive homing + rotation timers for ALL simulated nodes simultaneously.
  // Hardware nodes are driven by their Pi agent instead (see NodeConnection),
  // so we never arm sim timers for them.
  const motionSig = state.nodes
    .map(
      (n) =>
        `${n.id}:${n.driver}:${n.machine.status}:${n.machine.currentShelf}:${n.machine.moveFrom ?? ""}:${n.machine.targetShelf ?? ""}:${n.secPerShelf}:${n.rampPct ?? ""}`,
    )
    .join("|")
  useEffect(() => {
    const active = new Set<string>()
    for (const n of state.nodes) {
      if (n.driver === "hardware") continue
      // Per-node step time reflects the calibrated/slider speed so faster/slower
      // is actually visible as the carousel rotates.
      const baseMs = secPerShelfToStepMs(n.secPerShelf)
      if (n.machine.status === "homing") {
        active.add(`home:${n.id}`)
        if (!timers.current[`home:${n.id}`]) {
          timers.current[`home:${n.id}`] = setTimeout(() => {
            delete timers.current[`home:${n.id}`]
            dispatch({ type: "HOME_DONE", nodeId: n.id })
          }, HOME_MS)
        }
      }
      if (n.machine.status === "moving") {
        const key = `move:${n.id}`
        active.add(key)
        // Soft start/stop: slow the first and last steps of a multi-shelf move
        // and run full speed through the middle. Progress is measured from where
        // the move started (moveFrom) to its target, in the move's direction.
        const shelves = n.storage.shelves
        const from = n.machine.moveFrom ?? n.machine.currentShelf
        const target = n.machine.targetShelf ?? n.machine.currentShelf
        const up = n.machine.direction !== "down"
        const total = up ? (target - from + shelves) % shelves : (from - target + shelves) % shelves
        const taken = up
          ? (n.machine.currentShelf - from + shelves) % shelves
          : (from - n.machine.currentShelf + shelves) % shelves
        const stepMs = rampStepMs(baseMs, taken, total || 1, n.rampPct ?? DEFAULT_RAMP_PCT)
        // Re-arm each tick (currentShelf change re-runs this effect).
        if (timers.current[key]) clearTimeout(timers.current[key])
        timers.current[key] = setTimeout(() => {
          delete timers.current[key]
          dispatch({ type: "MOVE_TICK", nodeId: n.id })
        }, stepMs)
      }
    }
    // Clear timers for nodes no longer homing/moving.
    for (const key of Object.keys(timers.current)) {
      if (!active.has(key)) {
        clearTimeout(timers.current[key])
        delete timers.current[key]
      }
    }
  }, [motionSig, state.nodes])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    for (const key of Object.keys(timers.current)) clearTimeout(timers.current[key])
  }, [])

  return <StoreContext.Provider value={{ state, dispatch, ready }}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error("useStore must be used within StoreProvider")
  return ctx
}
