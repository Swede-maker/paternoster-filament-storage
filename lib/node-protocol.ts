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
 * - "index": servo only — like "pulses", but only the home (index) sensor is
 *   wired. No shelf sensor, so no fallback: an uncalibrated `goto` is refused.
 */
export type PositionMode = "sensor" | "pulses" | "index"

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
   * Servo only: invert motor B's DIR so two facing servos pull the same way.
   * A DC carousel has one motor, so the DC backend ignores it.
   */
  servoMirrorB?: boolean
  /** Servo only: drive the carousel with motor A alone (hardware carousels). */
  servoSingleMotor?: boolean
  /** Twin side only: flip this carousel's one motor (motor A or B). */
  reverseDir?: boolean
  /**
   * Hardware twin mode: split the Pi into two carousels (see `TwinSide`). Sent
   * on every config from a twin unit so a rebooted agent re-splits before the
   * per-side settings arrive.
   */
  twin?: boolean
  /** Servo only: treat the ALM inputs as healthy (ALM+/ALM− not wired). */
  servoIgnoreAlarm?: boolean
  /**
   * Servo only (pax-agent-1.9+): pulse source. A change rebuilds the agent's
   * backend while idle, like a drive change. Omitted = keep the current one.
   */
  servoDriver?: ServoDriver
  /**
   * PUL/DIR only (pax-agent-1.9+): which kind of drive sits on the pulse
   * lines. Picks the enable/alarm polarity, the pulse-rate ceiling and the
   * wording of the release setting. Omitted = keep the agent's current one.
   */
  pulseDrive?: PulseDrive
  /** PUL/DIR: override the profile's enable-input polarity (GPIO LOW = engaged). */
  pulseEnableActiveLow?: boolean
  /** PUL/DIR: override the profile's alarm-output polarity (pin LOW = fault). */
  pulseAlarmActiveLow?: boolean
  /** ESP32 controller: USB cable or header UART. */
  esp32Link?: Esp32Link
  /** ESP32 controller: explicit serial device ("" = auto-detect by link). */
  esp32Port?: string
  /** ESP32 controller: link baud, must match the firmware (default 460800). */
  esp32Baud?: number
  /**
   * Servo only: idle seconds before the agent de-energises the drives so the
   * carousel can be moved by hand. 0 = never release (hold with full torque
   * until the servo supply is switched off).
   */
  servoHoldTimeoutS?: number
  /** Seconds after a move/home starts before sensors count. 0 = off. */
  sensorArmS?: number
  /** Homing time: seconds to find the index flag before faulting (pax-agent-1.6+). */
  homeTimeoutS?: number
  /** Shelf timeout: seconds without a shelf flag before a move faults (pax-agent-1.7+). */
  shelfTimeoutS?: number
  /** Sensor counting or calibrated pulses (pax-agent-1.5+). */
  positionMode?: PositionMode
  /**
   * The app's copy of the last calibration, so a re-installed agent gets it
   * back. An agent that already holds its own measurement ignores these.
   */
  servoCarouselPulses?: number
  servoIndexWindowPulses?: number
  /** Re-zero on every home-flag pass in pulse positioning (default true). */
  homeResync?: boolean
}

/**
 * How the carousel is driven:
 * - "dc":    one brushed DC motor on a BTS7960 bridge, speed = PWM duty.
 * - "servo": any pulse + direction drive (integrated servo, AC servo or
 *            closed-loop stepper), one per chain, speed = pulse frequency.
 *            Which kind is `PulseDrive`; the mode name stays "servo" on the
 *            wire so older agents keep working.
 */
export type MotorMode = "dc" | "servo"

/**
 * The drive on the PUL/DIR lines (motorMode "servo"):
 * - "integrated-servo":   iSV57T-class motor with the drive built in. No enable
 *                          input, ALM conducts while healthy, up to 300 kHz.
 * - "ac-servo":            A6-RS-class separate servo drive (DB44). S-ON enable,
 *                          ALM conducts while healthy, up to 300 kHz.
 * - "closed-loop-stepper": CL86Y-class closed-loop stepper drive. MF input frees
 *                          the coils when active, ALM conducts ON a fault, up to
 *                          200 kHz.
 */
export type PulseDrive = "integrated-servo" | "ac-servo" | "closed-loop-stepper"
export const PULSE_DRIVES: readonly PulseDrive[] = ["integrated-servo", "ac-servo", "closed-loop-stepper"]

/**
 * Servo drive only: what generates the PUL/DIR trains.
 * - "gpio":  the Pi header, bit-banged by the agent (iSV57T wiring).
 * - "esp32": an ESP32 running pi-agent/esp32-servo (A6-RS wiring). It owns the
 *            pulse timers AND both sensors; the agent talks to it over serial
 *            and keeps all motion decisions (pax-agent-1.9+).
 */
export type ServoDriver = "gpio" | "esp32"
/** How the Pi reaches the ESP32: its USB cable, or 3 wires on the GPIO header. */
/**
 * How the agent reaches the ESP32 controller. "wifi" = a standalone board
 * with no Pi on its carousel; the agent instance connects to it over TCP
 * (pax-esp32-xxxx.local:8766) and the board falls back to the master's
 * hotspot when the router is gone.
 */
export type Esp32Link = "usb" | "uart" | "wifi"
export const DEFAULT_ESP32_BAUD = 460800

/**
 * Which motor a jog addresses on the servo pair. "both" moves the pair in
 * lockstep. A DC carousel has one motor, so the DC backend ignores this field
 * (send "a").
 */
export type ServoMotorId = "a" | "b" | "both"

/**
 * Nudge the carousel by a small amount. Servo pair: one motor (or both) for
 * chain alignment, `pulses` = exact step count. DC: the carousel's one motor,
 * `ms` = run time at `speed` duty. The agent answers with `state`
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

/**
 * Twin mode (hardware units only): one Pi drives two independent carousels,
 * motor A + the primary sensors = "left", motor B + the R sensors = "right".
 * Motion commands and motion events carry `side`; a frame without it means
 * "left" (and is the only form a non-twin agent ever sees or sends).
 */
export type TwinSide = "left" | "right"
export const TWIN_SIDES: readonly TwinSide[] = ["left", "right"]

export interface Sided {
  side?: TwinSide
}

export type NodeCommand =
  | HelloCommand
  | (HomeCommand & Sided)
  | (GotoCommand & Sided)
  | (StopCommand & Sided)
  | (ReleaseCommand & Sided)
  | (HoldCommand & Sided)
  | (CalibrateCommand & Sided)
  | (ConfigCommand & Sided)
  | (JogCommand & Sided)
  | NetCommand

/** Read the side of an incoming frame without fully parsing it as an event. */
export function frameSide(data: string): TwinSide | undefined {
  if (!data.includes('"side"')) return undefined
  try {
    const side = (JSON.parse(data) as { side?: unknown }).side
    return side === "left" || side === "right" ? side : undefined
  } catch {
    return undefined
  }
}

export type NetPin = "auto" | "router" | "ap"
/** "esp32": an agent instance that fronts a standalone Wi-Fi ESP32 carousel and only relays credentials to it. */
export type NetRole = "master" | "slave" | "esp32"
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
  /** The servo pulse source the agent is running (pax-agent-1.9+). */
  servoDriver?: ServoDriver
  /** The PUL/DIR drive profile the agent is running (pax-agent-1.9+). */
  pulseDrive?: PulseDrive
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
  /** Servo drive (pax-agent-1.9+): which pulse source is live. */
  driver?: ServoDriver
  /** PUL/DIR (pax-agent-1.9+): the drive profile the backend is running. */
  pulseDrive?: PulseDrive
  /** ESP32 controller: the serial link is up and the board is streaming status. */
  linkOk?: boolean
  /** ESP32 controller: link type, device in use, baud and firmware version. */
  link?: Esp32Link
  port?: string | null
  baud?: number
  esp32Firmware?: string | null
  /** ESP32 controller: why the link is down (null while it is up). */
  linkError?: string | null
  /** ESP32 over Wi-Fi (fw 1.2+): the board's mDNS name, which network it is on, signal and address. */
  esp32Host?: string | null
  esp32Wifi?: "router" | "ap" | "connecting" | "offline" | "disabled" | null
  esp32Rssi?: number | null
  esp32Ip?: string | null
  /** Servo drive: the agent's live idle auto-release timeout in seconds; 0 = never. */
  holdTimeoutS?: number
  /** The agent's effective homing time in seconds (pax-agent-1.6+). */
  homeTimeoutS?: number
  /** The agent's effective shelf timeout base in seconds (pax-agent-1.7+). */
  shelfTimeoutS?: number
  /** Measured seconds between two consecutive shelf flags at cruise, once learned. */
  shelfPitchS?: number | null
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
   * null when no shelf sensor is fitted ("index" positioning).
   */
  onSensor?: boolean | null
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
  /** "esp32" = a standalone Wi-Fi controller board registered through its agent instance. */
  kind?: "pi" | "esp32"
  /** ESP32 boards: where the agent that drives it listens (the app connects there, not to the board). */
  agentHost?: string | null
  agentPort?: number | null
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
