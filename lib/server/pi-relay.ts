import "server-only"
import WebSocket from "ws"
import { agentUrl, encodeCommand, type NodeCommand } from "@/lib/node-protocol"

/**
 * Server-side relay to the on-Pi agents.
 *
 * Instead of every browser opening its own `ws://<pi-ip>:<port>` socket (which
 * fails for any device that can't reach the Pi's LAN IP, or that loaded the app
 * over HTTPS and is blocked by mixed-content), the Next.js app server keeps a
 * SINGLE WebSocket per Pi endpoint and fans events out to all browsers.
 *
 * Browsers talk only to this app's own origin:
 *   - GET  /api/pi/stream   → Server-Sent Events (Pi frames + link status)
 *   - POST /api/pi/command  → forward a command to the Pi
 *
 * So the only machine that must reach the Pi is the app server itself — which,
 * self-hosted on the LAN, can. This module is a process-wide singleton; it must
 * only ever run on the server (guarded by `server-only`).
 */

const RECONNECT_MS = 3000
const HEARTBEAT_IDLE_MS = 10000
const HEARTBEAT_TIMEOUT_MS = 5000
const HEARTBEAT_TICK_MS = 3000

export type RelayLink = "checking" | "online" | "offline"

/**
 * A frame pushed to subscribers: either a link-status change or a Pi event.
 * `reason` carries the human-readable cause of an "offline" status so the UI can
 * explain *why* the handshake failed instead of just showing "offline".
 */
export type RelayFrame =
  | { kind: "link"; status: RelayLink; reason?: string }
  | { kind: "event"; data: string }

/**
 * Translate a raw socket error into something a human can act on. These are the
 * failures that actually happen when the app server can't reach the Pi, and each
 * one implies a different fix, so they're worth distinguishing.
 */
function describeSocketError(err: unknown): string {
  const code = (err as { code?: string } | null)?.code
  const msg = (err as { message?: string } | null)?.message ?? ""
  switch (code) {
    case "ECONNREFUSED":
      return "Connection refused — the Pi is reachable but nothing is listening on that port. Check the agent is running and bound to 0.0.0.0."
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "Host unreachable — this server has no network route to that address. It must be on the same LAN as the Pi."
    case "ETIMEDOUT":
      return "Connection timed out — usually a firewall dropping the packets, or the wrong IP."
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Hostname could not be resolved. Try the Pi's numeric IP instead of a .local name."
    case "ECONNRESET":
      return "Connection reset by the Pi before the handshake finished."
    default:
      return msg ? `Connection failed: ${msg}` : "Connection failed for an unknown reason."
  }
}

type Listener = (frame: RelayFrame) => void

interface Relay {
  ip: string
  port: number
  shelves: number
  ws: WebSocket | null
  link: RelayLink
  listeners: Set<Listener>
  reconnect: ReturnType<typeof setTimeout> | null
  heartbeat: ReturnType<typeof setInterval> | null
  lastRx: number
  pingSentAt: number | null
  /** Last `state` frame seen, replayed to new subscribers so they sync fast. */
  lastState: string | null
  /**
   * Why the last connection attempt failed. Kept so a browser that subscribes
   * *after* the failure still learns the reason, and so the reason survives the
   * offline → checking → offline retry cycle.
   */
  lastError: string | null
  closing: boolean
}

// Persist across HMR / module reloads in dev so we don't leak sockets.
const globalKey = "__pax_pi_relays__"
const registry: Map<string, Relay> =
  (globalThis as Record<string, unknown>)[globalKey] instanceof Map
    ? ((globalThis as Record<string, unknown>)[globalKey] as Map<string, Relay>)
    : new Map<string, Relay>()
;(globalThis as Record<string, unknown>)[globalKey] = registry

/**
 * SSRF guard: only allow connecting to private/LAN targets. The Pi lives on the
 * local network, so there's never a legitimate reason for the server to open a
 * socket to a public host on behalf of a browser.
 */
export function isAllowedTarget(ip: string): boolean {
  const host = ip.trim().toLowerCase()
  if (!host) return false
  if (host === "localhost" || host.endsWith(".local")) return true

  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b, c, d] = m.slice(1).map(Number)
  if ([a, b, c, d].some((n) => n > 255)) return false
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // loopback
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 169 && b === 254) return true // link-local
  return false
}

function keyFor(ip: string, port: number): string {
  return `${ip.trim().toLowerCase()}:${port}`
}

function broadcast(relay: Relay, frame: RelayFrame) {
  for (const listener of relay.listeners) {
    try {
      listener(frame)
    } catch {
      // A broken listener must not take down the relay.
    }
  }
}

function setLink(relay: Relay, link: RelayLink) {
  if (relay.link === link) return
  relay.link = link
  // Only an offline status carries a reason; clear it once we're connected.
  if (link === "online") relay.lastError = null
  broadcast(relay, {
    kind: "link",
    status: link,
    ...(link === "offline" && relay.lastError ? { reason: relay.lastError } : {}),
  })
}

function stopHeartbeat(relay: Relay) {
  if (relay.heartbeat) {
    clearInterval(relay.heartbeat)
    relay.heartbeat = null
  }
}

function startHeartbeat(relay: Relay) {
  stopHeartbeat(relay)
  relay.heartbeat = setInterval(() => {
    const ws = relay.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    if (relay.pingSentAt != null) {
      if (now - relay.pingSentAt > HEARTBEAT_TIMEOUT_MS) {
        try {
          ws.close() // triggers onclose → reconnect
        } catch {
          // ignore
        }
      }
      return
    }
    if (now - relay.lastRx >= HEARTBEAT_IDLE_MS) {
      relay.pingSentAt = now
      try {
        ws.send(encodeCommand({ type: "hello" }))
      } catch {
        try {
          ws.close()
        } catch {
          // ignore
        }
      }
    }
  }, HEARTBEAT_TICK_MS)
}

function scheduleReconnect(relay: Relay) {
  if (relay.reconnect || relay.closing) return
  relay.reconnect = setTimeout(() => {
    relay.reconnect = null
    if (!relay.closing) openSocket(relay)
  }, RECONNECT_MS)
}

function openSocket(relay: Relay) {
  setLink(relay, "checking")
  let ws: WebSocket
  try {
    ws = new WebSocket(agentUrl(relay.ip, relay.port))
  } catch (err) {
    // Malformed URL — surface it rather than silently retrying forever.
    relay.lastError = describeSocketError(err)
    setLink(relay, "offline")
    scheduleReconnect(relay)
    return
  }
  relay.ws = ws

  ws.on("open", () => {
    relay.lastRx = Date.now()
    relay.pingSentAt = null
    setLink(relay, "online")
    startHeartbeat(relay)
    // Tell the agent the carousel geometry so it can wrap shelf indexes.
    try {
      ws.send(encodeCommand({ type: "config", shelves: relay.shelves }))
    } catch {
      // ignore — heartbeat/reconnect will recover
    }
  })

  ws.on("message", (data: WebSocket.RawData) => {
    relay.lastRx = Date.now()
    relay.pingSentAt = null
    const text = data.toString()
    // Cache the latest full-state snapshot for fast sync of new subscribers.
    if (text.includes('"state"')) relay.lastState = text
    broadcast(relay, { kind: "event", data: text })
  })

  ws.on("close", () => {
    stopHeartbeat(relay)
    relay.ws = null
    relay.lastState = null
    setLink(relay, "offline")
    if (!relay.closing) scheduleReconnect(relay)
  })

  // `ws` emits "error" BEFORE "close", so recording the reason here guarantees
  // it's available when the close handler flips the link to offline.
  ws.on("error", (err) => {
    relay.lastError = describeSocketError(err)
    try {
      ws.close()
    } catch {
      // close handler schedules the reconnect
    }
  })
}

function destroy(relay: Relay) {
  relay.closing = true
  if (relay.reconnect) clearTimeout(relay.reconnect)
  stopHeartbeat(relay)
  try {
    relay.ws?.close()
  } catch {
    // ignore
  }
  registry.delete(keyFor(relay.ip, relay.port))
}

function getOrCreate(ip: string, port: number, shelves: number): Relay {
  const key = keyFor(ip, port)
  let relay = registry.get(key)
  if (!relay) {
    relay = {
      ip: ip.trim(),
      port,
      shelves,
      ws: null,
      link: "checking",
      listeners: new Set(),
      reconnect: null,
      heartbeat: null,
      lastRx: 0,
      pingSentAt: null,
      lastState: null,
      lastError: null,
      closing: false,
    }
    registry.set(key, relay)
    openSocket(relay)
  } else if (shelves > 0 && shelves !== relay.shelves) {
    // Geometry changed (layout edit) — update and re-send config if connected.
    relay.shelves = shelves
    if (relay.ws?.readyState === WebSocket.OPEN) {
      try {
        relay.ws.send(encodeCommand({ type: "config", shelves }))
      } catch {
        // ignore
      }
    }
  }
  return relay
}

/**
 * Subscribe to a Pi endpoint. Returns an unsubscribe function. The relay socket
 * is opened on first subscriber and torn down when the last one leaves.
 */
export function subscribe(ip: string, port: number, shelves: number, listener: Listener): () => void {
  const relay = getOrCreate(ip, port, shelves)
  relay.listeners.add(listener)

  // Immediately sync the newcomer with current status + last known state. A
  // browser that opens after the failure still gets the reason this way.
  listener({
    kind: "link",
    status: relay.link,
    ...(relay.link === "offline" && relay.lastError ? { reason: relay.lastError } : {}),
  })
  if (relay.lastState) listener({ kind: "event", data: relay.lastState })

  return () => {
    relay.listeners.delete(listener)
    if (relay.listeners.size === 0) {
      // No viewers — keep briefly then tear down to free the socket.
      setTimeout(() => {
        if (relay.listeners.size === 0) destroy(relay)
      }, 1000)
    }
  }
}

/** Forward a command to the Pi. Returns false if not currently connected. */
export function sendCommand(ip: string, port: number, cmd: NodeCommand): boolean {
  const relay = registry.get(keyFor(ip, port))
  if (!relay || !relay.ws || relay.ws.readyState !== WebSocket.OPEN) return false
  try {
    relay.ws.send(encodeCommand(cmd))
    return true
  } catch {
    return false
  }
}
