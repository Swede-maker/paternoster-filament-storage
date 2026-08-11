/**
 * Firmware tool index for a UI slot.
 *
 * The app labels toolchanger tools starting at T1 (T1, T2, T3…), but printer
 * firmware numbers its tools from zero (T0 = first tool, T1 = second, …). Our
 * `loaded` arrays are already 0-based slot indices, so the firmware tool number
 * is simply the slot index — this helper documents and centralizes that mapping
 * so UI labels and the heater names we read never drift.
 */
export function firmwareToolIndex(slotIndex: number): number {
  return Math.max(0, Math.floor(slotIndex))
}

/**
 * Klipper extruder heater name for a tool: extruder, extruder1, extruder2…
 *
 * Used to read live nozzle temperatures back from Moonraker. (The app displays
 * temperatures only; it does not command the heaters.)
 */
export function klipperHeaterName(slotIndex: number): string {
  const n = firmwareToolIndex(slotIndex)
  return n === 0 ? "extruder" : `extruder${n}`
}
