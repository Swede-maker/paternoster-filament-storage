import type { AppState, Settings, StorageNode } from "./types"

export const DEFAULT_CAMERA_PORT = 8780

export type CameraSetting = NonNullable<Settings["camera"]>

export function cameraSetting(state: Pick<AppState, "settings">): CameraSetting {
  const c = state.settings.camera
  return {
    enabled: c?.enabled ?? false,
    popupOnMove: c?.popupOnMove ?? true,
    port: c?.port && c.port > 0 ? c.port : DEFAULT_CAMERA_PORT,
    host: c?.host?.trim() || undefined,
  }
}

/** The Pi to stream from: the override host, else the carousel's own Pi. */
export function cameraHost(setting: CameraSetting, node: StorageNode | undefined): string | null {
  if (setting.host) return setting.host
  if (node && node.driver === "hardware" && node.ip.trim()) return node.ip.trim()
  return null
}

export function cameraStreamUrl(host: string, port: number, attempt: number): string {
  const q = new URLSearchParams({ ip: host, port: String(port), n: String(attempt) })
  return `/api/camera/stream?${q.toString()}`
}

export function isNodeMoving(node: StorageNode): boolean {
  const s = node.machine.status
  return s === "moving" || s === "homing"
}
