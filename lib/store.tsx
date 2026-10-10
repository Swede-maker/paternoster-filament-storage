"use client"

import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type {
  ActiveJob,
  AppState,
  ConsumptionBucket,
  FilamentOrder,
  FilamentProfile,
  FilamentUsage,
  HardwareCategory,
  HardwareOrder,
  PickList,
  HardwareOrderItem,
  HardwarePart,
  SystemKind,
  HistoryEvent,
  HistoryEventKind,
  Machine,
  MachineStatus,
  NodeDriver,
  NodeRole,
  NodeType,
  OrderItem,
  OrderStore,
  QueueItem,
  QueueMode,
  PersistedState,
  Printer,
  DispenseRequest,
  StorageSnapshot,
  PrinterLinkStatus,
  Settings,
  ShelfMeta,
  Spool,
  StorageConfig,
  StorageNode,
  TagBinding,
  RfidReader,
} from "./types"
import type {
  BalanceEvent,
  CalibrationEvent,
  MotorMode,
  NetResultEvent,
  NetSlave,
  NetStatusEvent,
  ServoEvent,
} from "./node-protocol"
import { printerAmsUnits, printerSlotCount, rampStepMs, newId, DEFAULT_RAMP_PCT } from "./filament"
import { pickRemainderDestination } from "./hardware-flow"
import { shelfLabel, printerSlotLabel, nodeSystem } from "./selectors"
import { shortestRotation } from "./balance"
import { pickFilamentDestination } from "./filament-flow"
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

/** Cap on archived usage tallies kept, so the synced doc stays small. */
const USAGE_ARCHIVE_CAP = 500

/** Cap on queued/finished dispense requests kept in the synced doc. */
const DISPENSE_CAP = 200

/**
 * Cap on daily consumption buckets retained. One row per
 * day×printer×material×color; a couple of years of varied use stays well under
 * this, and old rows drop off oldest-first so the synced doc stays small.
 */
const CONSUMPTION_LOG_CAP = 5000

/** Cap on daily storage snapshots (one per day) — roughly 5+ years. */
const STORAGE_SNAPSHOT_CAP = 2000

/**
 * Keep a printer's mixed-AMS array and its legacy uniform fields consistent.
 *
 * `ams` (when present) is the source of truth for AMS printers. We derive
 * `amsUnits` from its length and `slotsPerAms` from the first unit so every
 * legacy call site that still reads the flat fields keeps working, and we
 * re-sync the flat `loaded` array to the true total slot count.
 */
/** Keep only the first item for each id, preserving order (self-heals dup data). */
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const it of items) {
    if (seen.has(it.id)) continue
    seen.add(it.id)
    out.push(it)
  }
  return out
}

function normalizePrinter(p: Printer): Printer {
  const units = printerAmsUnits(p)
  const next: Printer =
    p.kind === "ams"
      ? { ...p, ams: units, amsUnits: units.length, slotsPerAms: Math.max(1, units[0]?.slots ?? 1) }
      : { ...p, ams: undefined }
  const count = printerSlotCount(next)
  const loaded = Array.from({ length: count }, (_, i) => next.loaded?.[i] ?? null)
  return { ...next, loaded }
}

/** A fresh, empty filament-usage tracker. */
function defaultUsage(): FilamentUsage {
  return { currentG: 0, since: Date.now(), archived: [] }
}

/**
 * Coerce an unknown persisted value into a valid FilamentUsage, tolerating
 * older saves that predate usage tracking (returns a fresh tracker).
 */
function coerceUsage(u: unknown): FilamentUsage {
  if (!u || typeof u !== "object") return defaultUsage()
  const raw = u as Partial<FilamentUsage>
  return {
    currentG: typeof raw.currentG === "number" && raw.currentG >= 0 ? raw.currentG : 0,
    since: typeof raw.since === "number" ? raw.since : Date.now(),
    archived: Array.isArray(raw.archived) ? raw.archived.slice(0, USAGE_ARCHIVE_CAP) : [],
  }
}

/** Pull the durable, shareable subset out of the full runtime state. */
function toPersisted(state: AppState): PersistedState {
  return {
    configured: state.configured,
    settings: state.settings,
    spools: state.spools,
    parts: state.parts ?? {},
    hardwareOrders: state.hardwareOrders ?? [],
    hwPickLists: state.hwPickLists ?? [],
    // Reset live link status so a saved snapshot doesn't claim a unit is
    // online on a device that isn't actually connected to it. Also normalize the
    // volatile machine-motion fields (status/target/direction) to their idle
    // values: a carousel mid-home or mid-rotation is a per-device, per-session
    // concern, not shared state. Persisting it would churn the save signature on
    // every motion tick — flooding the DB with versions and letting the sync
    // poll clobber freshly-committed slot changes mid-operation.
    //
    // `homed` is likewise per-session runtime state — a homing pass is a LOCAL
    // action, not something to command on other clients. We always
    // persist it as `homed: true` so that a client that is momentarily un-homed
    // (mid-home) never broadcasts `homed:false` to peers and makes THEM home
    // too. Combined with migrate() trusting the persisted value, a remote client
    // simply follows the shared position and never spontaneously re-homes.
    // `linkError` is stripped alongside `connSeq`: it describes THIS device's
    // connection attempt, so syncing it would show a stale local network error
    // on every other device.
    // `agentSimulated`/`agentSimReason` are stripped for the same reason: they
    // describe the agent THIS device is talking to right now.
    nodes: state.nodes.map(
      ({
        connSeq: _connSeq,
        linkError: _linkError,
        agentSimulated: _agentSimulated,
        agentSimReason: _agentSimReason,
        // Network picture is per-relay runtime knowledge too.
        net: _net,
        netSlaves: _netSlaves,
        netResult: _netResult,
        // Servo alarm lamps likewise describe the live link, not the config.
        servo: _servo,
        // The calibration REPORT is live too; its numbers are persisted
        // separately as servoCarouselPulses / servoIndexWindowPulses.
        calibration: _calibration,
        calibrating: _calibrating,
        balance: _balance,
        ...n
      }) => ({
        ...n,
        link: n.driver === "hardware" ? "offline" : "online",
        // `fault` is stripped too: it describes what THIS device's link saw, and
        // syncing it would pop the "position lost" dialog on peers that never
        // received the fault frame.
        machine: {
          ...n.machine,
          homed: true,
          status: "idle",
          targetShelf: null,
          direction: null,
          moveFrom: null,
          fault: null,
          homingRequest: null,
        },
      }),
    ),
    activeNodeId: state.activeNodeId,
    // Normalise so the mixed-AMS array and legacy uniform fields never drift
    // apart in the synced document. Live link status is per-device.
    printers: state.printers.map(normalizePrinter),
    activePrinterId: state.activePrinterId,
    dispenseRequests: state.dispenseRequests ?? [],
    apiToken: state.apiToken,
    history: state.history ?? [],
    usage: state.usage ?? defaultUsage(),
    consumptionLog: state.consumptionLog ?? [],
    storageSnapshots: state.storageSnapshots ?? [],
  }
}

/** Serialize the persisted subset for cheap change-detection. */
function persistedSig(state: AppState): string {
  return JSON.stringify(toPersisted(state))
}

/**
 * Three-way merge of keyed items so concurrent ADDS survive without
 * resurrecting local DELETES.
 *
 *  - Keep every local item (local wins on key conflicts).
 *  - Append a remote item only when it's genuinely new since our `baseline`
 *    (the last document we synced from the server) — i.e. another device added
 *    it. A remote item that WAS in the baseline but is now missing locally is
 *    something we deleted, so we must NOT add it back.
 *
 * Without the baseline this was a plain add-only union, which made deletions
 * impossible: removing a profile/brand/order/barcode locally, then folding the
 * still-present remote copy back in on the next save, silently restored it —
 * the reported "I remove it but it comes back on refresh" bug.
 */
function mergeByKey<T>(
  local: T[] | undefined,
  remote: T[] | undefined,
  baseline: T[] | undefined,
  key: (x: T) => string,
): T[] {
  const base = local ?? []
  const seen = new Set(base.map(key))
  const baseKeys = new Set((baseline ?? []).map(key))
  // A remote item is a true concurrent add only if we've never seen its key:
  // not present locally AND not present in the baseline we diverged from.
  const extras = (remote ?? []).filter((r) => !seen.has(key(r)) && !baseKeys.has(key(r)))
  return extras.length ? [...base, ...extras] : base
}

/**
 * Delete-safe merge of a keyed record (e.g. hardware parts). Local always wins
 * for keys it holds; a remote entry is folded in only when its key is new since
 * the `baseline` (a genuine concurrent add on another device). An entry that WAS
 * in the baseline but is now missing locally is a local delete, so it is not
 * resurrected. Mirrors {@link mergeByKey} for object maps.
 */
function mergeRecordByKey<T>(
  local: Record<string, T> | undefined,
  remote: Record<string, T> | undefined,
  baseline: Record<string, T> | undefined,
): Record<string, T> {
  const base = local ?? {}
  const baseKeys = new Set(Object.keys(baseline ?? {}))
  let out: Record<string, T> | null = null
  for (const [k, v] of Object.entries(remote ?? {})) {
    if (k in base || baseKeys.has(k)) continue
    if (!out) out = { ...base }
    out[k] = v
  }
  return out ?? base
}

/**
 * Fold server-side filament consumption into the outgoing spool map.
 *
 * The Pi decrements spool `grams` in the database as printers extrude, even with
 * no browser open. When a browser later saves its (possibly stale) state, a
 * plain local-wins merge would overwrite that decrement. For each spool we
 * instead apply the server's gram DECREASE since the `baseline` on top of the
 * local grams:
 *   merged = clamp(local - max(0, baseline - remote))
 * This preserves background consumption while letting a deliberate local change
 * (refilling, editing weight, swapping the spool) win, since that moves the
 * local value independently of the server delta. Spools not present locally are
 * left to the normal last-write-wins map (handled by the caller's spread).
 */
function mergeServerConsumption(
  local: Record<string, Spool>,
  remote: Record<string, Spool> | undefined,
  baseline: Record<string, Spool> | undefined,
): Record<string, Spool> {
  if (!remote || !baseline) return local
  let changed = false
  const out: Record<string, Spool> = { ...local }
  for (const id of Object.keys(local)) {
    const base = baseline[id]
    const rem = remote[id]
    if (!base || !rem) continue // new/edited spool — leave local as-is
    const serverConsumed = Math.max(0, base.grams - rem.grams)
    if (serverConsumed <= 0) continue
    const merged = Math.max(0, local[id].grams - serverConsumed)
    if (merged !== local[id].grams) {
      out[id] = { ...local[id], grams: merged }
      changed = true
    }
  }
  return changed ? out : local
}

/**
 * Merge the additive "catalog" registries — saved filament profiles, barcode
 * links, containers, custom materials/brands, orders, and the history log —
 * from a remote snapshot into our outgoing document, using `baseline` (the last
 * synced server document) as the common ancestor.
 *
 * The system uses a single shared document with last-write-wins saves. This
 * three-way merge preserves additions made on another device (so a later save
 * can't drop them — the "I can only keep one profile" bug) while still honoring
 * deletions made locally (so removed items stay removed). Positional / live
 * state (nodes, slots, printers, spools) stays last-write-wins, which is correct
 * for a physical carousel's current layout.
 */
/**
 * Merge daily consumption buckets across devices. Each bucket is keyed by
 * day|printerId|material|color and its grams only ever grow within a day, so on
 * a key conflict we take the MAX (whichever device saw more) and union the rest.
 * This preserves the server-written record while tolerating a stale browser.
 */
function mergeConsumptionLog(
  local: ConsumptionBucket[] | undefined,
  remote: ConsumptionBucket[] | undefined,
): ConsumptionBucket[] {
  const key = (b: ConsumptionBucket) => `${b.day}|${b.printerId}|${b.material}|${b.color}`
  const map = new Map<string, ConsumptionBucket>()
  for (const b of local ?? []) map.set(key(b), b)
  for (const b of remote ?? []) {
    const k = key(b)
    const prev = map.get(k)
    if (!prev || b.grams > prev.grams) map.set(k, b)
  }
  return [...map.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-CONSUMPTION_LOG_CAP)
}

/**
 * Three-way merge of the shelf/slot grid for every node.
 *
 * Every open client receives the same carousel position ticks from the Pi, and
 * `pos` is part of the persisted document, so a SECOND tab/phone saves its own
 * copy of the state a moment after any rotation. With plain last-write-wins that
 * stale copy overwrote a placement the FIRST device had just made — the spool
 * appeared in its slot and then vanished seconds later. Here a cell is taken
 * from `remote` only when this device did NOT touch it since `baseline`; cells
 * we changed always win, so our own placement can never be undone by a device
 * that merely echoed a position update.
 */
/**
 * Operator-tuned drive settings on a node. These get the same three-way merge
 * as slot cells: the Pi's position ticks make EVERY open device re-save the
 * document, so a phone's new approach speed was overwritten seconds later by a
 * desktop tab that still held the old value and merely echoed a position — and
 * then synced back to the phone as "reverted to default".
 */
const NODE_TUNING_KEYS = [
  "pwmDuty",
  "homingDuty",
  "approachDuty",
  "servoPulsesPerRev",
  "servoMaxPps",
  "servoGearRatio",
  "servoJogPulses",
  "dcJogMs",
  "dcTrimPct",
  "servoMirrorB",
  "servoSingleMotor",
  "servoIgnoreAlarm",
  "servoHoldTimeoutS",
  "motorMode",
  "positionMode",
  "servoCarouselPulses",
  "servoIndexWindowPulses",
  "servoCalibratedAt",
] as const satisfies readonly (keyof StorageNode)[]

function mergeNodeSlots(local: StorageNode[], remote: StorageNode[] | undefined, baseline: StorageNode[] | undefined): StorageNode[] {
  if (!remote || !baseline) return local
  const remoteById = new Map(remote.map((n) => [n.id, n]))
  const baseById = new Map(baseline.map((n) => [n.id, n]))
  let changed = false
  const out = local.map((node) => {
    const rem = remoteById.get(node.id)
    const base = baseById.get(node.id)
    if (!rem || !base) return node
    let tuned: Partial<StorageNode> | null = null
    for (const key of NODE_TUNING_KEYS) {
      const l = node[key]
      const r = rem[key]
      const b = base[key]
      // Unchanged here but changed on another device → adopt its value.
      if (l === b && r !== b) {
        if (!tuned) tuned = {}
        ;(tuned as Record<string, unknown>)[key] = r
      }
    }
    let slots: (string | null)[][] | null = null
    for (let s = 0; s < node.slots.length; s++) {
      const lRow = node.slots[s] ?? []
      const rRow = rem.slots[s]
      const bRow = base.slots[s]
      if (!rRow || !bRow) continue
      for (let i = 0; i < lRow.length; i++) {
        const l = lRow[i] ?? null
        const r = rRow[i] ?? null
        const b = bRow[i] ?? null
        // Unchanged here but changed elsewhere → adopt the other device's value.
        if (l === b && r !== b) {
          if (!slots) slots = node.slots.map((row) => [...row])
          slots[s][i] = r
        }
      }
    }
    if (!slots && !tuned) return node
    changed = true
    return { ...node, ...(tuned ?? {}), ...(slots ? { slots } : {}) }
  })
  return changed ? out : local
}

function mergeCatalog(local: PersistedState, remote: PersistedState, baseline: PersistedState | null): PersistedState {
  const ls = local.settings
  const rs = remote.settings
  const bs = baseline?.settings
  // History is append-only, so newly recorded events on other devices should be
  // preserved — but a local CLEAR_HISTORY (or capacity trim) must still win, so
  // baseline-known events aren't resurrected. Re-sort newest-first and cap.
  const history = mergeByKey(local.history, remote.history, baseline?.history, (e) => e.id)
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_CAP)
  // Archived usage tallies are append-only like history: preserve tallies saved
  // on another device, but let a local reset/clear win over the baseline. The
  // live running total (currentG/since) is per-shared-doc last-write-wins.
  const localUsage = local.usage ?? defaultUsage()
  // The Pi tracks filament consumption server-side and writes it straight to the
  // database, bumping `usage.currentG` and decrementing spool grams while a
  // browser may be holding stale values. A plain local-wins save would clobber
  // that server progress. So we fold in the server's DELTA since our baseline:
  //   merged = local + (remote_since_baseline - baseline)
  // which preserves background consumption yet still lets an explicit local edit
  // (loading a spool, manually setting weight, resetting usage) win, because
  // those change the local value independently of the server delta.
  const usageDelta = Math.max(0, (remote.usage?.currentG ?? 0) - (baseline?.usage?.currentG ?? 0))
  const usage: FilamentUsage = {
    ...localUsage,
    // Only apply the running-total delta when we didn't locally reset (a reset
    // sets currentG below baseline); otherwise honor the local value + server delta.
    currentG:
      localUsage.currentG < (baseline?.usage?.currentG ?? 0)
        ? localUsage.currentG
        : localUsage.currentG + usageDelta,
    archived: mergeByKey(localUsage.archived, remote.usage?.archived, baseline?.usage?.archived, (a) => a.id)
      .sort((a, b) => b.to - a.to)
      .slice(0, USAGE_ARCHIVE_CAP),
  }
  // Same idea for spool weights: apply any server-side gram DECREASE since the
  // baseline on top of the local value, so background consumption survives a
  // concurrent local save. A local refill/edit that raises grams still wins.
  // A spool another device CREATED since our baseline must survive our save
  // (it isn't in our map at all, so a plain local-wins spread dropped it — the
  // "I placed a spool and it disappeared" bug seen with two open tabs); a spool
  // WE deleted since baseline stays deleted. Then fold in server consumption.
  const spools = mergeServerConsumption(
    mergeRecordByKey(local.spools, remote.spools, baseline?.spools),
    remote.spools,
    baseline?.spools,
  )
  // Same protection for where spools physically are: only cells this device did
  // not touch adopt the other device's value.
  const nodes = mergeNodeSlots(local.nodes, remote.nodes, baseline?.nodes)
  // Consumption buckets and daily storage snapshots are append-mostly records
  // written by the server (and any device); preserve entries from other devices.
  const consumptionLog = mergeConsumptionLog(local.consumptionLog, remote.consumptionLog)
  const storageSnapshots = mergeByKey(
    local.storageSnapshots,
    remote.storageSnapshots,
    baseline?.storageSnapshots,
    (s) => s.day,
  )
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-STORAGE_SNAPSHOT_CAP)
  // Hardware parts: a keyed map like spools but with no server-side background
  // mutation, so local wins for keys we already know and we only fold in parts
  // another device ADDED since our baseline (mirrors mergeByKey's delete-safe
  // rule so a locally-removed part isn't resurrected).
  const parts = mergeRecordByKey(local.parts, remote.parts, baseline?.parts)
  const hardwareOrders = mergeByKey(local.hardwareOrders, remote.hardwareOrders, baseline?.hardwareOrders, (o) => o.id)
  const hwPickLists = mergeByKey(
    local.hwPickLists ?? [],
    remote.hwPickLists ?? [],
    baseline?.hwPickLists ?? [],
    (l) => l.id,
  )
  // Dispense requests are keyed like orders: a request another device (or the
  // printer API) ADDED since baseline must survive our last-write-wins save,
  // while a request WE removed (after completion) stays removed. Local wins on
  // shared keys so our newer status (running/done) is kept. Cap + newest-last.
  const dispenseRequests = mergeByKey(
    local.dispenseRequests,
    remote.dispenseRequests,
    baseline?.dispenseRequests,
    (r) => r.id,
  )
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-DISPENSE_CAP)
  // The shared API token is a scalar edited from any device. Use baseline-diff
  // last-write-wins so a local CHANGE (set, regenerate, or CLEAR to undefined)
  // wins, while an untouched local value adopts whatever another device set.
  // A plain `local ?? remote` would resurrect a cleared token from remote.
  const apiToken = local.apiToken === baseline?.apiToken ? remote.apiToken : local.apiToken
  return {
    ...local,
    nodes,
    spools,
    parts,
    hardwareOrders,
    hwPickLists,
    dispenseRequests,
    apiToken,
    history,
    usage,
    consumptionLog,
    storageSnapshots,
    settings: {
      ...ls,
      hardwareCategories: mergeByKey(
        ls.hardwareCategories,
        rs.hardwareCategories,
        bs?.hardwareCategories,
        (c) => c.id,
      ),
      hardwareColorPresets: mergeByKey(
        ls.hardwareColorPresets,
        rs.hardwareColorPresets,
        bs?.hardwareColorPresets,
        (c) => c.hex.toLowerCase(),
      ),
      hardwareStores: mergeByKey(ls.hardwareStores, rs.hardwareStores, bs?.hardwareStores, (s) => s.id),
      filamentProfiles: mergeByKey(ls.filamentProfiles, rs.filamentProfiles, bs?.filamentProfiles, (p) => p.id),
      barcodes: mergeByKey(ls.barcodes, rs.barcodes, bs?.barcodes, (b) => b.code),
      tagBindings: mergeByKey(ls.tagBindings, rs.tagBindings, bs?.tagBindings, (t) => t.id),
      readers: mergeByKey(ls.readers, rs.readers, bs?.readers, (r) => r.id),
      containers: mergeByKey(ls.containers, rs.containers, bs?.containers, (c) => c.id),
      customMaterials: mergeByKey(ls.customMaterials, rs.customMaterials, bs?.customMaterials, (m) => m),
      customBrands: mergeByKey(ls.customBrands, rs.customBrands, bs?.customBrands, (b) => b),
      orders: mergeByKey(ls.orders, rs.orders, bs?.orders, (o) => o.id),
      stores: mergeByKey(ls.stores, rs.stores, bs?.stores, (s) => s.id),
      customColors: mergeByKey(ls.customColors, rs.customColors, bs?.customColors, (c) => c.hex.toLowerCase()),
    },
  }
}

/** Homing duration (ms) in simulation. */
const HOME_MS = 1300
/**
 * Per-shelf animation step (ms) for SIMULATED nodes only.
 *
 * Cosmetic. Real hardware speed is the PWM duty, and real position comes from
 * homing plus shelf-sensor pulses, so no elapsed-time value is used to decide
 * where a physical carousel is.
 */
const SIM_STEP_MS = 420

// ---------------------------------------------------------------------------
// Initial / default state
// ---------------------------------------------------------------------------

const defaultSettings: Settings = {
  systemName: "PAX System",
  confirmBeforeMove: true,
  confirmBeforeMoveHardware: true,
  defaultSpoolWeight: 1000,
  customMaterials: [],
  customBrands: [],
  containers: [],
  defaultDiameter: 1.75,
  filamentProfiles: [],
  barcodes: [],
  tagBindings: [],
  readers: [],
  orders: [],
  customColors: [],
  showUsageCardOnHome: true,
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

/**
 * Can this unit actually be commanded right now?
 *
 * A hardware node is only drivable while its Pi agent is connected. Without this
 * guard the reducer happily enters "homing"/"moving" on an offline unit, but
 * NodeConnection skips offline nodes so no command is ever sent — the spinner
 * then runs forever and it looks like the app moved a motor that never turned.
 * Simulated nodes run on in-app timers and are always drivable.
 */
function isDrivable(n: StorageNode): boolean {
  return n.driver !== "hardware" || n.link === "online"
}

/**
 * What the Pi's calibration run would report for a simulated unit. Toy
 * mechanics: one sprocket turn per shelf pitch, so a carousel revolution is
 * shelves × (pulses per motor rev × gear ratio). A small, run-to-run error is
 * added so the "Last home pass" correction has something realistic to show.
 */
function simCalibrationResult(n: StorageNode): StorageNode {
  const shelves = Math.max(1, n.storage.shelves)
  const ideal = shelves * (n.servoPulsesPerRev ?? 4000) * (n.servoGearRatio ?? 50)
  const errorPerMille = (Date.now() % 7) - 3
  const pulsesPerRev = Math.round(ideal * (1 + errorPerMille / 1000))
  const indexWindowPulses = Math.max(1, Math.round((pulsesPerRev / shelves) * 0.015))
  const pulsesPerShelf = Math.round(pulsesPerRev / shelves)
  return {
    ...n,
    calibrating: false,
    servoCarouselPulses: pulsesPerRev,
    servoIndexWindowPulses: indexWindowPulses,
    servoCalibratedAt: Date.now(),
    calibration: {
      type: "calibration",
      ok: true,
      pulsesPerRev,
      pulsesPerShelf,
      indexWindowPulses,
      shelfFlagsSeen: shelves,
      shelves,
      lastDriftPulses: null,
      message: `Calibrated (simulated): ${pulsesPerRev.toLocaleString()} pulses per revolution, ${pulsesPerShelf.toLocaleString()} per shelf (${shelves} shelves). Saw ${shelves} shelf flags.`,
    },
  }
}

/** Shelf nodes have no hardware, so their "machine" is permanently homed/idle. */
function shelfMachine(): Machine {
  return { currentShelf: 0, homed: true, status: "idle", targetShelf: null, direction: null, moveFrom: null }
}

const DEFAULT_AGENT_PORT = 8765

let nodeCounter = 0
/**
 * A short, human-friendly pairing code (e.g. "K7QP-2M"). Ambiguous characters
 * (0/O, 1/I/L) are omitted so it's easy to read off a screen and type on the
 * slave. This is the value the slave presents when it phones home.
 */
function makePairingCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  let out = ""
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

function makeNode(opts: {
  name: string
  ip: string
  role: NodeRole
  storage: StorageConfig
  type?: NodeType
  system?: SystemKind
  area?: string
  shelfMeta?: ShelfMeta[]
  driver?: NodeDriver
  port?: number
  motorMode?: MotorMode
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
    system: opts.system ?? "filament",
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
    rampPct: DEFAULT_RAMP_PCT,
    // Manual units have no motor at all; a carousel defaults to the DC bridge
    // unless the wizard / add-node form chose servos.
    motorMode: manual ? undefined : (opts.motorMode ?? "dc"),
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
    parts: {},
    nodes: [master],
    activeNodeId: master.id,
    printers: [],
    activePrinterId: null,
    dispenseRequests: [],
    apiToken: undefined,
    job: null,
    pendingJobs: [],
    history: [],
    usage: defaultUsage(),
    consumptionLog: [],
    storageSnapshots: [],
    hardwareOrders: [],
    hwPickQueue: [],
    hwPickLists: [],
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: "HYDRATE"; state: AppState }
  | {
      type: "SETUP"
      nodeType: NodeType
      system?: SystemKind
      name?: string
      area?: string
      storage: StorageConfig
      shelfMeta?: ShelfMeta[]
      /** Motor drive for the first carousel (ignored for manual units). */
      motorMode?: MotorMode
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
      system?: SystemKind
      ip?: string
      area?: string
      storage: StorageConfig
      shelfMeta?: ShelfMeta[]
      driver?: NodeDriver
      port?: number
      motorMode?: MotorMode
      /** Mark this unit as a real slave to be linked later via a pairing code. */
      pair?: boolean
    }
  | {
      type: "UPDATE_NODE"
      id: string
      changes: Partial<
        Pick<
          StorageNode,
          | "name"
          | "ip"
          | "role"
          | "link"
          | "driver"
          | "port"
          | "area"
          | "shelfMeta"
          | "motorMode"
          | "servoPulsesPerRev"
          | "servoMaxPps"
          | "servoGearRatio"
          | "servoJogPulses"
          | "dcJogMs"
          | "dcTrimPct"
          | "servoMirrorB"
          | "servoSingleMotor"
          | "servoIgnoreAlarm"
          | "servoHoldTimeoutS"
          | "positionMode"
        >
      >
    }
  /** Rebuild a node's shelf/slot layout, preserving spools that still fit. */
  | { type: "RESHAPE_NODE"; id: string; storage: StorageConfig; shelfMeta?: ShelfMeta[] }
  | { type: "REMOVE_NODE"; id: string }
  /** Force a hardware node's WebSocket to close and reopen (manual retry). */
  | { type: "RECONNECT_NODE"; id: string }
  | { type: "SET_MASTER"; id: string }
  | { type: "SET_ACTIVE_NODE"; id: string }
  // Pairing a real slave by code (no IP). See StorageNode.pairStatus.
  /** Issue a fresh pairing code and wait for the slave to check in. */
  | { type: "START_PAIRING"; id: string }
  /** The slave checked in with the code — bind it (mock: id generated here). */
  | { type: "CONFIRM_PAIRING"; id: string; deviceId?: string }
  /** Unlink a paired slave; it returns to "unpaired" awaiting a new code. */
  | { type: "UNPAIR_NODE"; id: string }
  // Hardware bridge (events reported by a real Pi agent over WebSocket)
  | { type: "NODE_LINK"; nodeId: string; link: PrinterLinkStatus; reason?: string }
  | { type: "NODE_AGENT_MODE"; nodeId: string; simulated: boolean; reason?: string }
  | { type: "NODE_POS"; nodeId: string; currentShelf: number }
  | { type: "NODE_SENSOR"; nodeId: string; on: boolean }
  /** Servo drive status from the agent (`servo` frame): alarms + live tuning. */
  | { type: "NODE_SERVO"; nodeId: string; servo: ServoEvent | null }
  /** Pulse calibration report from the agent (`calibration` frame). */
  | { type: "NODE_CALIBRATION"; nodeId: string; calibration: CalibrationEvent }
  /** Calibrate pressed locally; cleared by the agent's answer. */
  | { type: "NODE_CALIBRATING"; nodeId: string; on: boolean }
  | { type: "NODE_BALANCE"; nodeId: string; balance: BalanceEvent | null }
  /**
   * Simulated unit: run the calibration the Pi would — home, one full turn
   * through every shelf, stop at home — and produce a result from the servo
   * settings, so pulse positioning can be tried without hardware.
   */
  | { type: "SIM_CALIBRATE_START"; nodeId: string }
  /** Pulse mode: odometer correction at a home pass (`sync` frame). */
  | { type: "NODE_SYNC"; nodeId: string; driftPulses: number }
  | { type: "NODE_ARRIVED"; nodeId: string; shelf: number }
  | { type: "NODE_HOMED"; nodeId: string; currentShelf?: number }
  | { type: "NODE_FAULT"; nodeId: string; message: string }
  /** Wi-Fi / hotspot picture from the Pi (`net.status`). */
  | { type: "NODE_NET_STATUS"; nodeId: string; status: NetStatusEvent }
  /** Master only: registered slaves (`net.slaves`). */
  | { type: "NODE_NET_SLAVES"; nodeId: string; slaves: NetSlave[] }
  /** Outcome of a net.* op (`net.result`); `null` clears the banner. */
  | { type: "NODE_NET_RESULT"; nodeId: string; result: NetResultEvent | null }
  /** Operator dismissed the position-lost dialog without homing. */
  | { type: "ACK_NODE_FAULT"; nodeId: string }
  /** A real carousel came online un-homed: ask the operator before the first sweep. */
  | { type: "REQUEST_HOMING"; nodeId: string }
  /** Operator chose "Not now" in the homing dialog; keep a sidebar reminder. */
  | { type: "ACK_HOMING_REQUEST"; nodeId: string }
  // Printers
  | { type: "ADD_PRINTER"; printer: Printer }
  | { type: "UPDATE_PRINTER"; id: string; changes: Partial<Printer> }
  | { type: "REMOVE_PRINTER"; id: string }
  | { type: "SET_ACTIVE_PRINTER"; id: string | null }
  // ----- printer dispense queue + API token -----
  /** Add a dispense request (from the printer API or a manual test). */
  | { type: "ENQUEUE_DISPENSE"; request: DispenseRequest }
  /**
   * Atomically mark a pending request "running" AND start its guided pick, in a
   * single commit. Doing both in one action removes any window where a request
   * is "running" with no job (which a reload-safe, state-derived consumer would
   * otherwise misread as an orphan).
   */
  | { type: "START_DISPENSE"; id: string; item: QueueItem }
  /** Advance a request's status/fields as PAX runs or fails the pick. */
  | { type: "UPDATE_DISPENSE"; id: string; changes: Partial<DispenseRequest> }
  /** Drop a single request from the queue. */
  | { type: "REMOVE_DISPENSE"; id: string }
  /** Clear every finished (done/error/canceled) request. */
  | { type: "CLEAR_DISPENSE_DONE" }
  /** Set or clear the shared printer-API token. */
  | { type: "SET_API_TOKEN"; token: string | undefined }
  // Spools
  | { type: "UPSERT_SPOOL"; spool: Spool }
  | { type: "UPDATE_SPOOL"; id: string; changes: Partial<Spool> }
  | { type: "DELETE_SPOOL"; id: string }
  /** Subtract consumed filament (g) from a spool, clamped at 0. */
  | { type: "CONSUME_FILAMENT"; spoolId: string; grams: number }
  | { type: "RESET_FILAMENT_USAGE" }
  /**
   * Upsert a spool auto-created from a Bambu AMS tray (matched by RFID uid) and
   * seat it in the given printer slot. Idempotent: an existing spool with the
   * same `rfidUid` is updated in place rather than duplicated.
   */
  | { type: "INGEST_AMS_TRAY"; printerId: string; slot: number; spool: Spool }
  // Filament profiles
  | { type: "ADD_PROFILE"; profile: FilamentProfile }
  | { type: "REMOVE_PROFILE"; id: string }
  // Saved custom colors (reusable swatches in the spool editor)
  | { type: "ADD_CUSTOM_COLOR"; color: { name: string; hex: string } }
  | { type: "REMOVE_CUSTOM_COLOR"; hex: string }
  // Barcode → profile mappings
  | { type: "ADD_BARCODE"; code: string; profileId: string }
  | { type: "REMOVE_BARCODE"; code: string }
  // RFID / QR tag bindings (bind a tag id to a spool, shelf, or printer slot)
  | { type: "BIND_TAG"; binding: TagBinding }
  /** Remove a tag binding by id, clearing a spool's `tagId` if it pointed there. */
  | { type: "UNBIND_TAG"; id: string }
  // Wireless RFID/NFC readers (ESP32 / Pi)
  | { type: "ADD_READER"; reader: RfidReader }
  | { type: "UPDATE_READER"; id: string; changes: Partial<Pick<RfidReader, "name">> }
  | { type: "REMOVE_READER"; id: string }
  // Incoming orders / carts
  | { type: "ADD_ORDER"; order: FilamentOrder }
  | { type: "RENAME_ORDER"; id: string; name: string }
  | { type: "REMOVE_ORDER"; id: string }
  | { type: "ADD_ORDER_ITEM"; orderId: string; item: OrderItem }
  | { type: "REMOVE_ORDER_ITEM"; orderId: string; itemId: string }
  | { type: "ADD_STORE"; store: OrderStore }
  | { type: "UPDATE_STORE"; id: string; changes: Partial<Omit<OrderStore, "id">> }
  | { type: "REMOVE_STORE"; id: string }
  | { type: "RECORD_STORAGE_SNAPSHOT"; snapshot: StorageSnapshot }
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
  /** Immediately halt a carousel mid-motion (paternoster e-stop). */
  | { type: "EMERGENCY_STOP"; nodeId: string }
  /** Resume exactly what an emergency-stopped carousel was doing. */
  | { type: "RESUME_MOVE"; nodeId: string }
  | { type: "GOTO_SHELF"; nodeId: string; shelf: number }
  | { type: "MOVE_TICK"; nodeId: string }
  | { type: "ARRIVED"; nodeId: string }
  | { type: "CONFIRM_MOVE"; nodeId: string }

  // ----- hardware area -----
  /** Set the currently-shown tracking area (filament vs hardware). */
  | { type: "SET_ACTIVE_AREA"; area: SystemKind }
  /** Create or replace a hardware part record. */
  | { type: "UPSERT_PART"; part: HardwarePart }
  /** Delete a part and clear whatever slot it occupied. */
  | { type: "REMOVE_PART"; id: string }
  /** Add pieces to an existing part box (weight follows the new count). */
  | { type: "HW_STORE_MORE"; partId: string; addCount: number }
  /**
   * Take pieces out of a part box. Clamped to what's available; when the box
   * empties completely the part is removed and its slot is freed.
   */
  | { type: "HW_TAKE"; partId: string; takeCount: number }
  | { type: "PICKLIST_UPSERT"; list: PickList }
  | { type: "PICKLIST_DELETE"; id: string }
  | { type: "PICKLIST_RECORD"; listId: string; lineId: string; count: number }
  /** User answered the "everything picked" prompt with "keep the list". */
  | { type: "PICKLIST_RESOLVE_DONE"; id: string }
  // Hardware take-out queue (assemble first, run as one job). See AppState.hwPickQueue.
  | { type: "HW_QUEUE_TAKE_ADD"; partId: string }
  | { type: "HW_QUEUE_TAKE_REMOVE"; partId: string }
  | { type: "HW_QUEUE_TAKE_CLEAR" }
  // Hardware categories + color presets (saved lists for the add-part form)
  | { type: "ADD_HW_CATEGORY"; category: HardwareCategory }
  | { type: "REMOVE_HW_CATEGORY"; id: string }
  | { type: "ADD_HW_COLOR"; color: { name: string; hex: string } }
  | { type: "REMOVE_HW_COLOR"; hex: string }
  // Hardware orders / carts (qty-based, mirror filament orders)
  | { type: "ADD_HW_ORDER"; order: HardwareOrder }
  | { type: "RENAME_HW_ORDER"; id: string; name: string }
  | { type: "REMOVE_HW_ORDER"; id: string }
  | { type: "ADD_HW_ORDER_ITEM"; orderId: string; item: HardwareOrderItem }
  | { type: "REMOVE_HW_ORDER_ITEM"; orderId: string; itemId: string }
  | { type: "ADD_HW_STORE"; store: OrderStore }
  | { type: "REMOVE_HW_STORE"; id: string }

  | { type: "SET_NODE_RAMP"; nodeId: string; rampPct: number }
  | { type: "SET_NODE_PWM"; nodeId: string; pwmDuty: number }
  // `undefined` = clear the override, letting homing track the move duty again.
  | { type: "SET_NODE_HOMING_PWM"; nodeId: string; homingDuty: number | undefined }
  | { type: "SET_NODE_APPROACH_PWM"; nodeId: string; approachDuty: number | undefined }
  /** Weight compensation: kg of load per +1% speed (0.5–10). `undefined` = off. */
  | { type: "SET_NODE_LOAD_COMP"; nodeId: string; loadCompKg: number | undefined }
  /** Weight compensation: percent of speed added per `loadCompKg` step (1–10). */
  | { type: "SET_NODE_LOAD_COMP_PCT"; nodeId: string; loadCompPct: number }
  /**
   * Move one unit to sit just before `beforeId` (or to the end when null).
   * Used by the drag-to-reorder tab strips; the order of `state.nodes` IS the
   * tab order, and it persists like any other node edit.
   */
  | { type: "REORDER_NODES"; id: string; beforeId: string | null }
  /**
   * At the placing prompt the operator says the offered slot will not fit.
   * Remember it as rejected for this item, choose another slot (never one
   * rejected before), and re-drive the carousel there. Filament store/place only.
   */
  | { type: "REJECT_STORE_SLOT" }
  /**
   * Operator's way out when every offered slot was rejected: send the current
   * store item to a specific unit (a library is allowed here because the user
   * named it), or create a new library and send it there.
   */
  | { type: "RETARGET_STORE_ITEM"; nodeId: string }
  | { type: "RETARGET_STORE_ITEM"; newLibraryName: string }
  // Jobs
  | { type: "START_JOB"; job: ActiveJob }
  /** Queue several jobs to run back-to-back (first runs now, rest wait). */
  | { type: "START_JOBS"; jobs: ActiveJob[] }
  /**
   * Add one more stop to an operation already in flight (used by the hardware
   * "+" so parts can be queued mid-run, like the filament tray). If a job of the
   * same mode is running the item is appended to it; a different mode chains as
   * its own job; nothing running starts a fresh job.
   */
  | { type: "ENQUEUE_JOB_ITEM"; item: QueueItem; mode: QueueMode }
  /**
   * `storeCount` (hardware place/store stops only): how many pieces actually
   * fit in this slot. When it is less than the item's full count, the rest is
   * split off and queued to another box of the same part (locked boxes first)
   * or a fresh slot.
   */
  | { type: "CONFIRM_STOP"; grams?: number; takeCount?: number; storeCount?: number; index?: number }
  | { type: "MAKE_TWIN"; id: string }
  | { type: "UNTWIN"; id: string }
  /**
   * Correct a mix-up between physically identical spools: the operator scanned a
   * spool other than the one the current stop expected. Swaps which spool id the
   * current stop and the scanned spool's queued stop each carry, so the spool in
   * the operator's hand goes into the current slot and the plan stays consistent.
   */
  | { type: "SWAP_JOB_SPOOL"; scannedSpoolId: string }
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

/** Weight the carousel must balance for a part box: pieces × per-piece grams. */
export function partWeight(part: HardwarePart): number {
  return Math.max(0, part.count) * Math.max(0, part.perPieceWeightGrams)
}

/** Find which node/shelf/slot an occupant id currently sits in, if any. */
function findOccupantLocation(
  state: AppState,
  id: string,
): { nodeId: string; shelf: number; slot: number } | null {
  for (const n of state.nodes) {
    for (let s = 0; s < n.slots.length; s++) {
      const row = n.slots[s] ?? []
      for (let slot = 0; slot < row.length; slot++) {
        if (row[slot] === id) return { nodeId: n.id, shelf: s, slot }
      }
    }
  }
  return null
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
  // Each area has its own safety gate. Hardware falls back to the filament flag
  // for saves made before the per-area setting existed.
  const confirmSetting =
    node.system === "hardware"
      ? (state.settings.confirmBeforeMoveHardware ?? state.settings.confirmBeforeMove)
      : state.settings.confirmBeforeMove
  const needsConfirm = serviced && confirmSetting
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
  const twinItem = job?.twinIndex != null ? job.items[job.twinIndex] : undefined
  const isServicing =
    (!!current && current.nodeId === nodeId) || (!!twinItem && !twinItem.done && twinItem.nodeId === nodeId)
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

/**
 * Move the current store item (a spool) to a fresh slot, preferring
 * `preferredNodeId`. `rejected` is the full list of slots the operator has
 * turned down; it is written back onto the item so none is offered again. If
 * nothing is free the item is left where it is with the rejections recorded.
 */
function retargetCurrentStoreItem(
  state: AppState,
  rejected: { nodeId: string; shelf: number; slot: number }[],
  preferredNodeId: string,
): AppState {
  const job = state.job
  if (!job) return state
  const item = job.items[job.currentIndex]
  if (!item) return state
  const spool = state.spools[item.spoolId]
  if (!spool) return state
  // Never land on a slot another queued item is heading for either.
  const reservedByOthers = job.items
    .filter((it, i) => i !== job.currentIndex && !it.done)
    .map((it) => ({ nodeId: it.nodeId, shelf: it.shelf, slot: it.slot }))
  const dest = pickFilamentDestination(
    state,
    item.grams ?? spool.grams,
    [...rejected, ...reservedByOthers],
    preferredNodeId,
    spool.containerId,
  )
  const retargeted: QueueItem = dest
    ? { ...item, nodeId: dest.nodeId, shelf: dest.shelf, slot: dest.slot, rejectedSlots: rejected }
    : { ...item, rejectedSlots: rejected }
  const items = job.items.map((it, i) => (i === job.currentIndex ? retargeted : it))
  const withJob: AppState = { ...state, job: { ...job, items } }
  if (!dest) return withJob
  // Same shelf on the same unit → just a different slot; the carousel is
  // already there, so stay at the confirm step. Otherwise park this unit and
  // rotate (or, for a shelf/library, arrive instantly) at the new one.
  const sameStop = dest.nodeId === item.nodeId && dest.shelf === item.shelf
  if (sameStop) return withJob
  const parked = withNode(withJob, item.nodeId, (n) => ({
    ...n,
    machine: { ...n.machine, status: "idle", targetShelf: null, direction: null, moveFrom: null },
  }))
  return serviceCurrentItem(parked)
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
  next = normalizeTwin(next)
  next = prefetchOtherNodes(next)
  return next
}

/** The other half of a twin pair: same Pi (ip:port + driver), opposite side. */
export function twinSiblingOf(state: AppState, node: StorageNode): StorageNode | undefined {
  if (!node.twinSide || node.system !== "hardware") return undefined
  return state.nodes.find(
    (n) =>
      n.id !== node.id &&
      n.system === "hardware" &&
      !!n.twinSide &&
      n.twinSide !== node.twinSide &&
      n.ip === node.ip &&
      n.port === node.port &&
      n.driver === node.driver,
  )
}

function rotationDistance(from: number, to: number, shelves: number): number {
  if (shelves <= 0) return 0
  const d = (((to - from) % shelves) + shelves) % shelves
  return Math.min(d, shelves - d)
}

/** Undone item on `node` closest (in shelves turned) to where it is now. */
function nearestItemOn(job: ActiveJob, node: StorageNode, exclude: Set<number>): number | undefined {
  let best: number | undefined
  let bestDist = Number.POSITIVE_INFINITY
  job.items.forEach((it, i) => {
    if (it.done || exclude.has(i) || it.nodeId !== node.id) return
    const d = rotationDistance(node.machine.currentShelf, it.shelf, node.storage.shelves)
    if (d < bestDist) {
      best = i
      bestDist = d
    }
  })
  return best
}

/**
 * Keep the twin sibling of the current stop busy: if it has queued stops of its
 * own, give it the nearest one and start rotating so both sides of the pair
 * work at the same time instead of one waiting for the other.
 */
function normalizeTwin(state: AppState): AppState {
  const job = state.job
  if (!job) return state
  const primary = job.items[job.currentIndex]
  const pNode = primary ? getNode(state, primary.nodeId) : undefined
  const sib = pNode ? twinSiblingOf(state, pNode) : undefined
  const clear = (): AppState => (job.twinIndex == null ? state : { ...state, job: { ...job, twinIndex: undefined } })
  if (!sib) return clear()
  const ti = job.twinIndex
  if (ti != null && ti !== job.currentIndex && job.items[ti] && !job.items[ti].done && job.items[ti].nodeId === sib.id) {
    return state
  }
  const idx = nearestItemOn(job, sib, new Set([job.currentIndex]))
  if (idx == null) return clear()
  const next: AppState = { ...state, job: { ...job, twinIndex: idx } }
  const s = getNode(next, sib.id)!
  if (s.machine.status !== "idle" && s.machine.status !== "moving") return next
  return beginNodeMoveTo(next, sib.id, job.items[idx].shelf, true)
}

/**
 * A carousel that lost its position keeps the running job and the queue behind
 * it. Once homing re-establishes where it is, pick the job back up: if the
 * interrupted stop is on this unit, head there again (through the normal
 * confirm-before-rotate gate); otherwise just pre-position it for its next stop.
 */
function resumeJobAfterHoming(state: AppState, nodeId: string): AppState {
  const job = state.job
  if (!job) return state
  const current = job.items[job.currentIndex]
  if (!current || current.done) return state
  if (current.nodeId === nodeId) return serviceCurrentItem(state)
  const twinItem = job.twinIndex != null ? job.items[job.twinIndex] : undefined
  if (twinItem && !twinItem.done && twinItem.nodeId === nodeId) {
    return beginNodeMoveTo(state, nodeId, twinItem.shelf, true)
  }
  return prefetchOtherNodes(normalizeTwin(state))
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
  if (job.twinIndex != null && job.items[job.twinIndex]) handled.add(job.items[job.twinIndex].nodeId)
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
    case "HYDRATE": {
      // A hydrate carries the SHARED document, which deliberately omits this
      // device's live state: `toPersisted` blanks it and `migrate` rebuilds every
      // hardware node as `link: "offline"` with idle motion fields.
      //
      // So a blind `return action.state` on every sync poll broke hardware twice:
      //   1. It reset `link` to "offline" even while the relay socket was live.
      //      The relay only broadcasts `link` frames on CHANGE, so it never
      //      re-sent "online" — the unit stayed stuck offline forever and every
      //      command was silently skipped, while the server was talking to the Pi
      //      perfectly well.
      //   2. It snapped motion fields to idle mid-move, so a rotation jumped to
      //      its destination instantly instead of animating.
      //
      // Carry both over from the node we already have. On first load there are no
      // existing nodes, so this is a no-op and the document applies as-is.
      const prev = new Map(state.nodes.map((n) => [n.id, n]))
      return {
        ...action.state,
        nodes: action.state.nodes.map((n) => {
          const old = prev.get(n.id)
          if (!old) return n
          // Mid-motion locally? Keep the live machine so the animation survives.
          const keepMotion = old.machine.status !== "idle"
          // `homed`, `fault` and `homingRequest` are THIS device's runtime
          // knowledge of the carousel, never shared truth: `toPersisted` always
          // writes `homed: true`, so adopting the incoming value would mark a
          // never-homed hardware unit as homed the moment another tab saved —
          // silently dismissing the first-time homing request (or a fault) and
          // letting absolute moves run on a carousel that has no idea where it
          // is. A genuine home is still heard from the Pi via NODE_HOMED.
          // Simulated units keep following the shared flag as before.
          const keepRuntime = n.driver === "hardware" && !keepMotion
          return {
            ...n,
            link: old.link,
            linkError: old.linkError,
            connSeq: old.connSeq,
            agentSimulated: old.agentSimulated,
            agentSimReason: old.agentSimReason,
            net: old.net,
            netSlaves: old.netSlaves,
            netResult: old.netResult,
            servo: old.servo,
            machine: keepMotion
              ? old.machine
              : keepRuntime
                ? {
                    ...n.machine,
                    homed: old.machine.homed,
                    fault: old.machine.fault,
                    homingRequest: old.machine.homingRequest,
                    sensor: old.machine.sensor,
                  }
                : n.machine,
          }
        }),
      }
    }

    case "SETUP": {
      const base = makeInitialState()
      const defaultName = action.nodeType === "shelf" ? "Shelf Storage 1" : "Paternoster 1"
      const master = makeNode({
        name: action.name?.trim() || defaultName,
        ip: "127.0.0.1",
        role: "master",
        type: action.nodeType,
        system: action.system ?? "filament",
        area: action.area,
        shelfMeta: action.shelfMeta,
        storage: action.storage,
        motorMode: action.motorMode,
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
        system: action.system ?? "filament",
        area: action.area,
        shelfMeta: action.shelfMeta,
        storage: action.storage,
        driver: action.driver,
        port: action.port,
        motorMode: action.motorMode,
      })
      // A real slave linked by code starts "unpaired"; it runs on the simulated
      // driver until (and after) a real agent phones home, so the app never
      // tries to reach a fixed IP for it.
      if (action.pair) node.pairStatus = "unpaired"
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

    case "RECONNECT_NODE":
      // Bump an ephemeral counter and flip the link to "checking" so the
      // NodeConnection effect (which keys off connSeq) tears down and reopens the
      // socket. Only meaningful for hardware nodes; a no-op for simulated ones.
      return withNode(state, action.id, (n) =>
        n.driver === "hardware" ? { ...n, connSeq: (n.connSeq ?? 0) + 1, link: "checking" } : n,
      )

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

    case "START_PAIRING":
      return withNode(state, action.id, (n) => ({
        ...n,
        pairStatus: "pairing",
        pairingCode: makePairingCode(),
        deviceId: undefined,
      }))

    case "CONFIRM_PAIRING":
      return withNode(state, action.id, (n) => ({
        ...n,
        pairStatus: "paired",
        pairingCode: undefined,
        // In the real flow the slave reports its own hardware id; the mock
        // generates a stable-looking one so the UI has something to show.
        deviceId: action.deviceId ?? `slave-${Math.random().toString(36).slice(2, 8)}`,
      }))

    case "UNPAIR_NODE":
      return withNode(state, action.id, (n) => ({
        ...n,
        pairStatus: "unpaired",
        pairingCode: undefined,
        deviceId: undefined,
      }))

    // ----- hardware area -----
    case "SET_ACTIVE_AREA": {
      // Focus the new area's first unit so activeNode() always resolves to a
      // node in the area currently on screen (the two areas share activeNodeId).
      const firstInArea = state.nodes.find((n) => (n.system === "hardware" ? "hardware" : "filament") === action.area)
      return {
        ...state,
        settings: { ...state.settings, activeArea: action.area },
        activeNodeId: firstInArea ? firstInArea.id : state.activeNodeId,
      }
    }

    case "UPSERT_PART":
      return { ...state, parts: { ...state.parts, [action.part.id]: action.part } }

    case "REMOVE_PART": {
      if (!state.parts[action.id]) return state
      const parts = { ...state.parts }
      delete parts[action.id]
      // Also clear whatever slot the box occupied so the unit shows it as free.
      const nodes = state.nodes.map((n) => ({
        ...n,
        slots: n.slots.map((row) => row.map((s) => (s === action.id ? null : s))),
      }))
      return { ...state, parts, nodes }
    }

    case "HW_STORE_MORE": {
      const part = state.parts[action.partId]
      if (!part || action.addCount <= 0) return state
      const count = part.count + Math.floor(action.addCount)
      return { ...state, parts: { ...state.parts, [action.partId]: { ...part, count } } }
    }

    case "HW_TAKE": {
      const part = state.parts[action.partId]
      if (!part || action.takeCount <= 0) return state
      const count = Math.max(0, part.count - Math.floor(action.takeCount))
      if (count <= 0 && !part.lockedSlot) {
        // The box is now empty: remove the part and free its slot. A locked box
        // instead stays put at 0 pcs so the slot keeps waiting for new stock.
        const parts = { ...state.parts }
        delete parts[action.partId]
        const nodes = state.nodes.map((n) => ({
          ...n,
          slots: n.slots.map((row) => row.map((s) => (s === action.partId ? null : s))),
        }))
        return { ...state, parts, nodes }
      }
      return { ...state, parts: { ...state.parts, [action.partId]: { ...part, count } } }
    }

    case "HW_QUEUE_TAKE_ADD": {
      // Ignore unknown parts and no-op duplicate adds so the queue stays clean.
      if (!state.parts[action.partId] || state.hwPickQueue.includes(action.partId)) return state
      return { ...state, hwPickQueue: [...state.hwPickQueue, action.partId] }
    }

    case "HW_QUEUE_TAKE_REMOVE":
      return { ...state, hwPickQueue: state.hwPickQueue.filter((id) => id !== action.partId) }

    case "HW_QUEUE_TAKE_CLEAR":
      return { ...state, hwPickQueue: [] }

    case "ADD_HW_CATEGORY": {
      const name = action.category.name.trim()
      if (!name) return state
      const current = state.settings.hardwareCategories ?? []
      if (current.some((c) => c.name.toLowerCase() === name.toLowerCase())) return state
      return {
        ...state,
        settings: { ...state.settings, hardwareCategories: [...current, { ...action.category, name }] },
      }
    }

    case "REMOVE_HW_CATEGORY": {
      const current = state.settings.hardwareCategories ?? []
      return {
        ...state,
        settings: { ...state.settings, hardwareCategories: current.filter((c) => c.id !== action.id) },
      }
    }

    case "ADD_HW_COLOR": {
      const current = state.settings.hardwareColorPresets ?? []
      if (current.some((c) => c.hex.toLowerCase() === action.color.hex.toLowerCase())) return state
      return { ...state, settings: { ...state.settings, hardwareColorPresets: [...current, action.color] } }
    }

    case "REMOVE_HW_COLOR": {
      const current = state.settings.hardwareColorPresets ?? []
      return {
        ...state,
        settings: {
          ...state.settings,
          hardwareColorPresets: current.filter((c) => c.hex.toLowerCase() !== action.hex.toLowerCase()),
        },
      }
    }

    // --- Hardware picking lists ------------------------------------------------
    case "PICKLIST_UPSERT": {
      const lists = state.hwPickLists ?? []
      const exists = lists.some((l) => l.id === action.list.id)
      const stamped = { ...action.list, updatedAt: Date.now() }
      return {
        ...state,
        hwPickLists: exists ? lists.map((l) => (l.id === stamped.id ? stamped : l)) : [...lists, stamped],
      }
    }
    case "PICKLIST_DELETE":
      return { ...state, hwPickLists: (state.hwPickLists ?? []).filter((l) => l.id !== action.id) }
    case "PICKLIST_RECORD": {
      // Add what was actually taken to the row; when that completes the whole
      // list, raise the keep/remove prompt (unless the user already kept it).
      return {
        ...state,
        hwPickLists: (state.hwPickLists ?? []).map((l) => {
          if (l.id !== action.listId) return l
          const lines = l.lines.map((ln) =>
            ln.id === action.lineId ? { ...ln, picked: Math.max(0, ln.picked + Math.floor(action.count)) } : ln,
          )
          const allDone = lines.length > 0 && lines.every((ln) => ln.picked >= ln.requested)
          return {
            ...l,
            lines,
            updatedAt: Date.now(),
            donePromptPending: allDone && !l.keptAfterDone ? true : l.donePromptPending,
          }
        }),
      }
    }
    case "PICKLIST_RESOLVE_DONE":
      return {
        ...state,
        hwPickLists: (state.hwPickLists ?? []).map((l) =>
          l.id === action.id ? { ...l, donePromptPending: false, keptAfterDone: true } : l,
        ),
      }

    case "ADD_HW_ORDER":
      return { ...state, hardwareOrders: [...state.hardwareOrders, action.order] }

    case "RENAME_HW_ORDER":
      return {
        ...state,
        hardwareOrders: state.hardwareOrders.map((o) =>
          o.id === action.id ? { ...o, name: action.name } : o,
        ),
      }

    case "REMOVE_HW_ORDER":
      return { ...state, hardwareOrders: state.hardwareOrders.filter((o) => o.id !== action.id) }

    case "ADD_HW_ORDER_ITEM":
      return {
        ...state,
        hardwareOrders: state.hardwareOrders.map((o) =>
          o.id === action.orderId ? { ...o, items: [...o.items, action.item] } : o,
        ),
      }

    case "REMOVE_HW_ORDER_ITEM":
      return {
        ...state,
        hardwareOrders: state.hardwareOrders.map((o) =>
          o.id === action.orderId ? { ...o, items: o.items.filter((it) => it.id !== action.itemId) } : o,
        ),
      }

    case "ADD_HW_STORE": {
      const current = state.settings.hardwareStores ?? []
      return { ...state, settings: { ...state.settings, hardwareStores: [...current, action.store] } }
    }

    case "REMOVE_HW_STORE": {
      const current = state.settings.hardwareStores ?? []
      return {
        ...state,
        settings: { ...state.settings, hardwareStores: current.filter((s) => s.id !== action.id) },
      }
    }

    // ----- printers -----
    case "ADD_PRINTER": {
      // normalizePrinter keeps the mixed-AMS array and legacy fields in step and
      // sizes the loaded array to the true slot count.
      const printers = [...state.printers, normalizePrinter(action.printer)]
      return { ...state, printers, activePrinterId: state.activePrinterId ?? action.printer.id }
    }

    case "UPDATE_PRINTER": {
      const printers = state.printers.map((p) => {
        if (p.id !== action.id) return p
        // Re-normalise after the edit so changing AMS units (count, sizes) or
        // kind rebuilds `ams`/`amsUnits`/`slotsPerAms` and preserves as many
        // loaded spools as still fit.
        return normalizePrinter({ ...p, ...action.changes })
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

    // ----- printer dispense queue -----
    case "ENQUEUE_DISPENSE": {
      // De-dupe by id (a resync could replay one) and cap the list.
      const without = state.dispenseRequests.filter((r) => r.id !== action.request.id)
      return { ...state, dispenseRequests: [...without, action.request].slice(-DISPENSE_CAP) }
    }

    case "START_DISPENSE": {
      // Never start on top of a running operation.
      if (state.job) return state
      const dispenseRequests = state.dispenseRequests.map((r) =>
        r.id === action.id
          ? { ...r, status: "running" as const, spoolId: action.item.spoolId, updatedAt: Date.now() }
          : r,
      )
      // Same launch path as START_JOBS so the carousel actually begins moving.
      const withJob = {
        ...state,
        dispenseRequests,
        job: { mode: "pick" as const, items: [action.item], currentIndex: 0 },
      }
      return serviceCurrentItem(withJob)
    }

    case "UPDATE_DISPENSE": {
      const dispenseRequests = state.dispenseRequests.map((r) =>
        r.id === action.id ? { ...r, ...action.changes, updatedAt: Date.now() } : r,
      )
      return { ...state, dispenseRequests }
    }

    case "REMOVE_DISPENSE":
      return { ...state, dispenseRequests: state.dispenseRequests.filter((r) => r.id !== action.id) }

    case "CLEAR_DISPENSE_DONE":
      return {
        ...state,
        dispenseRequests: state.dispenseRequests.filter((r) => r.status === "pending" || r.status === "running"),
      }

    case "SET_API_TOKEN":
      return { ...state, apiToken: action.token || undefined }

    // ----- spools -----
    case "UPSERT_SPOOL": {
      const spools = { ...state.spools, [action.spool.id]: action.spool }
      // If the spool carries a tag id (e.g. a QR minted during creation) and it
      // isn't bound yet, register the binding now so the printed code resolves.
      const tagId = action.spool.tagId
      let settings = state.settings
      if (tagId && !(state.settings.tagBindings ?? []).some((b) => b.id === tagId)) {
        const binding: TagBinding = {
          id: tagId,
          target: { kind: "spool", spoolId: action.spool.id },
          boundAt: Date.now(),
          via: tagId.startsWith("PAX:") ? "qr" : "nfc",
        }
        settings = { ...state.settings, tagBindings: [...(state.settings.tagBindings ?? []), binding] }
      }
      return { ...state, spools, settings }
    }

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
      // Track every extruded gram against the lifetime usage counter, even if the
      // spool's own remaining weight is already at zero — the printer still used
      // that filament.
      const usage: FilamentUsage = {
        ...(state.usage ?? defaultUsage()),
        currentG: (state.usage?.currentG ?? 0) + action.grams,
      }
      const grams = Math.max(0, existing.grams - action.grams)
      const spools =
        grams === existing.grams ? state.spools : { ...state.spools, [action.spoolId]: { ...existing, grams } }
      return { ...state, spools, usage }
    }

    case "RESET_FILAMENT_USAGE": {
      const usage = state.usage ?? defaultUsage()
      const now = Date.now()
      // Archive the finished tally (only if it actually recorded something) so the
      // lifetime total is never lost, then start a fresh counter.
      const archived =
        usage.currentG > 0
          ? [{ id: newId(), grams: usage.currentG, from: usage.since, to: now }, ...usage.archived].slice(
              0,
              USAGE_ARCHIVE_CAP,
            )
          : usage.archived
      return { ...state, usage: { currentG: 0, since: now, archived } }
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

    // ----- saved custom colors -----
    case "ADD_CUSTOM_COLOR": {
      const hex = action.color.hex.trim().toLowerCase()
      if (!/^#[0-9a-f]{6}$/.test(hex)) return state
      const list = (state.settings.customColors ?? []).filter((c) => c.hex.toLowerCase() !== hex)
      return {
        ...state,
        settings: {
          ...state.settings,
          customColors: [...list, { name: action.color.name.trim() || hex, hex }],
        },
      }
    }

    case "REMOVE_CUSTOM_COLOR": {
      const hex = action.hex.toLowerCase()
      const list = state.settings.customColors ?? []
      return {
        ...state,
        settings: { ...state.settings, customColors: list.filter((c) => c.hex.toLowerCase() !== hex) },
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

    // ----- RFID / QR tag bindings -----
    case "BIND_TAG": {
      const { binding } = action
      // A tag id maps to exactly one target: replace any existing binding for
      // this id (overwrite/rebind), and drop any OTHER binding that pointed at
      // this same spool so a spool never carries two tags at once.
      const others = (state.settings.tagBindings ?? []).filter((b) => {
        if (b.id === binding.id) return false
        if (binding.target.kind === "spool" && b.target.kind === "spool" && b.target.spoolId === binding.target.spoolId)
          return false
        return true
      })
      const tagBindings = [...others, binding]
      // Keep the spool's own `tagId` in sync so its QR/Edit affordance resolves.
      let spools = state.spools
      if (binding.target.kind === "spool") {
        const spool = state.spools[binding.target.spoolId]
        if (spool && spool.tagId !== binding.id) {
          spools = { ...state.spools, [binding.target.spoolId]: { ...spool, tagId: binding.id } }
        }
        // Clear tagId off whatever spool previously wore this id.
        for (const b of state.settings.tagBindings ?? []) {
          if (b.id === binding.id && b.target.kind === "spool" && b.target.spoolId !== binding.target.spoolId) {
            const prev = spools[b.target.spoolId]
            if (prev?.tagId === binding.id) spools = { ...spools, [b.target.spoolId]: { ...prev, tagId: undefined } }
          }
        }
      }
      return { ...state, spools, settings: { ...state.settings, tagBindings } }
    }

    case "UNBIND_TAG": {
      const list = state.settings.tagBindings ?? []
      const removed = list.find((b) => b.id === action.id)
      const tagBindings = list.filter((b) => b.id !== action.id)
      let spools = state.spools
      if (removed?.target.kind === "spool") {
        const spool = state.spools[removed.target.spoolId]
        if (spool?.tagId === action.id) {
          spools = { ...state.spools, [removed.target.spoolId]: { ...spool, tagId: undefined } }
        }
      }
      return { ...state, spools, settings: { ...state.settings, tagBindings } }
    }

    // ----- wireless RFID/NFC readers -----
    case "ADD_READER":
      return {
        ...state,
        settings: { ...state.settings, readers: [...(state.settings.readers ?? []), action.reader] },
      }

    case "UPDATE_READER": {
      const name = action.changes.name?.trim()
      return {
        ...state,
        settings: {
          ...state.settings,
          readers: (state.settings.readers ?? []).map((r) =>
            r.id === action.id ? { ...r, ...(name ? { name } : {}) } : r,
          ),
        },
      }
    }

    case "REMOVE_READER":
      return {
        ...state,
        settings: { ...state.settings, readers: (state.settings.readers ?? []).filter((r) => r.id !== action.id) },
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

    case "ADD_STORE": {
      const stores = [...(state.settings.stores ?? []), action.store]
      return { ...state, settings: { ...state.settings, stores } }
    }

    case "UPDATE_STORE": {
      const stores = (state.settings.stores ?? []).map((s) =>
        s.id === action.id ? { ...s, ...action.changes } : s,
      )
      return { ...state, settings: { ...state.settings, stores } }
    }

    case "REMOVE_STORE": {
      const stores = (state.settings.stores ?? []).filter((s) => s.id !== action.id)
      // Detach the deleted store from any orders that referenced it.
      const orders = (state.settings.orders ?? []).map((o) =>
        o.storeId === action.id ? { ...o, storeId: undefined } : o,
      )
      return { ...state, settings: { ...state.settings, stores, orders } }
    }

    case "RECORD_STORAGE_SNAPSHOT": {
      // One snapshot per calendar day: replace today's if it already exists,
      // otherwise append, and cap the retained history oldest-first.
      const rest = (state.storageSnapshots ?? []).filter((s) => s.day !== action.snapshot.day)
      const next = [...rest, action.snapshot]
        .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
        .slice(-STORAGE_SNAPSHOT_CAP)
      return { ...state, storageSnapshots: next }
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
    case "HOME_START": {
      const node = getNode(state, action.nodeId)
      if (!node || !isDrivable(node)) return state
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        // Homing by hand abandons a simulated measuring run.
        calibrating: n.driver === "hardware" ? n.calibrating : false,
        machine: {
          ...n.machine,
          status: "homing",
          homed: false,
          targetShelf: null,
          direction: null,
          moveFrom: null,
          resumeStatus: null,
          // Homing is the operator's answer to a fault — the dialog closes and
          // the position will be re-established from the index sensor.
          fault: null,
          // ...and to the first-time homing request.
          homingRequest: null,
        },
      }))
    }

    case "HOME_DONE": {
      const measuringRun = getNode(state, action.nodeId)?.calibrating === true
      const homed = withNode(state, action.nodeId, (n) => {
        // Simulated calibration, phase 2: a full turn back to shelf 0. A move
        // whose target equals its start only "arrives" after every shelf has
        // ticked past — exactly one revolution.
        const measuring = n.calibrating === true && n.driver !== "hardware"
        return {
          ...n,
          machine: {
            ...n.machine,
            status: measuring ? "moving" : "idle",
            homed: true,
            currentShelf: 0,
            fault: null,
            targetShelf: measuring ? 0 : null,
            direction: measuring ? "down" : null,
            moveFrom: measuring ? 0 : null,
            resumeStatus: null,
          },
        }
      })
      return measuringRun ? homed : resumeJobAfterHoming(homed, action.nodeId)
    }

    case "MANUAL_MOVE": {
      const node = getNode(state, action.nodeId)
      if (!node || node.machine.status !== "idle" || !node.machine.homed) return state
      if (!isDrivable(node)) return state
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
      if (!isDrivable(node)) return state
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
      if (nextShelf !== targetShelf) return moved
      const arrived = onNodeArrived(moved, action.nodeId)
      if (node.calibrating !== true || node.driver === "hardware") return arrived
      return withNode(arrived, action.nodeId, (n) => simCalibrationResult(n))
    }

    case "ARRIVED":
      return onNodeArrived(state, action.nodeId)

    case "CONFIRM_MOVE": {
      const node = getNode(state, action.nodeId)
      if (!node || node.machine.status !== "awaiting-move-confirm") return state
      return withNode(state, action.nodeId, (n) => ({ ...n, machine: { ...n.machine, status: "moving" } }))
    }

    // Speed calibration is gone. It existed only to measure seconds-per-shelf,
    // and it gated homing behind a "must calibrate first" step. Motor speed is
    // now set directly by the PWM duty, and position comes from homing plus
    // shelf-sensor counting, so there is no elapsed-time figure left to measure.

    case "SET_NODE_RAMP": {
      const node = getNode(state, action.nodeId)
      if (!node || node.type === "shelf") return state
      const rampPct = Math.max(0, Math.min(100, Math.round(action.rampPct)))
      return withNode(state, action.nodeId, (n) => ({ ...n, rampPct }))
    }

    case "SET_NODE_PWM": {
      const node = getNode(state, action.nodeId)
      if (!node || node.type === "shelf") return state
      // Allow right down to 5% so a heavy carousel can be slowed until it stops
      // coasting past the shelf flag. This duty IS the carousel speed.
      const pwmDuty = Math.max(0.05, Math.min(1, Math.round(action.pwmDuty * 100) / 100))
      return withNode(state, action.nodeId, (n) => ({ ...n, pwmDuty }))
    }

    case "SET_NODE_HOMING_PWM": {
      const node = getNode(state, action.nodeId)
      if (!node || node.type === "shelf") return state
      // `undefined` clears the override and returns homing to tracking the move
      // duty. Without a way back, an operator who nudged this slider once would
      // be locked out of the automatic coupling for good.
      if (action.homingDuty === undefined) {
        return withNode(state, action.nodeId, (n) => ({ ...n, homingDuty: undefined }))
      }
      const homingDuty = Math.max(0.05, Math.min(1, Math.round(action.homingDuty * 100) / 100))
      return withNode(state, action.nodeId, (n) => ({ ...n, homingDuty }))
    }

    case "SET_NODE_APPROACH_PWM": {
      const node = getNode(state, action.nodeId)
      if (!node || node.type === "shelf") return state
      // `undefined` clears the override and returns the approach to the default
      // crawl, matching the homing-duty control's escape hatch.
      if (action.approachDuty === undefined) {
        return withNode(state, action.nodeId, (n) => ({ ...n, approachDuty: undefined }))
      }
      const approachDuty = Math.max(0.05, Math.min(1, Math.round(action.approachDuty * 100) / 100))
      return withNode(state, action.nodeId, (n) => ({ ...n, approachDuty }))
    }

    case "SET_NODE_LOAD_COMP": {
      const node = getNode(state, action.nodeId)
      if (!node || node.type === "shelf") return state
      if (action.loadCompKg === undefined) {
        return withNode(state, action.nodeId, (n) => ({ ...n, loadCompKg: undefined }))
      }
      // 0.5–10 kg in 0.1 kg steps.
      const loadCompKg = Math.max(0.5, Math.min(10, Math.round(action.loadCompKg * 10) / 10))
      return withNode(state, action.nodeId, (n) => ({ ...n, loadCompKg }))
    }

    case "REORDER_NODES": {
      if (action.id === action.beforeId) return state
      const moving = state.nodes.find((n) => n.id === action.id)
      if (!moving) return state
      const rest = state.nodes.filter((n) => n.id !== action.id)
      const at = action.beforeId ? rest.findIndex((n) => n.id === action.beforeId) : -1
      const nodes = at === -1 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)]
      // No-op reorders (dropped back where it started) must not dirty the doc.
      if (nodes.every((n, i) => n.id === state.nodes[i].id)) return state
      return { ...state, nodes }
    }

    case "SET_NODE_LOAD_COMP_PCT": {
      const node = getNode(state, action.nodeId)
      if (!node || node.type === "shelf") return state
      // 1–10 % per step, whole percent.
      const loadCompPct = Math.max(1, Math.min(10, Math.round(action.loadCompPct)))
      return withNode(state, action.nodeId, (n) => ({ ...n, loadCompPct }))
    }

    // ----- hardware bridge events (from a real Pi agent) -----
    case "NODE_LINK":
      return withNode(state, action.nodeId, (n) =>
        n.driver === "hardware"
          ? // Keep the last known reason while retrying (checking) so the
            // explanation doesn't flicker away on every reconnect attempt; clear
            // it outright once the link is genuinely online.
            {
              ...n,
              link: action.link,
              linkError: action.link === "online" ? undefined : action.reason ?? n.linkError,
              // A dropped/ reconnecting link means the last sensor reading is
              // stale — mark it unknown so the indicator falls back to the
              // inferred state rather than freezing on a value that no longer
              // reflects the hardware.
              machine: action.link === "online" ? n.machine : { ...n.machine, sensor: null },
            }
          : n,
      )

    case "NODE_AGENT_MODE":
      // Reported by the agent in its `hello` frame: is it actually driving GPIO,
      // or only pretending? Recorded so the UI can warn that no motor will turn.
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        agentSimulated: action.simulated,
        agentSimReason: action.simulated ? action.reason : undefined,
      }))

    case "NODE_NET_STATUS":
      return withNode(state, action.nodeId, (n) => ({ ...n, net: action.status }))

    case "NODE_NET_SLAVES":
      return withNode(state, action.nodeId, (n) => ({ ...n, netSlaves: action.slaves }))

    case "NODE_NET_RESULT":
      return withNode(state, action.nodeId, (n) => ({ ...n, netResult: action.result }))

    case "NODE_POS":
      // Live position update as the carousel passes each shelf sensor.
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, currentShelf: action.currentShelf },
      }))

    case "NODE_SENSOR":
      // Live level of the physical shelf proximity sensor, read off the Pi's
      // GPIO and forwarded by the agent's `sensor` event.
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, sensor: action.on },
      }))

    case "NODE_SERVO":
      // A jog-start frame carries no alarm fields; keep the last known alarm
      // picture underneath it so the lamps don't blink to "unknown" mid-jog.
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        servo: action.servo === null ? null : { ...(n.servo ?? {}), ...action.servo },
      }))

    case "NODE_CALIBRATION": {
      const cal = action.calibration
      return withNode(state, action.nodeId, (n) => {
        const next: StorageNode = { ...n, calibration: cal, calibrating: false }
        // A successful measurement is the agent's truth; keep our copy in step
        // so it can be handed back after a re-install.
        if (cal.ok && typeof cal.pulsesPerRev === "number" && cal.pulsesPerRev > 0) {
          if (cal.pulsesPerRev !== n.servoCarouselPulses) next.servoCarouselPulses = cal.pulsesPerRev
          const win = typeof cal.indexWindowPulses === "number" && cal.indexWindowPulses > 0 ? cal.indexWindowPulses : undefined
          if (win !== n.servoIndexWindowPulses) next.servoIndexWindowPulses = win
          if (!cal.restored) next.servoCalibratedAt = Date.now()
        }
        return next
      })
    }

    case "NODE_CALIBRATING":
      return withNode(state, action.nodeId, (n) => ({ ...n, calibrating: action.on }))

    case "NODE_BALANCE": {
      const ev = action.balance
      return withNode(state, action.nodeId, (n) => {
        const next: StorageNode = { ...n, balance: ev }
        // The agent has already applied and saved the measured trim; mirror it
        // so the slider, the Exact box and the next `config` all agree.
        if (ev?.phase === "done" && typeof ev.trimPct === "number" && Number.isFinite(ev.trimPct)) {
          next.dcTrimPct = ev.trimPct
        }
        return next
      })
    }

    case "SIM_CALIBRATE_START": {
      const node = getNode(state, action.nodeId)
      if (!node || node.driver === "hardware" || node.machine.status !== "idle" || state.job) return state
      // Phase 1 is an ordinary homing; HOME_DONE sees `calibrating` and turns
      // it into the measuring revolution instead of parking idle.
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        calibrating: true,
        machine: {
          ...n.machine,
          status: "homing",
          homed: false,
          targetShelf: null,
          direction: null,
          moveFrom: null,
          resumeStatus: null,
          fault: null,
          homingRequest: null,
        },
      }))
    }

    case "NODE_SYNC":
      return withNode(state, action.nodeId, (n) =>
        n.calibration ? { ...n, calibration: { ...n.calibration, lastDriftPulses: action.driftPulses } } : n,
      )

    case "NODE_ARRIVED": {
      // The Pi reports it stopped at `shelf`. Snap position, then run the same
      // arrival logic the simulation uses (advance job / await confirm).
      const snapped = withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, currentShelf: action.shelf },
      }))
      return onNodeArrived(snapped, action.nodeId)
    }

    case "NODE_HOMED": {
      // Also clears a fault: when ANOTHER device homed the carousel, this one
      // hears the Pi's `homed` frame and its position-lost warning resolves.
      const homed = withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: {
          ...n.machine,
          status: "idle",
          homed: true,
          currentShelf: action.currentShelf ?? 0,
          targetShelf: null,
          direction: null,
          fault: null,
          // Another device (or the Pi itself) homed it — nothing left to ask.
          homingRequest: null,
        },
      }))
      return resumeJobAfterHoming(homed, action.nodeId)
    }

    case "NODE_FAULT":
      // Hardware fault: the agent has already cut the motor. Park the node with
      // its position UNKNOWN. Recording `fault` is what makes the "position
      // lost" dialog appear and what blocks the power-up auto-home from ever
      // treating this un-homed state as a fresh boot. Nothing moves again until
      // the operator explicitly chooses to home.
      // The job and the queue behind it are KEPT: once homing finishes,
      // `resumeJobAfterHoming` heads for the stop that was interrupted.
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: {
          ...n.machine,
          status: "idle",
          homed: false,
          targetShelf: null,
          direction: null,
          moveFrom: null,
          resumeStatus: null,
          fault: { message: action.message, at: Date.now(), acknowledged: false },
        },
      }))

    case "ACK_NODE_FAULT":
      // Operator chose "Not now" in the position-lost dialog. The carousel stays
      // un-homed (and so cannot run absolute moves); the sidebar keeps a
      // persistent warning with the Home button until they home it.
      return withNode(state, action.nodeId, (n) =>
        n.machine.fault ? { ...n, machine: { ...n.machine, fault: { ...n.machine.fault, acknowledged: true } } } : n,
      )

    case "REQUEST_HOMING":
      // Only meaningful for a paternoster that is idle and does not know where
      // it is; never stack a second request on top of an existing one.
      return withNode(state, action.nodeId, (n) => {
        if (n.type === "shelf" || n.type === "library") return n
        if (n.machine.homed || n.machine.status !== "idle" || n.machine.homingRequest) return n
        return { ...n, machine: { ...n.machine, homingRequest: { at: Date.now(), acknowledged: false } } }
      })

    case "ACK_HOMING_REQUEST":
      return withNode(state, action.nodeId, (n) =>
        n.machine.homingRequest
          ? { ...n, machine: { ...n.machine, homingRequest: { ...n.machine.homingRequest, acknowledged: true } } }
          : n,
      )

    // ----- jobs -----
    case "START_JOB": {
      const job = action.job
      if (job.items.length === 0) return state
      const withJob = { ...state, job: { ...job, currentIndex: 0 }, pendingJobs: [] }
      return serviceCurrentItem(withJob)
    }

    case "START_JOBS": {
      // Drop empty jobs, run the first, and stash the rest to run one whole job
      // at a time as each finishes (see CONFIRM_STOP completion).
      const jobs = action.jobs.filter((j) => j.items.length > 0)
      if (jobs.length === 0) return state
      const [first, ...rest] = jobs
      const withJob = { ...state, job: { ...first, currentIndex: 0 }, pendingJobs: rest }
      return serviceCurrentItem(withJob)
    }

    case "ENQUEUE_JOB_ITEM": {
      const { item, mode } = action
      // Nothing running → this becomes a brand-new one-item job (starts motion).
      if (!state.job) {
        const withJob = { ...state, job: { mode, items: [item], currentIndex: 0 } }
        return serviceCurrentItem(withJob)
      }
      // Same operation in flight → append behind the current stops. Motion for the
      // new stop begins automatically once the carousel advances to it, so the
      // machine state is untouched here.
      if (state.job.mode === mode) {
        return { ...state, job: { ...state.job, items: [...state.job.items, item] } }
      }
      // A different operation is running → run this one right after, as its own job.
      return { ...state, pendingJobs: [...state.pendingJobs, { mode, items: [item], currentIndex: 0 }] }
    }

    case "REJECT_STORE_SLOT": {
      const job = state.job
      if (!job || job.mode === "pick") return state
      const item = job.items[job.currentIndex]
      if (!item || item.occupantKind === "part") return state
      const spool = state.spools[item.spoolId]
      if (!spool) return state

      const rejected = [...(item.rejectedSlots ?? []), { nodeId: item.nodeId, shelf: item.shelf, slot: item.slot }]
      // Stay in the unit the operator chose unless it has nothing else to offer.
      // Nowhere else to go: the item keeps its (rejected) slot, which the UI
      // reads as "no slot left that fits" and offers another unit or a library.
      return retargetCurrentStoreItem(state, rejected, item.nodeId)
    }

    case "RETARGET_STORE_ITEM": {
      const job = state.job
      if (!job || job.mode === "pick") return state
      const item = job.items[job.currentIndex]
      if (!item || item.occupantKind === "part") return state
      let next = state
      let targetId: string
      if ("newLibraryName" in action) {
        const lib = makeNode({
          name: action.newLibraryName.trim() || "Library",
          ip: "127.0.0.1",
          role: "slave",
          type: "library",
          system: "filament",
          storage: { shelves: 1, slotsPerShelf: 1 },
        })
        next = { ...state, nodes: [...state.nodes, lib] }
        targetId = lib.id
      } else {
        const target = getNode(state, action.nodeId)
        if (!target || nodeSystem(target) !== "filament") return state
        targetId = action.nodeId
      }
      return retargetCurrentStoreItem(next, item.rejectedSlots ?? [], targetId)
    }

    case "CONFIRM_STOP": {
      const job = state.job
      if (!job) return state
      const idx = action.index ?? job.currentIndex
      if (idx !== job.currentIndex && idx !== job.twinIndex) return state
      const item = job.items[idx]
      if (!item || item.done) return state

      let next: AppState = state
      // A hardware stop that didn't fully fit may spawn one follow-up stop for
      // the remainder; it is appended to this job below.
      let spilloverItem: QueueItem | null = null

      if (job.mode === "pick" && item.occupantKind === "part") {
        // Hardware take-out. Decrement the box; HW_TAKE itself frees the slot and
        // deletes the part when it empties, so we don't clear the slot here. The
        // quantity is normally entered live at this stop (action.takeCount); fall
        // back to any pre-set partOp count for older single-take flows.
        const takeCount = action.takeCount ?? (item.partOp?.kind === "take" ? item.partOp.count : 0)
        next = machineReducer(next, { type: "HW_TAKE", partId: item.spoolId, takeCount })
        if (item.pickListRef && takeCount > 0) {
          next = machineReducer(next, {
            type: "PICKLIST_RECORD",
            listId: item.pickListRef.listId,
            lineId: item.pickListRef.lineId,
            count: takeCount,
          })
        }
      } else if (job.mode === "pick") {
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
      } else if (item.occupantKind === "part") {
        // Hardware place (new box) or store-more (existing box). The operator may
        // report that only `storeCount` pieces fit: the box keeps that many and
        // the rest is routed to another box of the same part or a fresh slot.
        const part = next.parts[item.spoolId]
        const isAdd = item.partOp?.kind === "add"
        const full = isAdd ? Math.max(0, Math.floor(item.partOp!.count)) : part?.count ?? 0
        let placed = full
        if (part && typeof action.storeCount === "number" && Number.isFinite(action.storeCount)) {
          placed = Math.min(full, Math.max(0, Math.round(action.storeCount)))
        }
        const remainder = full - placed
        if (part && remainder > 0) {
          // The current slot is not written until below, so it must be reserved
          // explicitly or the remainder would be offered this very slot.
          const reserved = [
            item,
            ...job.items.filter((it, i) => i !== idx && !it.done),
            ...next.pendingJobs.flatMap((j) => j.items),
          ].map((it) => ({ nodeId: it.nodeId, shelf: it.shelf, slot: it.slot }))
          const dest = pickRemainderDestination(next, part, [part.id], reserved)
          if (!dest) {
            // Nowhere to put the rest: keep everything here rather than lose it.
            placed = full
          } else if (dest.kind === "existing") {
            spilloverItem = {
              spoolId: dest.partId,
              occupantKind: "part",
              nodeId: dest.nodeId,
              shelf: dest.shelf,
              slot: dest.slot,
              partOp: { kind: "add", count: remainder },
              done: false,
            }
          } else {
            const clone: HardwarePart = {
              ...part,
              id: newId("part"),
              count: remainder,
              lockedSlot: false,
              createdAt: Date.now(),
            }
            next = machineReducer(next, { type: "UPSERT_PART", part: clone })
            spilloverItem = {
              spoolId: clone.id,
              occupantKind: "part",
              nodeId: dest.nodeId,
              shelf: dest.shelf,
              slot: dest.slot,
              done: false,
            }
          }
        }
        if (part && isAdd) {
          if (placed > 0) next = machineReducer(next, { type: "HW_STORE_MORE", partId: part.id, addCount: placed })
        } else if (part && placed !== part.count) {
          next = machineReducer(next, { type: "UPSERT_PART", part: { ...part, count: placed } })
        }
        // Make sure the part id occupies the slot (a re-set is harmless and keeps
        // placement idempotent).
        next = machineReducer(next, {
          type: "SET_STORAGE_SLOT",
          nodeId: item.nodeId,
          shelf: item.shelf,
          slot: item.slot,
          spoolId: item.spoolId,
        })
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
        // "place" mode for a filament spool (hardware parts were handled above).
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
      if (spilloverItem) items.push(spilloverItem)
      if (!items.some((it) => !it.done)) {
        // This whole job is done. If another job is queued (e.g. take-out
        // finished, now run place-in), start it; otherwise everything is done.
        if (next.pendingJobs.length > 0) {
          const [nextJob, ...rest] = next.pendingJobs
          const chained = { ...next, job: { ...nextJob, currentIndex: 0 }, pendingJobs: rest }
          return serviceCurrentItem(chained)
        }
        return { ...next, job: null }
      }

      // Twin side finished its stop: the primary side carries on untouched and
      // this side immediately takes its own nearest remaining stop.
      if (idx === job.twinIndex) {
        const after: AppState = { ...next, job: { ...job, items, twinIndex: undefined } }
        return prefetchOtherNodes(normalizeTwin(after))
      }

      // Primary finished while its twin is already busy: promote the twin's stop
      // (it is moving or waiting already), then refill the side that just freed.
      if (job.twinIndex != null && !items[job.twinIndex].done) {
        const promotedItem = items[job.twinIndex]
        const promoted: AppState = {
          ...next,
          activeNodeId: promotedItem.nodeId,
          job: { ...job, items, currentIndex: job.twinIndex, twinIndex: undefined },
        }
        return prefetchOtherNodes(normalizeTwin(promoted))
      }

      // A twin side with more stops of its own goes to its nearest one; everyone
      // else keeps the queue order.
      const finishedNode = getNode(next, item.nodeId)
      let nextIndex: number | undefined =
        finishedNode?.twinSide ? nearestItemOn({ ...job, items }, finishedNode, new Set()) : undefined
      if (nextIndex == null) {
        nextIndex = items.findIndex((it, i) => i > idx && !it.done)
        if (nextIndex < 0) nextIndex = items.findIndex((it) => !it.done)
      }
      const advanced = { ...next, job: { ...job, items, currentIndex: nextIndex, twinIndex: undefined } }
      return serviceCurrentItem(advanced)
    }

    case "SWAP_JOB_SPOOL": {
      const job = state.job
      if (!job) return state
      const idx = job.currentIndex
      const current = job.items[idx]
      if (!current) return state
      // Already the right spool — nothing to correct.
      if (current.spoolId === action.scannedSpoolId) return state
      // The scanned spool must be another not-yet-serviced stop in THIS job.
      const otherIdx = job.items.findIndex((it, i) => i > idx && !it.done && it.spoolId === action.scannedSpoolId)
      if (otherIdx < 0) return state
      // Swap only the spool identity; each stop keeps its own slot/grams/from so
      // the plan is untouched — just which physical spool fills each slot changes.
      const items = job.items.map((it, i) => {
        if (i === idx) return { ...it, spoolId: action.scannedSpoolId }
        if (i === otherIdx) return { ...it, spoolId: current.spoolId }
        return it
      })
      return { ...state, job: { ...job, items } }
    }

    case "EMERGENCY_STOP": {
      const node = getNode(state, action.nodeId)
      if (!node) return state
      // A real paternoster e-stop freezes the carousel EXACTLY where it is and
      // keeps it there until the operator explicitly resumes or re-homes. We
      // switch to the dedicated "stopped" status (not "idle"), which:
      //   * halts the motion sim — it only arms timers for "moving"/"homing";
      //   * blocks the auto-home effect — it only fires on an "idle" unmoved
      //     unit, so the carousel will NOT drift back to shelf 1;
      //   * preserves currentShelf/targetShelf/direction/moveFrom so the move
      //     can pick up precisely where it left off.
      // The active job is left untouched so "Continue task" can carry on.
      // Twin carousels share one Pi and one physical stop: halt both halves.
      const sibling = twinSiblingOf(state, node)
      if (node.machine.status === "stopped") {
        return sibling && sibling.machine.status !== "stopped"
          ? coreReducer(state, { type: "EMERGENCY_STOP", nodeId: sibling.id })
          : state
      }
      const stoppedSelf = withNode(state, action.nodeId, (n) => ({
        ...n,
        // A measuring run cannot be resumed mid-turn; it is simply abandoned.
        calibrating: false,
        calibration:
          n.calibrating && n.driver !== "hardware"
            ? { type: "calibration", ok: false, message: "Calibration stopped." }
            : n.calibration,
        machine: { ...n.machine, status: "stopped", resumeStatus: n.machine.status },
      }))
      return sibling && sibling.machine.status !== "stopped"
        ? coreReducer(stoppedSelf, { type: "EMERGENCY_STOP", nodeId: sibling.id })
        : stoppedSelf
    }

    case "MAKE_TWIN": {
      const node = getNode(state, action.id)
      if (!node || node.system !== "hardware" || node.type !== "paternoster" || node.twinSide) return state
      const right: StorageNode = {
        ...node,
        id: newId("node"),
        name: `${node.name} Right`,
        twinSide: "right",
        role: "slave",
        slots: buildGrid(node.storage),
        machine: freshMachine(),
        calibrating: false,
        calibration: undefined,
        servoCarouselPulses: undefined,
        servoIndexWindowPulses: undefined,
        servoSingleMotor: false,
      }
      const withLeft = withNode(state, node.id, (n) => ({
        ...n,
        name: `${n.name} Left`,
        twinSide: "left",
        servoSingleMotor: false,
      }))
      const idx = withLeft.nodes.findIndex((n) => n.id === node.id)
      const nodes = [...withLeft.nodes]
      nodes.splice(idx + 1, 0, right)
      return { ...withLeft, nodes }
    }

    case "UNTWIN": {
      const node = getNode(state, action.id)
      if (!node?.twinSide) return state
      const sibling = twinSiblingOf(state, node)
      const left = node.twinSide === "left" ? node : sibling
      const right = node.twinSide === "right" ? node : sibling
      if (state.job?.items.some((it) => !it.done && (it.nodeId === left?.id || it.nodeId === right?.id))) return state
      // Only an empty Right carousel can be dropped; it would lose its contents.
      if (right && right.slots.some((row) => row.some((s) => s != null))) return state
      const nodes = state.nodes
        .filter((n) => n.id !== right?.id)
        .map((n) =>
          n.id === left?.id ? { ...n, twinSide: undefined, name: n.name.replace(/ Left$/, "") } : n,
        )
      const activeNodeId = state.activeNodeId === right?.id ? (left?.id ?? nodes[0]?.id ?? null) : state.activeNodeId
      return { ...state, nodes, activeNodeId }
    }

    case "RESUME_MOVE": {
      const node = getNode(state, action.nodeId)
      if (!node || node.machine.status !== "stopped") return state
      const prev = node.machine.resumeStatus
      // Restore whatever it was doing. Calibration can't be safely resumed
      // mid-pass, and anything with nothing left to do just parks idle.
      const resumable =
        prev === "moving" ||
        prev === "homing" ||
        prev === "awaiting-move-confirm" ||
        prev === "awaiting-pick-confirm" ||
        prev === "awaiting-store-confirm"
      const next: MachineStatus = resumable ? prev! : "idle"
      return withNode(state, action.nodeId, (n) => ({
        ...n,
        machine: { ...n.machine, status: next, resumeStatus: null },
      }))
    }

    case "CANCEL_JOB": {
      // Return every node that was involved in the job to idle.
      const nodes = state.nodes.map((n) =>
        n.machine.status === "moving" ||
        n.machine.status === "awaiting-move-confirm" ||
        n.machine.status === "awaiting-pick-confirm" ||
        n.machine.status === "awaiting-store-confirm" ||
        n.machine.status === "stopped"
          ? {
              ...n,
              machine: {
                ...n.machine,
                status: "idle" as const,
                targetShelf: null,
                direction: null,
                moveFrom: null,
                resumeStatus: null,
              },
            }
          : n,
      )
      // A store job registers its spool up front but only writes it into a slot
      // on confirm. If the job is cancelled, drop any spool that was created for
      // an unfinished store item so it doesn't linger unplaced in the registry.
      // Cancelling stops the WHOLE run, so also sweep queued (not-yet-started)
      // store jobs — a place-in job waiting behind a take-out job may already
      // have created spools that were never placed.
      let spools = state.spools
      const storeJobs = [state.job, ...state.pendingJobs].filter(
        (j): j is ActiveJob => !!j && j.mode === "store",
      )
      if (storeJobs.length > 0) {
        const placed = new Set<string>()
        for (const n of nodes) for (const row of n.slots) for (const id of row) if (id) placed.add(id)
        const orphans = storeJobs
          .flatMap((j) => j.items)
          .filter((it) => !it.done && !placed.has(it.spoolId))
          .map((it) => it.spoolId)
        if (orphans.length > 0) {
          spools = { ...state.spools }
          for (const id of orphans) delete spools[id]
        }
      }
      return { ...state, nodes, spools, job: null, pendingJobs: [] }
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
        // Older saves predate the hardware area, so any node without an explicit
        // system belongs to the filament area.
        system: n.system === "hardware" ? "hardware" : "filament",
        type,
        driver,
        // A library is an unbounded single row; guarantee it always has at least
        // one row so adding/rendering spools never hits an undefined slot array.
        slots: type === "library" ? (Array.isArray(n.slots) && n.slots.length > 0 ? n.slots : [[]]) : n.slots,
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
    parts: parsed.parts && typeof parsed.parts === "object" ? parsed.parts : {},
    hardwareOrders: Array.isArray(parsed.hardwareOrders) ? parsed.hardwareOrders : [],
    hwPickLists: Array.isArray(parsed.hwPickLists) ? parsed.hwPickLists : [],
    nodes,
    activeNodeId,
    // Normalise every printer so mixed-AMS (`ams`) and the legacy uniform
    // fields agree, synthesising `ams` for printers saved before it existed.
    // De-dupe by id first: older data could contain the same printer twice
    // (a double ADD_PRINTER), which crashed React with duplicate keys.
    printers: dedupeById<Printer>((parsed.printers ?? []) as Printer[]).map((p) =>
      normalizePrinter({ ...p, link: "offline" }),
    ),
    activePrinterId: parsed.activePrinterId ?? null,
    dispenseRequests: Array.isArray(parsed.dispenseRequests)
      ? (parsed.dispenseRequests as DispenseRequest[]).slice(-DISPENSE_CAP)
      : [],
    apiToken: typeof parsed.apiToken === "string" && parsed.apiToken ? parsed.apiToken : undefined,
    job: null,
    pendingJobs: [],
    history: Array.isArray(parsed.history) ? parsed.history.slice(0, HISTORY_CAP) : [],
    usage: coerceUsage(parsed.usage),
    consumptionLog: Array.isArray(parsed.consumptionLog)
      ? parsed.consumptionLog.slice(-CONSUMPTION_LOG_CAP)
      : [],
    storageSnapshots: Array.isArray(parsed.storageSnapshots)
      ? parsed.storageSnapshots.slice(-STORAGE_SNAPSHOT_CAP)
      : [],
    hwPickQueue: [],
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface StoreContextValue {
  state: AppState
  dispatch: React.Dispatch<Action>
  ready: boolean
  /**
   * Set when the initial load from the database FAILED (as opposed to the DB
   * being genuinely empty). Critical distinction: on failure we must NOT show
   * the setup wizard and must NOT enable saving, because an empty local state
   * would otherwise overwrite the user's real saved data.
   */
  loadError: string | null
}

const StoreContext = createContext<StoreContextValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(machineReducer, undefined, makeInitialState)
  const readyRef = useRef(false)
  const [ready, setReady] = useReducer(() => true, false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // Nodes already auto-homed this session, so a later fault that clears `homed`
  // cannot make the carousel start homing again by itself.
  const autoHomedRef = useRef<Set<string>>(new Set())

  // Sync bookkeeping. `dbVersion` is the last version we've seen from the
  // server; `lastSavedSig` is the persisted-subset signature we last wrote, so
  // we can skip redundant saves and skip reloading our own writes.
  const dbVersion = useRef(0)
  const lastSavedSig = useRef<string | null>(null)
  // The last document we synced from the server. Used as the common ancestor in
  // mergeCatalog so a local delete isn't resurrected while concurrent remote
  // adds are still preserved.
  const baselineRef = useRef<PersistedState | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A save that has been scheduled/started but not yet acknowledged by the
  // server. While this is true, a poll must not reload �� otherwise it can fetch
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
          const persisted = toPersisted(hydrated)
          lastSavedSig.current = JSON.stringify(persisted)
          baselineRef.current = persisted
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
            const persisted = toPersisted(hydrated)
            dispatch({ type: "HYDRATE", state: hydrated })
            const { version: v } = await saveSystemState(persisted)
            if (!cancelled) {
              dbVersion.current = v
              lastSavedSig.current = JSON.stringify(persisted)
              baselineRef.current = persisted
            }
          }
        }
        // Load genuinely succeeded (data hydrated above, or DB confirmed empty
        // → first-run setup). Only NOW is it safe to enable saving.
        if (!cancelled) {
          readyRef.current = true
          setReady()
        }
      } catch (e) {
        // The load FAILED (e.g. DB locked, disk error, or better-sqlite3 native
        // binding mismatch after an update — run `pnpm rebuild better-sqlite3`).
        // We deliberately do NOT set readyRef=true here: leaving saving disabled
        // prevents the empty initial state from overwriting the user's real data
        // in the database. We surface an error screen instead of the setup wizard.
        const msg = (e as Error).message
        console.log("[v0] initial system load failed:", msg)
        if (!cancelled) {
          setLoadError(msg || "Could not load your data")
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
      // Persist the NEWEST state, not the render that scheduled this timer.
      // Capturing `state` from the closure is why the carousel position jumped
      // back a shelf on refresh: the debounce is reset by every `pos` tick, so
      // the timer that finally fires belongs to an EARLIER render and wrote that
      // older shelf. The final `arrived` position produced no further change to
      // re-trigger the effect, so it was never written at all — the UI showed 3
      // while the database still held 2.
      const snapshot = stateRef.current
      const snapshotSig = persistedSig(snapshot)
      try {
        let payload = toPersisted(snapshot)
        // Before a last-write-wins save, fold in any catalog additions another
        // device made since our last sync (profiles, barcodes, containers,
        // custom materials/brands, orders) so this save can't drop them — while
        // using our baseline (last synced doc) as the common ancestor so items
        // WE deleted are not resurrected. The merged result flows back into local
        // state on the next poll.
        try {
          const latest = await loadSystemState()
          if (latest.data) payload = mergeCatalog(payload, latest.data, baselineRef.current)
        } catch {
          // Offline or load failed — save the local document as-is.
        }
        const { version } = await saveSystemState(payload)
        dbVersion.current = version
        lastSavedSig.current = snapshotSig
        // The document we just wrote is now the server truth — adopt it as the
        // baseline so subsequent deletes diff against what's actually stored.
        baselineRef.current = payload
      } catch (e) {
        console.log("[v0] system save failed:", (e as Error).message)
      } finally {
        saveInFlight.current = false
      }
    }, 600)
    // Deliberately no cleanup cancelling the timer. The debounce is already
    // maintained by the clearTimeout above, whereas a cleanup keyed on [sig]
    // also fired when the next render bailed out at the `sig === lastSavedSig`
    // check — killing an armed save that nothing ever rescheduled, so the write
    // was silently lost.
  }, [sig])

  // A refresh during the 600ms debounce would still lose the pending write, so
  // flush it when the page is hidden. `visibilitychange` is the reliable hook
  // (`beforeunload` is skipped on mobile), and firing the timer early is safe
  // because it now reads `stateRef.current` rather than a stale closure.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== "hidden") return
      if (!saveTimer.current) return
      const timer = saveTimer.current
      saveTimer.current = null
      clearTimeout(timer)
      void (async () => {
        try {
          const payload = toPersisted(stateRef.current)
          const savedSig = persistedSig(stateRef.current)
          const { version } = await saveSystemState(payload)
          dbVersion.current = version
          lastSavedSig.current = savedSig
          baselineRef.current = payload
        } catch {
          // Nothing more we can do as the page goes away.
        }
      })()
    }
    document.addEventListener("visibilitychange", flush)
    return () => document.removeEventListener("visibilitychange", flush)
  }, [])

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
        const incomingPersisted = toPersisted(incoming)
        const incomingSig = JSON.stringify(incomingPersisted)
        dbVersion.current = v
        // The freshly loaded server document becomes our new baseline for future
        // delete-aware merges, regardless of whether we re-hydrate below.
        baselineRef.current = incomingPersisted
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

      // SAFETY: a fault means the carousel stopped because it lost track of its
      // position. That is never a reason to start moving again on our own —
      // the operator must confirm in the position-lost dialog. This check comes
      // FIRST so no other branch below can reach HOME_START for a faulted unit.
      if (n.machine.fault) {
        autoHomedRef.current.add(n.id)
        continue
      }

      if (n.machine.status !== "idle") continue

      // A unit that is ALREADY homed has nothing to do — and, crucially, is
      // recorded as handled right now. Previously the record was only written
      // when this effect actually fired, so a device that opened while the
      // carousel was already homed never recorded it. The first fault that
      // device saw then cleared `homed`, and this "power-up" effect fired on a
      // machine that had just stopped for safety: the carousel homed itself a
      // moment after losing track. Any later `homed: false` on a recorded node
      // is a fault, not a boot, and must wait for the operator.
      if (n.machine.homed) {
        autoHomedRef.current.add(n.id)
        continue
      }

      // Not homed yet. Hardware units can only home once their Pi is online; do
      // NOT record them here, so a unit that comes online later still gets its
      // one genuine power-up home.
      if (n.driver === "hardware" && n.link !== "online") continue

      // A REAL carousel never starts its first sweep unannounced. When someone
      // has just wired up a unit and connected its Pi, an unexpected full
      // rotation is exactly the surprise motion we must avoid — so ask first.
      // The homing dialog then dispatches HOME_START on the operator's say-so.
      // Asking moves nothing and the reducer ignores a repeat while a request
      // (answered or not) is already recorded, so this needs no once-per-
      // session guard — which also means a unit switched from simulated to
      // Real Pi mid-session still gets asked.
      if (n.driver === "hardware") {
        if (!n.machine.homingRequest) dispatch({ type: "REQUEST_HOMING", nodeId: n.id })
        continue
      }

      // Simulated units carry no risk and still home themselves — ONCE per node
      // per session; recovering from anything else is the operator's call via
      // the Home button.
      if (autoHomedRef.current.has(n.id)) continue
      autoHomedRef.current.add(n.id)
      dispatch({ type: "HOME_START", nodeId: n.id })
    }
  }, [ready, state.configured, state.nodes])

  // Drive homing + rotation timers for ALL simulated nodes simultaneously.
  // Hardware nodes are driven by their Pi agent instead (see NodeConnection),
  // so we never arm sim timers for them.
  const motionSig = state.nodes
    .map(
      (n) =>
        `${n.id}:${n.driver}:${n.machine.status}:${n.machine.currentShelf}:${n.machine.moveFrom ?? ""}:${n.machine.targetShelf ?? ""}:${n.rampPct ?? ""}`,
    )
    .join("|")
  useEffect(() => {
    const active = new Set<string>()
    for (const n of state.nodes) {
      if (n.driver === "hardware") continue
      // Simulation-only animation pace: a fixed, comfortable step time. It is
      // purely cosmetic — nothing about real positioning depends on it, since
      // hardware nodes are driven by their Pi agent and locate themselves from
      // the shelf sensor rather than from elapsed time.
      const baseMs = SIM_STEP_MS
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

  return <StoreContext.Provider value={{ state, dispatch, ready, loadError }}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error("useStore must be used within StoreProvider")
  return ctx
}
