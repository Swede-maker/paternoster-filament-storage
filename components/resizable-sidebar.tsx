"use client"

import type { ReactNode } from "react"
import { useCallback, useRef } from "react"
import { ShelfOverview } from "./shelf-overview"
import { ManualControl } from "./manual-control"
import { usePersistentNumber, useIsDesktop } from "@/lib/use-persistent"

/** Manual Control never shrinks below this, so its buttons stay reachable. */
const MIN_CONTROL_PX = 220
/** Shelf Overview never shrinks below one visible row + heading. */
const MIN_SHELF_PX = 96

/**
 * Sidebar body with a draggable divider between the Shelf Overview and the
 * Manual Control block. Drag the handle to give the shelf list more (or less)
 * room; the height is saved per device. Only active on the desktop two-column
 * layout, where the sidebar has a bounded height to redistribute — on mobile
 * the two sections simply stack at their natural heights.
 *
 * `overview` / `control` default to the filament Shelf Overview + Manual
 * Control, but the hardware area passes its own (part-colored overview, same
 * controls bound to the hardware unit) so both areas share this drag behavior.
 * `storageKey` keeps each area's divider height independent.
 */
export function ResizableSidebar({
  overview,
  control,
  storageKey = "pax:sidebar:shelfHeightV1",
}: {
  overview?: ReactNode
  control?: ReactNode
  storageKey?: string
} = {}) {
  const isDesktop = useIsDesktop()
  const [shelfHeight, setShelfHeight] = usePersistentNumber(storageKey, 220, MIN_SHELF_PX, 2000)
  const overviewNode = overview ?? <ShelfOverview />
  const controlNode = control ?? <ManualControl />
  const containerRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startY: number; startH: number } | null>(null)

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      // Cap so Manual Control keeps at least MIN_CONTROL_PX of the sidebar.
      const containerH = containerRef.current?.clientHeight ?? 0
      const maxShelf = Math.max(MIN_SHELF_PX, containerH - MIN_CONTROL_PX)
      const next = Math.min(maxShelf, Math.max(MIN_SHELF_PX, d.startH + (e.clientY - d.startY)))
      setShelfHeight(next)
    },
    [setShelfHeight],
  )

  const endDrag = useCallback(() => {
    drag.current = null
    window.removeEventListener("pointermove", onPointerMove)
    window.removeEventListener("pointerup", endDrag)
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
  }, [onPointerMove])

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      drag.current = { startY: e.clientY, startH: shelfHeight }
      window.addEventListener("pointermove", onPointerMove)
      window.addEventListener("pointerup", endDrag)
      document.body.style.cursor = "row-resize"
      document.body.style.userSelect = "none"
    },
    [shelfHeight, onPointerMove, endDrag],
  )

  // Keyboard resize for accessibility: arrows nudge the divider.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setShelfHeight((h) => h - 24)
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        setShelfHeight((h) => h + 24)
      }
    },
    [setShelfHeight],
  )

  // Mobile / narrow: no bounded height to divide, so stack naturally.
  if (!isDesktop) {
    return (
      <>
        {overviewNode}
        {controlNode}
      </>
    )
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col">
      {/* Shelf overview gets a user-controlled fixed height; its inner list
          scrolls within it. */}
      <div style={{ height: shelfHeight }} className="flex min-h-0 shrink-0 flex-col">
        {overviewNode}
      </div>

      {/* Drag handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize shelf overview"
        aria-valuenow={Math.round(shelfHeight)}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        className="group flex h-3 shrink-0 cursor-row-resize items-center justify-center border-y border-border/60 bg-background/40 outline-none hover:bg-secondary/60 focus-visible:bg-secondary/60"
      >
        <span className="h-0.5 w-8 rounded-full bg-muted-foreground/40 transition-colors group-hover:bg-primary/70 group-focus-visible:bg-primary/70" />
      </div>

      {/* Manual control takes the remainder and scrolls if needed. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-thin">
        {controlNode}
      </div>
    </div>
  )
}
