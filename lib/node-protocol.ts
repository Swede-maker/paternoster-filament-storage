/**
 * WebSocket message protocol shared between the web app and the on-Pi agent.
 *
 * This file is the single source of truth for the wire format. The Python agent
 * in `pi-agent/paternoster_agent.py` implements the exact same message shapes.
 * Keep the two in sync when you change anything here.
 *
 * Transport: a plain WebSocket. The app is the client; each Pi agent is a
 * server listening on ws://<node.ip>:<node.port>/. All messages are JSON with a
 * `type` discriminator.
 *
 * Shelf indexes are ALWAYS 0-based on the wire (shelf 0 = the "home"/index
 * shelf detected by the dedicated single-shelf inductive sensor). The UI adds 1
 * for display only.
 */

// ---------------------------------------------------------------------------
// App -> Pi (commands)
// ---------------------------------------------------------------------------

/** Ask the agent to identify itself (it also sends `hello` on connect). */
export interface HelloCommand {
  type: "hello"
}

/** Run the homing routine: rotate until the shelf-1 index sensor triggers. */
export interface HomeCommand {
  type: "home"
}

/** Rotate to a target shelf index (0-based) using the shelf-count sensor. */
export interface GotoCommand {
  type: "goto"
  shelf: number
}

/** Immediately stop the motor (emergency stop / cancel). */
export interface StopCommand {
  type: "stop"
}

/**
 * Servo only: cut the servo supply (optional relay) so the carousel can be turned by
 * hand. Refused with a `fault` while moving; the next move or jog re-engages
 * the servos automatically. Answered with a `servo` frame (`held: false`).
 */
export interface ReleaseCommand {
  type: "release"
}

/** Servo only: re-energise the drives now instead of waiting for the next move. */
export interface HoldCommand {
  type: "hold"
}

/**
 * Servo only (pax-agent-1.5+): measure the carousel in pulses. One continuous
 * run at homing speed: home on the index flag, keep going a full turn, stop on
 * the index flag again. Answered with `homed`, then a `calibration` frame.
 */
export interface CalibrateCommand {
  type: "calibrate"
}

/**
 * How a `goto` finds its shelf.
 * - "sensor": count shelf-flag edges on the proximity sensor (the only option on DC).
 * - "pulses": servo only — drive a calibrated number of pulses per shelf from the
 *   home datum, re-synchronised on every pass of the index flag. Needs a
 *   calibration run; the agent falls back to the sensor (with a `fault` note)
 *   when it cannot position by pulses.
 */
export type PositionMode = "sensor" | "pulses"

/**
 * Push machine settings to the agent: shelf count plus the live motion tuning
 * behind the speed and soft-start sliders. Sent after connect and again
 * whenever the operator changes a slider.
 *
 * The motion fields are optional so an older agent can ignore them, but if they
 * are omitted the agent keeps its previous values — the app must send them for
 * the sliders to have any effect on the hardware.
 */
export interface ConfigCommand {
  type: "config"
  shelves: number
  /** PWM duty (0..1) for normal moves, derived from seconds-per-shelf. */
  moveSpeed?: number
  /** PWM duty (0..1) used while homing. */
  homingSpeed?: number
  /** Soft start/stop ramp intensity, 0–100%. 0 = no easing. */
  rampPct?: number
  /** PWM duty (0..1) for the slow approach onto the final/target shelf. */
  approachSpeed?: number
  /**
   * Which motor backend the agent should run. The agent persists this and
   * hot-swaps its hardware layer (when idle) if it differs from the current one.
   * Omitted = keep the agent's current/persisted mode.
   */
  motorMode?: MotorMode
  /** Servo only: command pulses per motor revolution (must match DIP S1–S3 / Pr0.08). */
  servoPulsesPerRev?: number
  /** Servo only: pulse frequency at 100 % speed, in pulses/s (≤ 300 000 per the iSV57T manual). */
  servoMaxPps?: number
  /**
   * Invert motor B's direction so two facing motors pull the same way. Applies
   * to both drives (DIR line on the servos, RPWM/LPWM swap on the DC bridge).
   */
  servoMirrorB?: boolean
  /** Servo only: treat the ALM inputs as healthy (ALM+/ALM− not wired). */
  servoIgnoreAlarm?: boolean
  /**
   * Servo only: idle seconds before the agent de-energises the drives so the
   * carousel can be moved by hand. 0 = never release (hold with full torque
   * until the servo supply is switched off).
   */
  servoHoldTimeoutS?: number
  /** Sensor counting or calibrated pulses (pax-agent-1.5+). */
  positionMode?: PositionMode
  /**
   * The app's copy of the last calibration, so a re-installed agent gets it
   * back. An agent that already holds its own measurement ignores these.
   */
  servoCarouselPulses?: number
  servoIndexWindowPulses?: number
}

/**
 * How the carousel's two motors (one per chain, one on each side) are driven:
 * - "dc":    two brushed DC motors, each on its own BTS7960 bridge, speed = PWM duty.
 * - "servo": two iSV57T integrated servos on PUL/DIR, speed = pulse frequency.
 */
export type MotorMode = "dc" | "servo"

/** Which motor a jog addresses. "both" moves the pair in lockstep. */
export type ServoMotorId = "a" | "b" | "both"

/**
 * Nudge one motor (or both) for chain alignment. The amount is in the drive's
 * own unit: `pulses` (exact step count) on the servo pair, `ms` (run time at
 * `speed` duty) on the DC bridges. The agent answers with `state`
 * (moving → idle) and a `servo` frame; an amount in the wrong unit for the
 * live drive is refused with a `fault`.
 */
export interface JogCommand {
  type: "jog"
  motor: ServoMotorId
  direction: "up" | "down"
  /** Servo drive: exact pulse count. */
  pulses?: number
  /** DC drive: run time in milliseconds. */
  ms?: number
  /** DC drive: PWM duty 0..1 for the jog (agent default when omitted). */
  speed?: number
}

// ---- Networking (Wi-Fi / hotspot / slave provisioning) --------------------
// Handled by `paxnet.py` on the Pi. Only meaningful for `driver: "hardware"`
// nodes running Raspberry Pi OS Bookworm+ (NetworkManager).

/** Ask for a fresh `net.status` (and `net.slaves` on a master). */
export interface NetStatusCommand {
  type: "net.status"
}
/** Rescan Wi-Fi; answered by a `net.scan` event. */
export interface NetScanCommand {
  type: "net.scan"
}
/** Save the router as `pax-router` and connect. A master pushes the same
 * credentials to all registered slaves BEFORE switching itself. */
export interface NetJoinCommand {
  type: "net.join"
  ssid: string
  /** Empty string for an open network. */
  psk: string
}
/** Pin the mode: auto = fallback logic, router = never fall back, ap = force hotspot (master only). */
export interface NetModeCommand {
  type: "net.mode"
  mode: NetPin
}
/** Delete the saved router profile. */
export interface NetForgetCommand {
  type: "net.forget"
}
/** Master only: re-push the saved router credentials to every registered slave. */
export interface NetProvisionSlavesCommand {
  type: "net.provision-slaves"
}
/** Master only: change the hotspot password. Pushed to slaves before the
 * master's own profile is rewritten, so they keep a working fallback. */
export interface NetSetApPskCommand {
  type: "net.set-ap-psk"
  /** 8–63 characters (WPA2-PSK). */
  psk: string
}

export type NetCommand =
  | NetStatusCommand
  | NetScanCommand
  | NetJoinCommand
  | NetModeCommand
  | NetForgetCommand
  | NetProvisionSlavesCommand
  | NetSetApPskCommand

export type NodeCommand =
  | HelloCommand
  | HomeCommand
  | GotoCommand
  | StopCommand
  | ReleaseCommand
  | HoldCommand
  | CalibrateCommand
  | ConfigCommand
  | JogCommand
  | NetCommand

export type NetPin = "auto" | "router" | "ap"
export type NetRole = "master" | "slave"
/**
 * router     on the workshop router
 * ap         (master) serving its standalone hotspot
 * master-ap  (slave) camped on the master's hotspot
 * offline    radio up, nothing connected
 * unknown    paxnet could not answer (nmcli missing, etc.)
 */
export type NetMode = "router" | "ap" | "master-ap" | "offline" | "unknown"

// ---------------------------------------------------------------------------
// Pi -> App (events)
// ---------------------------------------------------------------------------

/** Sent by the agent right after the socket opens. */
export interface HelloEvent {
  type: "hello"
  name?: string
  shelves?: number
  firmware?: string
  /**
   * Present from pax-agent-1.1 on. Its absence is how the app tells that the
   * agent predates paxnet and will silently ignore every `net.*` command.
   */
  role?: NetRole
  /**
   * True when the agent is faking motion instead of driving GPIO — either from
   * `--simulate` or because gpiozero failed to initialise. Critically, such an
   * agent still connects and reports perfect motion, so without this flag a
   * dead motor is indistinguishable from a working one.
   */
  simulated?: boolean
  /** Human-readable cause, e.g. the gpiozero import/pin-factory error. */
  simReason?: string | null
  /**
   * The motor backend the agent is actually running (pax-agent-1.2+). Absent on
   * older agents, which only know the DC bridge.
   */
  motorMode?: MotorMode
}

/**
 * Motor drive status (the frame is still called `servo` on the wire for
 * compatibility). Sent on connect, whenever an ALM line changes, and around
 * each jog. `mode` is the backend the agent is actually running (pax-agent-1.3+
 * sends it in DC mode too). `alarmA`/`alarmB` are the servo drives' fault
 * outputs and are absent on the DC bridges — the agent also stops the pulse
 * train and emits a `fault` when one trips.
 */
export interface ServoEvent {
  type: "servo"
  mode: MotorMode
  alarmA?: boolean
  alarmB?: boolean
  pulsesPerRev?: number
  maxPps?: number
  mirrorB?: boolean
  /** Servo drive: true while the motors are energised and holding position (pax-agent-1.4+). */
  held?: boolean
  /** Servo drive: the agent's live idle auto-release timeout in seconds; 0 = never. */
  holdTimeoutS?: number
  /** DC drive: the longest timed jog the agent accepts, in ms. */
  jogMaxMs?: number
  /** Present on the frame emitted as a jog starts. */
  jogging?: boolean
  motor?: ServoMotorId
  direction?: "up" | "down"
  pulses?: number
  ms?: number
}

/** Full status snapshot; sent on connect and whenever something changes. */
export interface StateEvent {
  type: "state"
  status: "idle" | "moving" | "homing" | "calibrating"
  shelf: number
  homed: boolean
  /** pax-agent-1.5+: the positioning the agent is actually using. */
  positionMode?: PositionMode
  /** pax-agent-1.5+: whether a pulse calibration is on file. */
  calibrated?: boolean
}

/** Emitted each time the carousel passes a shelf (the per-shelf sensor). */
export interface PosEvent {
  type: "pos"
  shelf: number
}

/** The carousel reached its target shelf and stopped. */
export interface ArrivedEvent {
  type: "arrived"
  shelf: number
  /**
   * Diagnostic only: whether the shelf sensor saw metal at the instant motor
   * power was cut — the trigger that ended the move.
   *
   * This describes the stop DECISION, not the final resting place. A carousel
   * that coasts further than the sensor window can drift off the metal
   * afterwards while this still reads true, which is expected. Position comes
   * from the counted trigger, so this never invalidates the shelf number and the
   * agent never drives the motor to "correct" it. Persistent overshoot is
   * mechanical — lower the move speed.
   */
  onSensor?: boolean
  /** Which positioning produced this stop (pax-agent-1.5+). */
  positionMode?: PositionMode
  /** Sensor mode: shelf edges the distance filter threw out as bounce/re-entry. */
  rejectedEdges?: number
}

/**
 * Result of a `calibrate` run (servo). Also sent on connect when the agent has
 * a calibration on file (`restored: true` when it came from disk or the app
 * rather than a fresh measurement).
 */
export interface CalibrationEvent {
  type: "calibration"
  ok: boolean
  message: string
  /** Pulses for one full turn of the carousel (both motors in lockstep). */
  pulsesPerRev?: number
  /** `pulsesPerRev / shelves`, rounded. */
  pulsesPerShelf?: number | null
  /** Width of the index sensor's window in pulses, in the homing direction. */
  indexWindowPulses?: number | null
  /** Shelf-flag edges seen during the measuring turn (should equal `shelves`). */
  shelfFlagsSeen?: number | null
  shelves?: number | null
  /** Odometer correction applied at the most recent home pass, in pulses. */
  lastDriftPulses?: number | null
  restored?: boolean
}

/**
 * Pulse mode: the index flag passed the sensor mid-move and the odometer was
 * corrected by `driftPulses` without stopping. Small values are normal; more
 * than half a `pulsesPerShelf` also raises a `fault`.
 */
export interface SyncEvent {
  type: "sync"
  driftPulses: number
  pulsesPerShelf: number
}

/** Homing finished; `shelf` is the index the machine settled on (usually 0). */
export interface HomedEvent {
  type: "homed"
  shelf: number
}

/**
 * Live level of the single-shelf inductive proximity sensor (the NPN switch on
 * the Pi's GPIO), emitted whenever it changes and once on connect. `on` is the
 * LOGICAL "a shelf is present in the window" state — the agent has already
 * folded in sensor polarity (NPN/PNP) and the invert flag, so the app can use it
 * directly. This is a real hardware read, not inferred from position.
 */
export interface SensorEvent {
  type: "sensor"
  on: boolean
}

/** A hardware fault, e-stop, or command that could not be completed. */
export interface FaultEvent {
  type: "fault"
  message: string
}

/** Snapshot of the Pi's network situation; sent on connect and on every change. */
export interface NetStatusEvent {
  type: "net.status"
  role: NetRole
  /** The operator's pin (what was asked for). */
  pin?: NetPin
  /** What is actually happening right now. */
  mode: NetMode
  ssid?: string | null
  /** 0–100, STA modes only. */
  signal?: number | null
  ip?: string | null
  gateway?: string | null
  hostname?: string
  /** The hotspot SSID this unit serves (master) or falls back to (slave). */
  apSsid?: string
  routerSaved?: boolean
  /** Present when paxnet could not answer. */
  error?: string
  at?: number
}

export interface WifiNetwork {
  ssid: string
  /** 0–100 */
  signal: number
  /** e.g. "WPA2", "WPA1 WPA2", "open" */
  security: string
  inUse: boolean
}

export interface NetScanEvent {
  type: "net.scan"
  networks: WifiNetwork[]
}

/**
 * Outcome of a net.* operation. Some `op`s are advisory pre-announcements the
 * Pi sends right before it does something that will drop this very
 * connection: `join-starting` (leaving the hotspot for the router) and
 * `ap-starting` (leaving the router for the hotspot).
 */
export interface NetResultEvent {
  type: "net.result"
  op: string
  ok: boolean
  error?: string
  ssid?: string
  apSsid?: string
  mode?: NetPin
  /** provision-slaves */
  acked?: string[]
  failed?: string[]
}

export interface NetSlave {
  hostname: string
  mac?: string | null
  online: boolean
  mode?: NetMode | null
  ssid?: string | null
  ip?: string | null
}

/** Master only: the slaves that have registered with it. */
export interface NetSlavesEvent {
  type: "net.slaves"
  slaves: NetSlave[]
}

export type NetEvent = NetStatusEvent | NetScanEvent | NetResultEvent | NetSlavesEvent

export type NodeEvent =
  | HelloEvent
  | StateEvent
  | PosEvent
  | ArrivedEvent
  | HomedEvent
  | SensorEvent
  | ServoEvent
  | FaultEvent
  | CalibrationEvent
  | SyncEvent
  | NetEvent

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the ws:// URL for a node's agent. */
export function agentUrl(ip: string, port: number): string {
  return `ws://${ip}:${port}/`
}

/** Serialize a command for sending over the socket. */
export function encodeCommand(cmd: NodeCommand): string {
  return JSON.stringify(cmd)
}

/**
 * Parse and validate an incoming event. Returns null if the payload is not a
 * recognized event (so callers can safely ignore junk / partial frames).
 */
export function parseEvent(data: string): NodeEvent | null {
  let msg: unknown
  try {
    msg = JSON.parse(data)
  } catch {
    return null
  }
  if (!msg || typeof msg !== "object") return null
  const type = (msg as { type?: unknown }).type
  switch (type) {
    case "hello":
    case "state":
    case "pos":
    case "arrived":
    case "homed":
    case "sensor":
    case "servo":
    case "fault":
    case "calibration":
    case "sync":
    case "net.status":
    case "net.scan":
    case "net.result":
    case "net.slaves":
      return msg as NodeEvent
    default:
      return null
  }
}
