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
   * Stable id of the RFID/QR tag bound to this spool (see `Settings.tagBindings`
   * and `TagBinding`). For an NFC tag this is the hardware serial number; for a
   * printable QR it is the generated `PAX:<uuid>` value encoded in the code.
   * Absent = no tag/QR is linked to this spool yet.
   */
  tagId?: string
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
  /** Optional link to a saved store this order was/should be placed with. */
  storeId?: string
}

/**
 * A saved shop the user buys filament from. Rendered as a quick-launch button in
 * the Orders tab that opens `url` in a new browser tab (e.g. "Amazon").
 */
export interface OrderStore {
  id: string
  name: string
  /** Absolute URL (normalised to include a scheme before saving). */
  url: string
}

/**
 * One day's aggregated filament consumption, keyed (in the log) by
 * `day|printerId|material|color`. Written going forward as printers extrude, so
 * the Statistik charts are built from real usage rather than estimates.
 */
export interface ConsumptionBucket {
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  printerId: string
  printerName: string
  material: string
  /** Hex color of the filament. */
  color: string
  colorName: string
  /** Grams consumed that day for this printer/material/color. */
  grams: number
}

/**
 * A once-per-day snapshot of overall storage fullness, powering the
 * "storage usage over time" line chart. Deduped by `day`.
 */
export interface StorageSnapshot {
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  usedSlots: number
  totalSlots: number
  totalGrams: number
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

/**
 * What a scanned RFID/QR tag points at. A tag is bound to exactly one of:
 * - a spool (follows the physical spool as it moves around),
 * - a shelf in a storage unit (scanning it shows that shelf's contents),
 * - a printer slot / toolhead / AMS tray (a fixed spot on a machine).
 *
 * A whole single-shelf unit (a plain shelf or a library) is represented as its
 * shelf 0, so "bind to this unit" and "bind to a shelf" share one kind.
 */
export type TagTarget =
  | { kind: "spool"; spoolId: string }
  | { kind: "shelf"; nodeId: string; shelf: number }
  | { kind: "printerSlot"; printerId: string; slot: number }

export type TagBindingVia = "nfc" | "qr" | "manual"

/**
 * A binding from a stable tag id to what it represents. Stored on
 * `Settings.tagBindings` so it syncs across every device (the wall display sees
 * a phone's scan immediately). The `id` is the NFC hardware serial number, or
 * the `PAX:<uuid>` value encoded in a printable QR code.
 */
export interface TagBinding {
  id: string
  target: TagTarget
  /** When the binding was created (ms epoch). */
  boundAt: number
  /** How the tag was first written, for display in the tag manager. */
  via?: TagBindingVia
}

/**
 * A paired wireless RFID/NFC reader (ESP32, Raspberry Pi, or similar). The
 * `token` is a high-entropy shared secret the device is flashed with; the app
 * subscribes to it to receive scans. Bindings themselves live in `tagBindings`,
 * so a reader only ever reports a tag uid — no per-reader data model beyond this.
 */
export interface RfidReader {
  id: string
  /** Friendly name shown in the UI, e.g. "Workbench reader". */
  name: string
  /** Pairing token / channel id the device posts with. Treat as a secret. */
  token: string
  /** What kind of device it is, for the setup instructions shown in the app. */
  kind: "esp32" | "pi" | "other"
  createdAt: number
}

/** Where a spool currently lives. */
export type SpoolPlacement =
  | { type: "storage"; shelf: number; slot: number }
  | { type: "printer"; printerId: string; slot: number }

export type PrinterKind = "single" | "ams" | "toolchanger"

/** Lifecycle of an external dispense/load request queued via the printer API. */
export type DispenseStatus = "pending" | "running" | "done" | "error" | "canceled"

/**
 * A filament-dispense request submitted by an external printer UI through the
 * PAX printer API. It is written into the shared document as `pending`; an open
 * PAX screen then runs the normal guided pick and advances the status. The slot
 * is addressed exactly the way PAX models storage internally — node + shelf +
 * slot — so it is unambiguous across multiple paternosters.
 */
export interface DispenseRequest {
  id: string
  /** Which storage node (paternoster/shelf) holds the spool. */
  nodeId: string
  /** 0-based shelf index within the node. */
  shelf: number
  /** 0-based slot index within the shelf. */
  slot: number
  /** Spool id resolved when the request was accepted (audit/display only). */
  spoolId?: string | null
  /** Printer that asked for it, when known — for display in the queue. */
  printerId?: string | null
  /** Optional free-form note from the requester, e.g. "T0 reload". */
  note?: string
  status: DispenseStatus
  /** Epoch-ms timestamps. */
  createdAt: number
  updatedAt: number
  /** Human-readable reason, populated when `status` is "error". */
  error?: string
  /** How the request arrived, for display. Defaults to "api". */
  source?: "api" | "manual"
}

/**
 * A single AMS unit attached to a printer. Units can differ in size (e.g. a
 * 4-slot AMS alongside a 1-slot AMS Lite / external spool) and carry a custom
 * name the user can rename freely.
 */
export interface AmsUnit {
  id: string
  /** User-facing name, e.g. "AMS", "AMS Lite", "External". */
  name: string
  /** Number of filament slots in this unit (>= 1). */
  slots: number
}

export interface Printer {
  id: string
  name: string
  kind: PrinterKind
  /**
   * AMS printers: the connected AMS units, each with its own slot count and
   * custom name. When present this is the source of truth for slot layout; the
   * legacy `amsUnits`/`slotsPerAms` fields are kept in sync (derived) so older
   * call sites keep working. `migrate()` synthesises this for printers saved
   * before mixed AMS support existed.
   */
  ams?: AmsUnit[]
  /** AMS only: number of AMS units connected. Derived from `ams` when present. */
  amsUnits: number
  /** AMS only: spools per AMS unit (legacy uniform value; see `ams`). */
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
  /**
   * Optional URL of the printer's own web UI (Mainsail / Fluidd / vendor UI) to
   * embed in PAX's Printers section. When omitted, PAX falls back to
   * `http://<ip>` so a plain IP is enough to get an embedded view.
   */
  webUrl?: string
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
  /**
   * Live level of the physical shelf proximity sensor, as last reported by the
   * Pi agent over the wire (the `sensor` event). `true` = a shelf's metal flag
   * is in the sensor window, `false` = nothing detected, `null`/undefined =
   * unknown (no hardware link, or a simulated node). The carousel indicator
   * shows this real reading when known and falls back to an inferred state
   * otherwise.
   */
  sensor?: boolean | null
  /**
   * Set when the Pi agent reported a fault (e.g. a shelf passed without the
   * sensor confirming it, or a pulse timeout) and the carousel stopped as a
   * safety measure. While set, the position is UNKNOWN and the machine must not
   * move by itself: the app shows a blocking "position lost" dialog and waits
   * for the operator to explicitly home or dismiss. Cleared when homing starts.
   * `acknowledged` = the operator dismissed the dialog without homing; the
   * warning then stays in the sidebar until they home. Runtime-only — never
   * persisted or synced (a fault on one device's link is not a command to
   * peers).
   */
  fault?: MachineFault | null
  /**
   * Set when a REAL carousel needs its first homing sweep (never homed and its
   * Pi just came online) and the app is waiting for the operator to say go.
   * Homing spins the carousel — possibly a full revolution — so it must never
   * start by surprise on a unit that was just wired up. The app shows a
   * blocking dialog; "Home now" starts the sweep, "Not now" leaves the unit
   * parked un-homed with a sidebar reminder. Runtime-only, never persisted.
   * `acknowledged` = dismissed with "Not now".
   */
  homingRequest?: { at: number; acknowledged: boolean } | null
}

/** A safety stop reported by the Pi agent. See {@link Machine.fault}. */
export interface MachineFault {
  /** The agent's own message, e.g. "Shelf pulse timeout (8.0s)". */
  message: string
  /** Epoch-ms when the fault arrived. */
  at: number
  /** Operator dismissed the blocking dialog without homing. */
  acknowledged: boolean
}

/**
 * A job in the active queue. `mode` describes the whole operation:
 * - "pick": move spools from storage onto a printer
 * - "store": move spools from a printer into storage
 * - "place": place brand new spools into storage
 */
export type QueueMode = "pick" | "store" | "place"

export interface QueueItem {
  /**
   * Id of the occupant being moved. For a filament job this is a spool id; for a
   * hardware job (`occupantKind: "part"`) it is a {@link HardwarePart} id. The
   * field name is kept for backwards-compat with the existing motion engine.
   */
  spoolId: string
  /**
   * What kind of occupant `spoolId` refers to. Absent/`"spool"` = a filament
   * spool (default, so every existing job keeps working); `"part"` = a hardware
   * part box. The store/confirm steps branch on this to write the right slot and
   * skip filament-only fields (grams edits, history logging).
   */
  occupantKind?: OccupantKind
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
  /**
   * Hardware count change applied at the moment the carousel reaches this slot
   * (only set for `occupantKind: "part"` jobs). `"add"` grows the box (store
   * more), `"take"` removes pieces (take out); a take that empties the box also
   * frees the slot and deletes the part. Absent for a plain new-box placement,
   * whose count is already set on the part when it is created.
   */
  partOp?: { kind: "add" | "take"; count: number }
  /**
   * Slots the operator has already turned down for this item at the placing
   * prompt ("too tight, find another"). Every re-pick excludes all of them, so
   * the system never offers the same slot twice for the same spool.
   */
  rejectedSlots?: { nodeId: string; shelf: number; slot: number }[]
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
  /** Ask the user to confirm before every carousel movement (filament units). */
  confirmBeforeMove: boolean
  /**
   * Same safety gate, but for hardware units. Kept separate so each area toggles
   * independently. Optional for backwards-compat with saves made before the
   * hardware area existed; falls back to `confirmBeforeMove` when absent.
   */
  confirmBeforeMoveHardware?: boolean
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
  /**
   * RFID/QR tag bindings: each maps a stable tag id to the spool, shelf, or
   * printer slot it represents. Synced across devices so a scan on a phone is
   * reflected everywhere. Optional for backwards-compat with old saves.
   */
  tagBindings?: TagBinding[]
  /**
   * Paired wireless RFID/NFC readers (ESP32 / Raspberry Pi). Each holds a
   * pairing token the physical device is flashed with; the app listens on that
   * token so any browser — including iPhones, which can't read NFC on the web —
   * can receive scans from the hardware reader.
   */
  readers?: RfidReader[]
  /** Incoming filament orders / carts waiting to be received into storage. */
  orders?: FilamentOrder[]
  /** Saved shops (name + URL) shown as quick-launch buttons in the Orders tab. */
  stores?: OrderStore[]
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
  /**
   * Which tracking area the app is currently showing. Persisted so the choice
   * survives reloads. Defaults to "filament" when absent.
   */
  activeArea?: SystemKind
  /** Saved hardware categories the user can pick when adding a part. */
  hardwareCategories?: HardwareCategory[]
  /** Saved hardware color presets (name + hex) for the part color picker. */
  hardwareColorPresets?: { name: string; hex: string }[]
  /** Saved shops (name + URL) shown as quick-launch buttons in Hardware Orders. */
  hardwareStores?: OrderStore[]
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
   * Which tracking area this unit belongs to. "filament" stores spools;
   * "hardware" stores {@link HardwarePart} boxes (bolts, nuts, …). The two areas
   * never mix in the UI — every node list is filtered by the active area's
   * system. Optional for backwards-compat with older saves (treated as
   * "filament", so existing paternosters stay in the filament area).
   */
  system?: SystemKind
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
  /**
   * Pairing state for a real slave unit linked by a PAIRING CODE instead of an
   * IP address. A slave never has a fixed, known address (DHCP), so it connects
   * OUT to the master and presents this code ("phone-home"); the master then
   * binds that physical unit to this record. No IP is ever typed by hand.
   *
   * - "unpaired": created as a real slave, waiting to be linked.
   * - "pairing":  a code has been issued and we're waiting for the slave to check in.
   * - "paired":   a slave has claimed the code and is linked.
   *
   * Absent on manual units (shelf/library) and on legacy nodes configured the
   * old IP way, which keep using {@link link}.
   */
  pairStatus?: "unpaired" | "pairing" | "paired"
  /** Short human code shown while waiting for the slave to check in (pairing). */
  pairingCode?: string
  /** Stable id the paired slave reports once linked (mock: generated locally). */
  deviceId?: string
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
   * Soft START ramp intensity, 0–100%. 0 = no easing; higher values ease the
   * carousel in at the start of a rotation. It deliberately does NOT soften the
   * stop: arrival cuts power the instant the shelf sensor triggers, because any
   * ramp there keeps driving past the flag that was just detected.
   */
  rampPct?: number
  /**
   * PWM duty for moves, 0.05–1 (5–100%). This IS the carousel speed and is sent
   * to the motor as-is.
   *
   * There is deliberately no seconds-per-shelf setting any more. Position is
   * established by homing plus shelf-sensor counting, never from elapsed time,
   * so a second control expressing "speed" as a duration only fought this one.
   */
  pwmDuty?: number
  /**
   * PWM duty for HOMING, 0.05–1 (5–100%). Undefined = track the move duty
   * (`homingDutyFor` derives a gentler fraction of it).
   *
   * Separate from `pwmDuty` because the two searches are not the same problem.
   * A move counts shelf flags it already knows the spacing of; homing hunts for
   * a single index flag from an unknown start, so it is the move most likely to
   * coast past its target — and the one whose overshoot is worst, since every
   * later position is measured from it.
   */
  homingDuty?: number
  /**
   * PWM duty for the slow APPROACH onto the target shelf, 0.05–1 (5–100%).
   * Undefined = the default crawl (`approachDutyFor` falls back to 0.25).
   *
   * This is the "slow speed" the carousel eases down to just before the final
   * shelf so the target flag is caught gently instead of overshot. Separate from
   * `pwmDuty` (the cruise speed between shelves): a heavy carousel needs a brisk
   * cruise but a very slow arrival, and one control cannot serve both.
   */
  approachDuty?: number
  /**
   * Weight compensation: kilograms of carousel load per +1% of motor speed.
   * 0.5–10 kg; undefined = off.
   *
   * A loaded carousel turns slower at the same PWM duty because the motor has
   * more mass to drag. This setting adds a boost on top of Motor PWM, Homing PWM
   * and Approach speed proportional to the weight currently in the carousel
   * (`loadBoostPctFor`): every `loadCompKg` of load adds `loadCompPct` percent,
   * so at 3 kg per 2%, 9 kg of spools adds +6% to each. The boost follows the
   * live load in both directions, so removing spools lowers it again. The
   * sliders keep showing the operator's base values; the boosted duties are
   * what actually go to the Pi.
   */
  loadCompKg?: number
  /**
   * Weight compensation, boost per step in percent (1–10). Defaults to 1 when
   * unset so nodes saved before this field existed keep their "+1% per step".
   */
  loadCompPct?: number
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

// ---------------------------------------------------------------------------
// Hardware tracking (parallel area to filament)
// ---------------------------------------------------------------------------

/** Which tracking area something belongs to. */
export type SystemKind = "filament" | "hardware"

/**
 * The top-level dashboard area. Extends the two storage systems with a
 * self-contained "printers" area (3D-printer management + embedded UIs). Kept
 * separate from `SystemKind` so node/storage logic — which only knows filament
 * vs hardware — stays exhaustive and unaffected.
 */
export type TopArea = SystemKind | "printers"

/** What a storage slot / queue item holds. */
export type OccupantKind = "spool" | "part"

/**
 * A batch of identical hardware pieces stored in a single carousel slot — e.g.
 * "25× M5×40 bolts". The slot's balance weight is `count * perPieceWeightGrams`,
 * so the shared paternoster balance engine places a box exactly as it would a
 * spool of that total mass. One part type occupies one slot; "store more" grows
 * `count`, taking all of it out frees the slot.
 */
export interface HardwarePart {
  id: string
  /** Display name, e.g. "M5×40 socket screw". */
  name: string
  /** Category name (matches a saved {@link HardwareCategory}); free-form. */
  category: string
  /** How many pieces are in this box right now. */
  count: number
  /** Weight of a single piece in grams (used for carousel balance). */
  perPieceWeightGrams: number
  /** Free-text search tags (e.g. "steel", "M5", "hex"). */
  tags: string[]
  /** Hex color the slot/box is rendered in. */
  color: string
  /** Human-readable color name, e.g. "Steel Blue". */
  colorName: string
  /**
   * Low-stock threshold. When `count <= lowStockThreshold` a notice surfaces on
   * the Hardware nav + list. `null`/absent = never notify for this part.
   */
  lowStockThreshold?: number | null
  /**
   * Optional photo of the part (a data URL or remote URL). Shown in the Home
   * carousel tote and the "All Hardware" list so a part is recognizable at a
   * glance. Absent/null falls back to the colored tote graphic.
   */
  imageUrl?: string | null
  createdAt: number
}

/** A saved hardware category the user can pick/create when adding parts. */
export interface HardwareCategory {
  id: string
  name: string
}

/** A single line item in an incoming hardware order / cart. */
export interface HardwareOrderItem {
  id: string
  name: string
  category: string
  /** How many pieces of this item are on order. */
  quantity: number
}

/** A named incoming hardware order / shopping cart. */
export interface HardwareOrder {
  id: string
  name: string
  createdAt: number
  items: HardwareOrderItem[]
  /** Optional link to a saved store this order was/should be placed with. */
  storeId?: string
}

export interface AppState {
  /** Whether first-run setup has been completed. */
  configured: boolean
  settings: Settings
  /** spoolId -> Spool */
  spools: Record<string, Spool>
  /** partId -> HardwarePart (hardware-area occupants) */
  parts: Record<string, HardwarePart>
  /** Linked storage units. Always has at least one (the master). */
  nodes: StorageNode[]
  /** Which node the storage UI is currently focused on. */
  activeNodeId: string
  printers: Printer[]
  activePrinterId: string | null
  /**
   * Filament-dispense requests queued by external printer UIs (via the printer
   * API). Shared + synced so any open PAX screen can pick one up and run the
   * guided pick. Newest last; capped in the reducer.
   */
  dispenseRequests: DispenseRequest[]
  /**
   * Optional shared token that printer-facing API calls must present in the
   * `x-pax-token` header. When empty/undefined the endpoints are open on the
   * LAN. Shared + synced so every device agrees on the same token.
   */
  apiToken?: string
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
  /** Per-day, per-printer/material/color consumption for the Statistik charts. */
  consumptionLog: ConsumptionBucket[]
  /** Once-per-day storage fullness snapshots for the storage-over-time chart. */
  storageSnapshots: StorageSnapshot[]
  /** Incoming hardware orders / carts waiting to be received into storage. */
  hardwareOrders: HardwareOrder[]
  /**
   * Hardware parts the operator has queued to take out, as part ids. The user
   * assembles this list first, then presses "Ready to take out" to run one pick
   * job that visits each part in turn — the take quantity for each is entered at
   * the stop, not here. Ephemeral runtime state, never persisted.
   */
  hwPickQueue: string[]
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
  /** partId -> HardwarePart (hardware-area occupants; shared + synced). */
  parts: Record<string, HardwarePart>
  /** Incoming hardware orders / carts (shared + synced). */
  hardwareOrders: HardwareOrder[]
  nodes: StorageNode[]
  activeNodeId: string
  printers: Printer[]
  activePrinterId: string | null
  /** Queued external dispense requests (shared + synced). */
  dispenseRequests: DispenseRequest[]
  /** Optional shared API token for printer-facing endpoints (shared + synced). */
  apiToken?: string
  /** Filament usage/movement log (shared + synced across devices). */
  history: HistoryEvent[]
  /** Lifetime + resettable filament-consumption tracking (shared + synced). */
  usage: FilamentUsage
  /** Per-day consumption buckets for statistics (shared + synced). */
  consumptionLog: ConsumptionBucket[]
  /** Daily storage snapshots for statistics (shared + synced). */
  storageSnapshots: StorageSnapshot[]
}
