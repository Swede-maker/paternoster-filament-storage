import "server-only"
import { READER_PRESENCE_TTL_MS, type ReaderFrame } from "@/lib/reader-protocol"

/**
 * In-memory pub/sub bridge between wireless RFID readers and browsers.
 *
 * A reader POSTs a scan (see `/api/reader/scan`); every browser subscribed to
 * that reader's token (via the SSE stream in `/api/reader/stream`) receives it
 * immediately. The channel key is the pairing token itself, so the bridge holds
 * no credentials and needs no database — matching tokens is the whole contract.
 *
 * This mirrors the paternoster pi-relay: a process-wide singleton, persisted
 * across HMR/module reloads so we don't leak channels in dev. Server-only.
 *
 * (Same single-instance caveat as pi-relay: fan-out is per server process, which
 * is exactly right for the self-hosted-on-the-LAN deployment this app targets.)
 */

type Listener = (frame: ReaderFrame) => void

interface Channel {
  token: string
  listeners: Set<Listener>
  /** Last time the reader POSTed anything (scan or ping); 0 = never. */
  lastSeen: number
  /** Whether we've broadcast "online" for the current presence window. */
  presenceOnline: boolean
  /** Fires when presence should expire back to offline. */
  presenceTimer: ReturnType<typeof setTimeout> | null
}

const globalKey = "__pax_reader_channels__"
const registry: Map<string, Channel> =
  (globalThis as Record<string, unknown>)[globalKey] instanceof Map
    ? ((globalThis as Record<string, unknown>)[globalKey] as Map<string, Channel>)
    : new Map<string, Channel>()
;(globalThis as Record<string, unknown>)[globalKey] = registry

function getOrCreate(token: string): Channel {
  let ch = registry.get(token)
  if (!ch) {
    ch = { token, listeners: new Set(), lastSeen: 0, presenceOnline: false, presenceTimer: null }
    registry.set(token, ch)
  }
  return ch
}

function broadcast(ch: Channel, frame: ReaderFrame) {
  for (const l of ch.listeners) {
    try {
      l(frame)
    } catch {
      // A broken listener must not take down the channel.
    }
  }
}

/** Drop a channel once nobody is listening and the reader has gone quiet. */
function maybeReap(ch: Channel) {
  if (ch.listeners.size === 0 && Date.now() - ch.lastSeen > READER_PRESENCE_TTL_MS) {
    if (ch.presenceTimer) clearTimeout(ch.presenceTimer)
    registry.delete(ch.token)
  }
}

function markSeen(ch: Channel) {
  ch.lastSeen = Date.now()
  if (!ch.presenceOnline) {
    ch.presenceOnline = true
    broadcast(ch, { kind: "presence", online: true, at: ch.lastSeen })
  }
  if (ch.presenceTimer) clearTimeout(ch.presenceTimer)
  ch.presenceTimer = setTimeout(() => {
    ch.presenceOnline = false
    broadcast(ch, { kind: "presence", online: false, at: Date.now() })
    maybeReap(ch)
  }, READER_PRESENCE_TTL_MS)
}

/**
 * Publish a reader event to its channel. Returns how many browsers received it
 * (0 means the reader works but nobody is currently waiting — useful feedback
 * for the firmware's status LED).
 */
export function publishScan(token: string, uid: string): number {
  const ch = getOrCreate(token)
  markSeen(ch)
  broadcast(ch, { kind: "tag", uid, at: Date.now() })
  return ch.listeners.size
}

/** Record a keepalive ping (presence only, no tag). Returns listener count. */
export function publishPing(token: string): number {
  const ch = getOrCreate(token)
  markSeen(ch)
  return ch.listeners.size
}

/**
 * Subscribe a browser to a reader token. Returns an unsubscribe function.
 * Immediately replays current presence so the UI reflects reader status at once.
 */
export function subscribe(token: string, listener: Listener): () => void {
  const ch = getOrCreate(token)
  ch.listeners.add(listener)
  const online = ch.presenceOnline && Date.now() - ch.lastSeen <= READER_PRESENCE_TTL_MS
  listener({ kind: "presence", online, at: ch.lastSeen })

  return () => {
    ch.listeners.delete(listener)
    maybeReap(ch)
  }
}
