/**
 * Wire protocol for wireless RFID/NFC readers (ESP32, Raspberry Pi, etc.).
 *
 * Why this exists: iPhones (and desktops) cannot read NFC from a web page, and a
 * browser can't reliably open a socket to a bare LAN device (HTTPS mixed-content
 * + no TLS on the device). So instead of the browser reaching the reader, the
 * READER reaches the app: it makes a plain HTTP POST to `/api/reader/scan` with
 * the tag id it just read, and the browser receives it over Server-Sent Events
 * from `/api/reader/stream`. An HTTP POST is trivial and rock-solid on an ESP32.
 *
 * Pairing / auth model: each reader is paired with a high-entropy TOKEN that the
 * app generates and the reader is flashed with. That token is BOTH the shared
 * secret and the pub/sub channel id — the reader publishes to it and the browser
 * subscribes to it. Matching tokens is all that's required, so the server stays
 * stateless (no token database) and the design is a clean capability: only a
 * device that knows the token can inject or read a channel. Keep tokens secret
 * and long.
 *
 * This file is the single source of truth for the shapes; the firmware in
 * `pi-agent/rfid-reader/` posts exactly these fields.
 */

/** Number of random chars in a pairing token. ~142 bits at base62. */
export const READER_TOKEN_LENGTH = 24

/** Reader is considered "online" this long after its last POST (scan or ping). */
export const READER_PRESENCE_TTL_MS = 45000

const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

/**
 * Generate a fresh pairing token. Browser-only (uses Web Crypto); tokens are
 * minted in the Settings UI, never on the server.
 */
export function newReaderToken(): string {
  const bytes = new Uint8Array(READER_TOKEN_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ""
  for (let i = 0; i < bytes.length; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length]
  return out
}

/** A token is structurally valid if it's the right length and alphabet. */
export function isValidReaderToken(token: unknown): token is string {
  return typeof token === "string" && token.length >= 16 && token.length <= 64 && /^[A-Za-z0-9]+$/.test(token)
}

/** What a reader POSTs. `event` defaults to "tag" when a uid is present. */
export interface ReaderPost {
  token: string
  /** The tag's uid (NFC hardware serial, or a decoded QR payload). */
  uid?: string
  /** "tag" = a scan happened; "ping" = keepalive/presence only. */
  event?: "tag" | "ping"
  /** Optional human label for the reader, shown in the app the first time. */
  name?: string
}

/** A frame pushed to a subscribed browser over SSE. */
export type ReaderFrame =
  | { kind: "tag"; uid: string; at: number }
  | { kind: "presence"; online: boolean; at: number }

/** Validate an untrusted POST body into a ReaderPost (or null). */
export function parseReaderPost(body: unknown): ReaderPost | null {
  if (!body || typeof body !== "object") return null
  const b = body as Record<string, unknown>
  if (!isValidReaderToken(b.token)) return null
  const event = b.event === "ping" ? "ping" : "tag"
  const uid = typeof b.uid === "string" ? b.uid.trim() : ""
  // A "tag" event must carry a non-empty, sanely-sized uid.
  if (event === "tag" && (!uid || uid.length > 256)) return null
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : undefined
  return { token: b.token, event, uid: uid || undefined, name }
}
