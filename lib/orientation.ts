import type { AppState, StorageNode } from "./types"

export type CarouselOrientation = "horizontal" | "vertical"

/**
 * Which carousel layout a storage unit draws. "horizontal" is the classic
 * paternoster (shelves pass up/down through the access window); "vertical" is
 * a rotating carousel whose sections pass left/right (clockwise /
 * counter-clockwise). Each unit chooses its own type; a unit saved before the
 * per-unit choice existed inherits the old app-wide setting, else horizontal.
 * Any carousel (filament or hardware) can be vertical; shelves and libraries cannot.
 */
export function carouselOrientation(state: AppState, node: StorageNode): CarouselOrientation {
  const type = node.type ?? "paternoster"
  if (type !== "paternoster") return "horizontal"
  const chosen = node.orientation ?? state.settings.carouselOrientation
  return chosen === "vertical" ? "vertical" : "horizontal"
}

export function isVerticalCarousel(state: AppState, node: StorageNode): boolean {
  return carouselOrientation(state, node) === "vertical"
}

/** "Section N" for a vertical carousel — a custom shelf name still wins. */
export function sectionLabel(node: StorageNode, index: number): string {
  return node.shelfMeta?.[index]?.name?.trim() || `Section ${index + 1}`
}
