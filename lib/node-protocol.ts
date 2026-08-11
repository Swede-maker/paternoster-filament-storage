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

/** Tell the agent how many shelves this carousel has (sent after connect). */
export interface ConfigCommand {
  type: "config"
  shelves: number
}

export type NodeCommand = HelloCommand | HomeCommand | GotoCommand | StopCommand | ConfigCommand

// ---------------------------------------------------------------------------
// Pi -> App (events)
// ---------------------------------------------------------------------------

/** Sent by the agent right after the socket opens. */
export interface HelloEvent {
  type: "hello"
  name?: string
  shelves?: number
  firmware?: string
}

/** Full status snapshot; sent on connect and whenever something changes. */
export interface StateEvent {
  type: "state"
  status: "idle" | "moving" | "homing"
  shelf: number
  homed: boolean
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
}

/** Homing finished; `shelf` is the index the machine settled on (usually 0). */
export interface HomedEvent {
  type: "homed"
  shelf: number
}

/** A hardware fault, e-stop, or command that could not be completed. */
export interface FaultEvent {
  type: "fault"
  message: string
}

export type NodeEvent = HelloEvent | StateEvent | PosEvent | ArrivedEvent | HomedEvent | FaultEvent

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
    case "fault":
      return msg as NodeEvent
    default:
      return null
  }
}
