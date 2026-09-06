/**
 * Shared helpers for the network-management feature (Wi-Fi, hotspot fallback,
 * slave provisioning). Safe to import from both server routes and client
 * components — no Node-only APIs here.
 */

import type { NetMode, NetPin } from "@/lib/node-protocol"

export const NET_PINS: readonly NetPin[] = ["auto", "router", "ap"] as const

export function isNetPin(v: unknown): v is NetPin {
  return typeof v === "string" && (NET_PINS as readonly string[]).includes(v)
}

/** SSID: 1–32 bytes (UTF-8). */
export function validateSsid(ssid: unknown): string | null {
  if (typeof ssid !== "string") return "SSID is required"
  const bytes = new TextEncoder().encode(ssid).length
  if (bytes < 1) return "SSID is required"
  if (bytes > 32) return "SSID must be at most 32 bytes"
  return null
}

/** WPA-PSK passphrase: 8–63 characters, or empty for an open network. */
export function validatePsk(psk: unknown): string | null {
  if (psk === undefined || psk === null || psk === "") return null
  if (typeof psk !== "string") return "Password must be text"
  if (psk.length < 8) return "Password must be at least 8 characters"
  if (psk.length > 63) return "Password must be at most 63 characters"
  return null
}

export const NET_MODE_LABEL: Record<NetMode, string> = {
  router: "On local router",
  ap: "Standalone hotspot",
  "master-ap": "On master hotspot",
  offline: "Offline",
  unknown: "Unknown",
}

export const NET_PIN_LABEL: Record<NetPin, string> = {
  auto: "Auto",
  router: "Local router",
  ap: "Standalone AP",
}

/** Build the standard Wi-Fi QR payload phones understand. */
export function wifiQrPayload(ssid: string, psk: string): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1")
  return `WIFI:T:WPA;S:${esc(ssid)};P:${esc(psk)};;`
}

/** Signal percent → 0..4 bars. */
export function signalBars(signal: number | null | undefined): 0 | 1 | 2 | 3 | 4 {
  if (signal == null) return 0
  if (signal >= 75) return 4
  if (signal >= 50) return 3
  if (signal >= 30) return 2
  if (signal > 0) return 1
  return 0
}
