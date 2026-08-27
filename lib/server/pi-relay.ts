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
/** How long to hold the agent socket open after the last browser disconnects. */
const IDLE_TEARDOWN_MS = 15000
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
  /** Reason sent in the last `link` frame, so a changed reason still broadcasts. */
  lastBroadcastReason: string | undefined
  /**
   * Last motion tuning (speed / soft start) the app asked for.
   *
   * The relay remembers it because the agent forgets: a Pi that reboots or a
   * socket that drops comes back on its built-in defaults, and the reconnect
   * `config` used to carry only `shelves` — so the carousel silently reverted to
   * default speed until the operator happened to touch a slider again. Replaying
   * this on every open keeps the hardware matching the UI.
   */
  motion: { moveSpeed?: number; homingSpeed?: number; rampPct?: number; approachSpeed?: number }
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

/**
 * Shown when the socket dies without an errno we can translate — e.g. the
 * handshake reached something that answered but wasn't a WebSocket server. Never
 * leave `offline` reasonless: a blank explanation reads as "the app is broken"
 * when the real cause is almost always that the agent isn't running.
 */
const GENERIC_OFFLINE_REASON =
  "Could not open a WebSocket to the agent. On the Pi, check `systemctl status paternoster-agent` and `ss -ltnp | grep 8765`."

function setLink(relay: Relay, link: RelayLink) {
  const reason = link === "offline" ? relay.lastError ?? GENERIC_OFFLINE_REASON : undefined
  // Re-broadcast when the *reason* changes too, even if the status hasn't: the
  // first failure often lands before the errno is captured, and without this the
  // better message that follows would be swallowed.
  if (relay.link === link && relay.lastBroadcastReason === reason) return
  relay.link = link
  relay.lastBroadcastReason = reason
  // Only an offline status carries a reason; clear it once we're connected.
  if (link === "online") relay.lastError = null
  broadcast(relay, {
    kind: "link",
    status: link,
    ...(reason ? { reason } : {}),
  })
}

function stopHeartbeat(relay: Relay) {
  if (relay.heartbeat) {
    clearInterval(relay.heartbeat)
    relay.heartbeat = null
  }
}

/**
 * Keep `lastState` describing where the carousel IS, not where it happened to be
 * the last time the agent volunteered a full snapshot.
 *
 * This cache is what a newly subscribing browser is replayed. The relay's socket
 * to the Pi OUTLIVES a browser refresh, so a reloaded tab does NOT get a fresh
 * snapshot from the agent — the replay is all it has. The agent only emits
 * `state` on connect and at the START of a move, and reports arrivals as
 * `arrived`/`pos`/`homed`, so caching `state` frames alone left the replay
 * frozen at connect time (shelf 0, un-homed). A refresh then snapped the display
 * back to shelf 1 while the carousel stood somewhere else, and the next move was
 * computed from that phantom position — which is why picking the shelf the
 * machine was already on did nothing at all.
 *
 * Folding the position frames into the cache keeps the replay truthful. `homed`
 * is only ever set by frames that genuinely establish a reference, never
 * inferred from a bare `pos`, so an un-homed agent still cannot overwrite the
 * browser's persisted position with a guess.
 */
function rememberState(relay: Relay, text: string): void {
  let ev: { type?: string; status?: string; shelf?: number; homed?: boolean }
  try {
    ev = JSON.parse(text)
  } catch {
    return // not JSON (or a partial frame) — nothing to learn from it
  }
  if (!ev || typeof ev !== "object") return

  let prev: { status?: string; shelf?: number; homed?: boolean } | null = null
  if (relay.lastState) {
    try {
      prev = JSON.parse(relay.lastState)
    } catch {
      prev = null
    }
  }

  const snap = {
    type: "state",
    status: prev?.status ?? "idle",
    shelf: typeof prev?.shelf === "number" ? prev.shelf : 0,
    homed: prev?.homed === true,
  }

  switch (ev.type) {
    case "state":
      // The agent's own summary is authoritative for every field.
      if (typeof ev.status === "string") snap.status = ev.status
      if (typeof ev.shelf === "number") snap.shelf = ev.shelf
      snap.homed = ev.homed === true
      break
    case "pos":
      // A counted sensor crossing mid-move: position only.
      if (typeof ev.shelf !== "number") return
      snap.shelf = ev.shelf
      break
    case "arrived":
      if (typeof ev.shelf === "number") snap.shelf = ev.shelf
      snap.status = "idle"
      break
    case "homed":
      if (typeof ev.shelf === "number") snap.shelf = ev.shelf
      snap.homed = true
      snap.status = "idle"
      break
    default:
      return // hello/fault/etc. carry no position
  }

  relay.lastState = JSON.stringify(snap)
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
    // Tell the agent the carousel geometry so it can wrap shelf indexes, and
    // re-apply the motion tuning. Sending geometry alone here is what made a
    // reconnected (or rebooted) Pi run at default speed regardless of the
    // sliders.
    try {
      ws.send(encodeCommand({ type: "config", shelves: relay.shelves, ...relay.motion }))
    } catch {
      // ignore — heartbeat/reconnect will recover
    }
  })

  ws.on("message", (data: WebSocket.RawData) => {
    relay.lastRx = Date.now()
    relay.pingSentAt = null
    const text = data.toString()
    rememberState(relay, text)
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
      lastBroadcastReason: undefined,
      motion: {},
      closing: false,
    }
    registry.set(key, relay)
    openSocket(relay)
  } else if (shelves > 0 && shelves !== relay.shelves) {
    // Geometry changed (layout edit) — update and re-send config if connected.
    relay.shelves = shelves
    if (relay.ws?.readyState === WebSocket.OPEN) {
      try {
        relay.ws.send(encodeCommand({ type: "config", shelves, ...relay.motion }))
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
      // No viewers — linger before tearing down. A page reload or navigation
      // drops the SSE stream for a moment, and a 1s grace period was short
      // enough that ordinary browsing churned the hardware socket: the agent saw
      // a disconnect and reconnect every time. Holding the socket open across
      // that gap keeps the link stable and preserves the cached state.
      setTimeout(() => {
        if (relay.listeners.size === 0) destroy(relay)
      }, IDLE_TEARDOWN_MS)
    }
  }
}

/** Forward a command to the Pi. Returns false if not currently connected. */
export function sendCommand(ip: string, port: number, cmd: NodeCommand): boolean {
  const relay = registry.get(keyFor(ip, port))
  if (!relay) return false

  // Remember motion tuning even if the socket is down right now, so it is
  // applied as soon as the Pi comes back rather than being lost.
  if (cmd.type === "config") {
    // `registry` is module-level and long-lived, so a relay can predate the code
    // reading it — after a hot reload in dev, or an old object still in the map
    // across a redeploy. Such a relay has no `motion` field at all, and writing
    // straight through it threw "Cannot set properties of undefined", turning
    // every slider POST into a 500. Heal the shape instead of assuming it.
    if (!relay.motion) relay.motion = {}
    if (cmd.moveSpeed !== undefined) relay.motion.moveSpeed = cmd.moveSpeed
    if (cmd.homingSpeed !== undefined) relay.motion.homingSpeed = cmd.homingSpeed
    if (cmd.rampPct !== undefined) relay.motion.rampPct = cmd.rampPct
    if (cmd.approachSpeed !== undefined) relay.motion.approachSpeed = cmd.approachSpeed
    if (cmd.shelves > 0) relay.shelves = cmd.shelves
  }

  if (!relay.ws || relay.ws.readyState !== WebSocket.OPEN) return false
  try {
    relay.ws.send(encodeCommand(cmd))
    return true
  } catch {
    return false
  }
}
