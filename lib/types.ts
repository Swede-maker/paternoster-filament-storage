// Core domain types for the PAX paternoster filament storage system.

/**
 * Filament material type. Common presets are listed in `MATERIALS`
 * (see lib/filament), but any custom string is allowed so users can
 * add their own filament types.
 */
export type FilamentMaterial = string

/** A physical spool of filament. */
export interface Spool {
  id: string
  material: FilamentMaterial
  brand: string
  /** Hex color used for rendering the spool. */
  color: string
  /**
   * Optional second hex color for dual-color / co-extruded / gradient spools.
   * Only meaningful when `dualColor` is true; ignored otherwise.
   */
  color2?: string
  /** Whether this spool is a two-tone spool that should render `color2` too. */
  dualColor?: boolean
  /** Human readable color name, e.g. "Galaxy Red". */
  colorName: string
  /** Grams of filament remaining. */
  grams: number
  /** Full-spool weight (grams) when new — used as the 100% reference for the
   *  remaining-filament fill indicator. Falls back to `grams` when absent. */
  capacity?: number
  /**
   * Recommended nozzle/hotend temperature (°C) for this filament. Optional.
   * When set, a toolchanger printer running Marlin/Klipper can auto-preheat the
   * tool this spool is loaded onto.
   */
  nozzleTemp?: number
  /**
   * Id of the storage container / dry box this spool sits in (see
   * `Settings.containers`). When set, the container's own weight is added to the
   * spool's filament weight for paternoster balance calculations. Absent = the
   * bare spool with no container.
   */
  containerId?: string
  /**
   * Material density (g/cm³) used to convert firmware-reported filament length
   * into consumed mass for live weight tracking. Defaults from the material
   * (see `densityFor`) when absent.
   */
  density?: number
  /**
   * Filament diameter (mm). Affects the length→mass conversion. Defaults to
   * 1.75mm (see `Settings.defaultDiameter`) when absent.
   */
  diameter?: number
  /**
   * RFID tag UID (e.g. a Bambu AMS `tray_uuid`). Used to recognise a spool that
   * has already been auto-created from an AMS tray so it isn't duplicated.
   */
  rfidUid?: string
  /** Scanned barcode string associated with this spool, if any. */
  barcode?: string
  /**
   * Optional "dry this filament" reminder. When set, an alert surfaces once
   * `setAt + days` has passed. The user can reset it (restart the countdown from
   * now) or clear it entirely. Absent = no reminder.
   */
  dryReminder?: DryReminder
  createdAt: number
}

/** A per-spool reminder to dry the filament after a number of days. */
export interface DryReminder {
  /** When the countdown started (ms epoch). Reset updates this to "now". */
  setAt: number
  /** Number of days after `setAt` before the dry alert becomes due. */
  days: number
}

/**
 * A reusable filament profile: a saved bundle of spool attributes the user can
 * quickly apply when creating a new spool or preparing an incoming order. Stored
 * on `Settings.filamentProfiles`.
 */
export interface FilamentProfile {
  id: string
  name: string
  material: FilamentMaterial
  brand: string
  color: string
  /** Optional second color for a dual-color spool. */
  color2?: string
  /** Whether this profile describes a two-tone spool. */
  dualColor?: boolean
  colorName: string
  /** Full-spool weight (g) to seed a new spool with. */
  capacity: number
  nozzleTemp?: number
  density?: number
  diameter?: number
  containerId?: string
}

/** A single line item in an incoming filament order / cart. */
export interface OrderItem {
  id: string
  material: FilamentMaterial
  brand: string
  color: string
  /** Optional second color for a dual-color spool. */
  color2?: string
  /** Whether this item describes a two-tone spool. */
  dualColor?: boolean
  colorName: string
  capacity: number
  nozzleTemp?: number
  density?: number
  diameter?: number
  containerId?: string
  /** How many spools of this item are in the order. */
  quantity: number
}

/** A named incoming order / shopping cart of filament to receive into storage. */
export interface FilamentOrder {
  id: string
  /** Cart name, e.g. "Amazon", "Prusa restock". */
  name: string
  createdAt: number
  items: OrderItem[]
}

/**
 * A reusable storage container or dry box (e.g. a Polymaker dry box) that a
 * spool can sit inside. Its empty weight is factored into balance math so the
 * carousel stays balanced around the real stored mass, not just the filament.
 */
export interface Container {
  id: string
  name: string
  /** Empty weight of the container/dry box in grams. */
  weightGrams: number
}

/** A single storage location in the carousel: shelf index + slot index. */
export interface StorageLocation {
  shelf: number
  slot: number
}

/** Where a spool currently lives. */
export type SpoolPlacement =
  | { type: "storage"; shelf: number; slot: number }
  | { type: "printer"; printerId: string; slot: number }

export type PrinterKind = "single" | "ams" | "toolchanger"

export interface Printer {
  id: string
  name: string
  kind: PrinterKind
  /** AMS only: number of AMS units connected. */
  amsUnits: number
  /** AMS only: spools per AMS unit. */
  slotsPerAms: number
  /** Toolchanger only: number of toolheads. */
  toolheads: number
  /** Loaded spool ids per printer slot index (null = empty). */
  loaded: (string | null)[]
  /**
   * Controller firmware. For Klipper printers with an IP we read live nozzle
   * temperatures from Moonraker (heater names `extruder`, `extruder1`, …).
   * Optional for backwards-compat and for non-toolchanger printers.
   */
  firmware?: PrinterFirmware
  /** Optional network link: the printer's IP address / hostname. */
  ip?: string
  /**
   * Moonraker HTTP port. Defaults to 7125 (standard Klipper/Mainsail). Only used
   * for Klipper printers linked over the network.
   */
  port?: number
  /** Optional Moonraker API key (X-Api-Key) when the instance requires one. */
  apiKey?: string
  /**
   * Bambu Lab only: printer serial number. Required (with `accessCode`) to read
   * AMS / RFID data over MQTT.
   */
  serial?: string
  /** Bambu Lab only: LAN access code shown on the printer screen. */
  accessCode?: string
  /** Bambu Lab only: connect over the local network ("lan") or cloud ("cloud"). */
  bambuMode?: "lan" | "cloud"
  /**
   * Bambu Lab cloud only: which Bambu account region the token belongs to.
   * "global" → api.bambulab.com / us.mqtt.bambulab.com,
   * "china"  → api.bambulab.cn  / cn.mqtt.bambulab.com.
   */
  bambuRegion?: "global" | "china"
  /**
   * Bambu Lab cloud only: the account access token obtained from signing in.
   * The user's password is never stored — only this token, used to connect to
   * the cloud MQTT broker. Synced like the LAN access code.
   */
  bambuToken?: string
  /** Bambu Lab cloud only: account user id, used as the MQTT username `u_<uid>`. */
  bambuUid?: string
  /** Bambu Lab cloud only: the signed-in account email, shown in the UI. */
  bambuAccountEmail?: string
  /**
   * Bambu Lab cloud only: refresh token used to silently mint a new access
   * token before the current one expires — so the printer stays linked without
   * re-entering the password. Never the password itself.
   */
  bambuRefreshToken?: string
  /** Bambu Lab cloud only: epoch-ms hint of when `bambuToken` stops working. */
  bambuTokenExpiresAt?: number
  /** Live connection state for the optional printer link. */
  link?: PrinterLinkStatus
}

/**
 * 3D-printer controller firmware families. Marlin/Klipper get generated preheat
 * commands; Klipper (Moonraker) and Bambu (MQTT) additionally support live reads
 * of temperature, filament usage, and — for Bambu — AMS tray / RFID data.
 */
export type PrinterFirmware = "marlin" | "klipper" | "bambu" | "prusalink"

export type PrinterLinkStatus = "offline" | "checking" | "online"

export type MachineStatus =
  | "idle"
  | "homing"
  | "moving"
  | "awaiting-move-confirm" // safety confirm before any motion
  | "awaiting-pick-confirm" // stopped at a shelf, waiting for "confirm pick"
  | "awaiting-store-confirm" // stopped at a shelf, waiting to place a spool
  | "calibrating" // running the carousel speed auto-calibration routine
  | "stopped" // emergency-stopped: frozen in place until resumed or homed

export type RotationDirection = "up" | "down"

export interface Machine {
  /** Index of the shelf currently at the access window. */
  currentShelf: number
  /** Whether the machine knows its position. */
  homed: boolean
  status: MachineStatus
  /** Shelf the machine is travelling toward, if any. */
  targetShelf: number | null
  direction: RotationDirection | null
  /**
   * Shelf the current move STARTED from. Used to compute how far along a
   * multi-shelf rotation we are so the soft start/stop ramp can ease the speed
   * in at the beginning and out at the end. Null when idle.
   */
  moveFrom?: number | null
  /**
   * When emergency-stopped, the status the machine was in at the moment of the
   * stop, so "Continue task" can pick up exactly where it left off. Undefined
   * whenever `status` is not "stopped".
   */
  resumeStatus?: MachineStatus | null
}

/**
 * A job in the active queue. `mode` describes the whole operation:
 * - "pick": move spools from storage onto a printer
 * - "store": move spools from a printer into storage
 * - "place": place brand new spools into storage
 */
export type QueueMode = "pick" | "store" | "place"

export interface QueueItem {
  spoolId: string
  /** Storage node (paternoster unit) this item belongs to. */
  nodeId: string
  /** Storage destination/source. */
  shelf: number
  slot: number
  /** Printer destination/source (pick & store). */
  printerId?: string
  printerSlot?: number
  /**
   * Source storage slot to clear on confirm. Set only for a "move" (relocating a
   * stored spool to another unit): the store item both empties `from` and fills
   * the destination slot, so the spool is never duplicated or lost.
   */
  from?: { nodeId: string; shelf: number; slot: number }
  /** Remaining-weight override (grams) captured while assembling a store/place. */
  grams?: number
  done: boolean
}

export interface ActiveJob {
  mode: QueueMode
  items: QueueItem[]
  /** Index of the item currently being serviced. */
  currentIndex: number
}

export interface Settings {
  systemName: string
  /** Ask the user to confirm before every carousel movement. */
  confirmBeforeMove: boolean
  /** Full spool weight assumption (g) used for new spools. */
  defaultSpoolWeight: number
  /** User-saved material/type names (in addition to the built-in list). */
  customMaterials: string[]
  /** User-saved brand names (in addition to the built-in list). */
  customBrands: string[]
  /**
   * Storage containers / dry boxes the user has set up. A spool can reference
   * one by id (`Spool.containerId`); its weight is added to the spool's weight
   * during balance calculations. Optional for backwards-compat with old saves.
   */
  containers?: Container[]
  /**
   * Default filament diameter (mm) for new spools. Defaults to 1.75 when absent.
   * Affects the length→mass conversion used for live weight tracking.
   */
  defaultDiameter?: number
  /** Saved filament profiles the user can quickly apply. */
  filamentProfiles?: FilamentProfile[]
  /** Scanned-barcode → saved-profile mappings, so a scan can prefill a spool. */
  barcodes?: { code: string; profileId: string }[]
  /** Incoming filament orders / carts waiting to be received into storage. */
  orders?: FilamentOrder[]
  /**
   * User-saved custom colors (name + hex) that appear as reusable swatches in
   * the spool editor, alongside the built-in presets. Optional for
   * backwards-compat with old saves.
   */
  customColors?: { name: string; hex: string }[]
  /**
   * Whether the "Total filament used" card is shown on the Home storage views
   * (paternoster / shelf / library). When false it lives only under the
   * Filament Drying/History tabs. Chosen during first-time setup and editable
   * here. Defaults to true when absent.
   */
  showUsageCardOnHome?: boolean
}

export interface StorageConfig {
  shelves: number
  /** Uniform slots-per-shelf. Used when `slotCounts` is absent. */
  slotsPerShelf: number
  /**
   * Optional per-shelf slot counts (jagged storage). When present its length
   * equals `shelves` and it overrides `slotsPerShelf` on a per-shelf basis, so
   * shelves of different sizes can live in one unit.
   */
  slotCounts?: number[]
}

/**
 * What kind of physical storage a node represents:
 * - "paternoster": an automated vertical carousel driven by a controller.
 * - "shelf": a plain manual shelving unit with no hardware/automation — the
 *   user retrieves spools by hand; the app just tracks what's where.
 * - "library": an unbounded, manual inventory of spools with no fixed grid.
 *   Spools accumulate in a single auto-growing row and are surfaced through a
 *   filterable/sortable list rather than physical shelf/slot positions. Used to
 *   catalog what filament the user owns; has no hardware/automation.
 */
export type NodeType = "paternoster" | "shelf" | "library"

/** Per-shelf metadata (name + physical area). Index-aligned to the shelves. */
export interface ShelfMeta {
  /** Custom shelf name. Falls back to "Shelf N" when empty. */
  name?: string
  /** Physical area / location of this shelf (e.g. "Garage", "Office"). */
  area?: string
}

/** How a networked node participates in the linked system. */
export type NodeRole = "master" | "slave"

/**
 * How a node's carousel is actually driven:
 * - "simulated": motion is faked with in-app timers (default; good for demos).
 * - "hardware": the app connects to a real Raspberry Pi agent over WebSocket
 *   and the agent drives the GPIO (motor + sensors); the app only reflects the
 *   position the Pi reports.
 */
export type NodeDriver = "simulated" | "hardware"

/**
 * A single paternoster storage unit, typically one Raspberry Pi / controller.
 * Multiple nodes can be linked together (one master, the rest slaves) so
 * several paternosters act as one combined storage pool.
 */
export interface StorageNode {
  id: string
  name: string
  /**
   * The kind of storage this node is. Paternoster nodes are driven by a
   * controller; shelf nodes are plain manual shelving with no hardware.
   * Optional for backwards-compat with older saves (treated as "paternoster").
   */
  type?: NodeType
  /** Physical area / location label for the whole unit (e.g. "Garage"). */
  area?: string
  /** Per-shelf metadata (custom names + areas), index-aligned to shelves. */
  shelfMeta?: ShelfMeta[]
  /** IP address / hostname of the controller (RPi, microcontroller, …). */
  ip: string
  role: NodeRole
  /** Whether this node is simulated or backed by a real Pi agent. */
  driver: NodeDriver
  /** WebSocket port the Pi agent listens on (hardware driver). Default 8765. */
  port: number
  /**
   * Link state. For simulated nodes this stays "online". For hardware nodes it
   * reflects the live WebSocket connection to the Pi agent.
   */
  link: PrinterLinkStatus
  /**
   * Human-readable reason the link is offline (e.g. "Connection refused …"),
   * reported by the server-side relay. Ephemeral and never persisted — it
   * describes this session's connection attempt, not saved configuration.
   */
  linkError?: string
  /**
   * Ephemeral, per-session counter bumped by a manual "Reconnect" action to
   * force the live WebSocket to close and reopen without changing ip/port. Not
   * persisted (stripped in toPersisted) so it never syncs between devices.
   */
  connSeq?: number
  /**
   * True when the connected agent reported it is faking motion rather than
   * driving GPIO (`--simulate`, or gpiozero failed to initialise). Such an agent
   * connects and reports flawless motion while the motor never turns, so this
   * must be shown prominently. Ephemeral: it describes the live agent, so it is
   * stripped from the persisted document like `link`.
   */
  agentSimulated?: boolean
  /** Agent-reported cause of simulation, e.g. the gpiozero pin-factory error. */
  agentSimReason?: string
  /**
   * Calibrated carousel travel time between adjacent shelves, in seconds. This
   * is the real-world speed found by auto-calibration (target ~3.5 s) and also
   * adjustable with the manual speed slider. Drives how fast the carousel
   * rotates everywhere in the app. Defaults to 3.5 when absent.
   */
  secPerShelf?: number
  /**
   * Soft start/stop ramp intensity, 0–100%. 0 = constant speed (no easing);
   * higher values ease the carousel in at the start of a rotation and out at
   * the end, for gentler acceleration/deceleration. Auto-calibration computes a
   * sensible value from the found speed; the user can fine-tune it. Defaults to
   * a mid value when absent.
   */
  rampPct?: number
  /**
   * Whether the carousel speed has been calibrated. A brand-new paternoster
   * starts uncalibrated and must be calibrated BEFORE it is allowed to home.
   * Shelf (manual) nodes are always considered calibrated (no motor).
   */
  calibrated?: boolean
  storage: StorageConfig
  /** shelf -> slot -> spoolId | null */
  slots: (string | null)[][]
  machine: Machine
}

/**
 * A single filament-history event. Every load, unload, placement, move,
 * removal, and dry-reminder change is logged here. Identity fields (material,
 * brand, color, colorName) are SNAPSHOTTED at log time so the entry stays
 * readable even after the spool is edited or deleted.
 */
export type HistoryEventKind =
  | "load" // spool loaded onto a printer
  | "unload" // spool removed from a printer
  | "placed" // spool placed into a storage location (place / move / store)
  | "removed" // spool deleted from the system
  | "dry-set" // a dry reminder was created
  | "dry-reset" // a dry reminder countdown was restarted
  | "dry-cleared" // a dry reminder was deleted

export interface HistoryEvent {
  id: string
  /** When it happened (ms epoch). */
  at: number
  kind: HistoryEventKind
  spoolId: string
  /** Snapshot of the spool identity at the time of the event. */
  material: string
  brand: string
  color: string
  colorName: string
  /** Printer context (load / unload). */
  printerId?: string
  printerName?: string
  /** Slot label on the printer, e.g. "T1" or "1-2". */
  slotLabel?: string
  /** Storage context (placed). */
  nodeId?: string
  nodeName?: string
  /** Human location within the unit, e.g. "Shelf 2 · Slot 3" or "Library". */
  locationLabel?: string
  /** Days configured (dry-set / dry-reset). */
  days?: number
}

/**
 * A saved filament-usage tally, archived whenever the running total is reset.
 * Resetting the counter never loses data — the finished tally is preserved here
 * (shown under History) so the lifetime record is complete.
 */
export interface FilamentUsageArchive {
  id: string
  /** Grams consumed during this tally. */
  grams: number
  /** When the tally started (ms epoch). */
  from: number
  /** When it was reset/archived (ms epoch). */
  to: number
}

/**
 * Lifetime filament-consumption tracking. Every gram the printers extrude is
 * added to `currentG`; the user can reset it (which archives the current tally)
 * without losing the historical totals.
 */
export interface FilamentUsage {
  /** Grams consumed since the current tally began (resettable). */
  currentG: number
  /** When the current tally started (ms epoch). */
  since: number
  /** Previous tallies, preserved on reset — the lifetime record. */
  archived: FilamentUsageArchive[]
}

export interface AppState {
  /** Whether first-run setup has been completed. */
  configured: boolean
  settings: Settings
  /** spoolId -> Spool */
  spools: Record<string, Spool>
  /** Linked storage units. Always has at least one (the master). */
  nodes: StorageNode[]
  /** Which node the storage UI is currently focused on. */
  activeNodeId: string
  printers: Printer[]
  activePrinterId: string | null
  job: ActiveJob | null
  /**
   * Jobs waiting to run after the current `job` finishes. Lets the user assemble
   * a take-out queue and a place-in queue together; they execute one WHOLE job
   * at a time (take-out first, then place-in) with no interleaving. Ephemeral,
   * like `job` — never persisted.
   */
  pendingJobs: ActiveJob[]
  /** Filament usage/movement log, newest first, capped in the reducer. */
  history: HistoryEvent[]
  /** Lifetime + resettable filament-consumption tracking. */
  usage: FilamentUsage
}

/**
 * The durable, shared subset of the system that is stored in the database and
 * synced across every device. Ephemeral runtime state (the in-flight `job`,
 * live carousel motion, live network `link` status) is intentionally excluded
 * so devices agree on the setup + inventory without fighting over live motion.
 */
export interface PersistedState {
  configured: boolean
  settings: Settings
  spools: Record<string, Spool>
  nodes: StorageNode[]
  activeNodeId: string
  printers: Printer[]
  activePrinterId: string | null
  /** Filament usage/movement log (shared + synced across devices). */
  history: HistoryEvent[]
  /** Lifetime + resettable filament-consumption tracking (shared + synced). */
  usage: FilamentUsage
}
