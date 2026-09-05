"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Hold this long on a tab before it lifts and starts following the pointer. */
const HOLD_MS = 220
/** Pointer travel (px) that cancels the hold and counts as a plain scroll/tap. */
const HOLD_SLOP_PX = 6

export interface ReorderableTab {
  id: string
  active: boolean
  onSelect: () => void
  children: ReactNode
}

interface Props {
  tabs: ReorderableTab[]
  /** Called with the dragged id and the id it should now sit BEFORE (null = end). */
  onReorder: (id: string, beforeId: string | null) => void
  "aria-label": string
}

interface Drag {
  id: string
  /** Offset from the pointer to the tab's left/top edge, so it lifts in place. */
  dx: number
  dy: number
  x: number
  y: number
  w: number
  h: number
  /** Id the tab would land BEFORE if released now (null = end). */
  beforeId: string | null
}

/**
 * A tab strip whose tabs can be pressed-and-held, then dragged into a new
 * order. Uses Pointer Events so mouse and touch behave the same:
 *
 *   press → hold HOLD_MS without moving → tab lifts and follows the pointer
 *   → a gap opens where it would land → release drops it there.
 *
 * A short press (release before the hold, or moving early) is a normal tab
 * click — nothing about the existing behaviour changes for users who never
 * hold. Keyboard users get the same result with Alt+Arrow on a focused tab.
 */
export function ReorderableTabs({ tabs, onReorder, "aria-label": ariaLabel }: Props) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const hold = useRef<{ id: string; timer: number; x0: number; y0: number; pointerId: number } | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag

  const clearHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer)
    hold.current = null
  }

  /**
   * Resting positions of every tab, captured the moment a drag starts. The
   * landing test MUST use these, not live rects: once the drop gap is inserted
   * the neighbouring tabs shift to make room, and testing against the shifted
   * rect would keep moving the target away from the pointer (a feedback loop
   * that made it impossible to drop after the last tab).
   */
  const restingRects = useRef<Map<string, DOMRect>>(new Map())

  /** Where (before which tab) a point along the strip should land. */
  const landingFor = (clientX: number, clientY: number, movingId: string): string | null => {
    for (const t of tabs) {
      if (t.id === movingId) continue
      const r = restingRects.current.get(t.id)
      if (!r) continue
      // Same row (strip wraps) and left of its midpoint → land before it.
      const sameRow = clientY >= r.top - 4 && clientY <= r.bottom + 4
      if (sameRow && clientX < r.left + r.width / 2) return t.id
      // Above this row entirely → also before it.
      if (clientY < r.top - 4) return t.id
    }
    return null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0 && e.pointerType === "mouse") return
    clearHold()
    const target = e.currentTarget
    const x0 = e.clientX
    const y0 = e.clientY
    const pointerId = e.pointerId
    const timer = window.setTimeout(() => {
      const r = target.getBoundingClientRect()
      // Snapshot every tab's resting position before anything reflows.
      restingRects.current = new Map()
      for (const [tabId, el] of tabRefs.current) restingRects.current.set(tabId, el.getBoundingClientRect())
      try {
        target.setPointerCapture(pointerId)
      } catch {
        /* pointer may be gone */
      }
      hold.current = null
      const next: Drag = {
        id,
        dx: x0 - r.left,
        dy: y0 - r.top,
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        beforeId: landingFor(x0, y0, id),
      }
      setDrag(next)
    }, HOLD_MS)
    hold.current = { id, timer, x0, y0, pointerId }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const h = hold.current
    if (h && !dragRef.current) {
      // Moving before the hold completes = the user is scrolling or tapping.
      if (Math.abs(e.clientX - h.x0) > HOLD_SLOP_PX || Math.abs(e.clientY - h.y0) > HOLD_SLOP_PX) clearHold()
      return
    }
    const d = dragRef.current
    if (!d) return
    e.preventDefault()
    setDrag({
      ...d,
      x: e.clientX - d.dx,
      y: e.clientY - d.dy,
      beforeId: landingFor(e.clientX, e.clientY, d.id),
    })
  }

  const finish = (commit: boolean) => {
    clearHold()
    const d = dragRef.current
    if (!d) return
    setDrag(null)
    if (commit) onReorder(d.id, d.beforeId)
  }

  const justDragged = useRef(false)

  // A drag that just ended fires a click on release. The lifted tab has
  // pointer-events:none, so that click lands on whichever tab is UNDER the
  // pointer — swallow it here, on the container in the capture phase, so a drop
  // can never double as a tab switch no matter where it lands.
  const onClickCapture = (e: React.MouseEvent) => {
    if (!justDragged.current) return
    e.preventDefault()
    e.stopPropagation()
    justDragged.current = false
  }

  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (!e.altKey) return
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
    e.preventDefault()
    const dir = e.key === "ArrowLeft" ? -1 : 1
    const to = index + dir
    if (to < 0 || to >= tabs.length) return
    // Moving right lands AFTER the neighbour, i.e. before the one after it.
    const beforeId = dir === -1 ? tabs[to].id : (tabs[to + 1]?.id ?? null)
    onReorder(tabs[index].id, beforeId)
  }

  // Escape cancels an in-progress drag without committing.
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id])

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="tablist"
      aria-label={ariaLabel}
      onClickCapture={onClickCapture}
      // Prevent the browser's own touch scroll from fighting the drag.
      style={drag ? { touchAction: "none" } : undefined}
    >
      {tabs.map((tab, i) => {
        const lifted = drag?.id === tab.id
        const gapBefore = !!drag && !lifted && drag.beforeId === tab.id
        return (
          <div key={tab.id} className="flex items-center gap-2">
            {gapBefore && <DropGap w={drag.w} h={drag.h} />}
            <button
              ref={(el) => {
                if (el) tabRefs.current.set(tab.id, el)
                else tabRefs.current.delete(tab.id)
              }}
              type="button"
              role="tab"
              aria-selected={tab.active}
              aria-grabbed={lifted || undefined}
              title="Hold and drag to reorder"
              onPointerDown={(e) => onPointerDown(e, tab.id)}
              onPointerMove={onPointerMove}
              onPointerUp={() => {
                if (dragRef.current) {
                  justDragged.current = true
                  // The synthetic click fires right after pointerup in the same
                  // task; if none arrives, reset so the next real click works.
                  window.setTimeout(() => {
                    justDragged.current = false
                  }, 0)
                }
                finish(true)
              }}
              onPointerCancel={() => finish(false)}
              onClick={tab.onSelect}
              onKeyDown={(e) => onKeyDown(e, i)}
              onContextMenu={(e) => {
                // Long-press on touch would otherwise open the context menu.
                if (hold.current || dragRef.current) e.preventDefault()
              }}
              style={
                lifted
                  ? {
                      position: "fixed",
                      left: drag.x,
                      top: drag.y,
                      width: drag.w,
                      zIndex: 60,
                      pointerEvents: "none",
                    }
                  : undefined
              }
              className={cn(
                "flex select-none items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                tab.active
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background/50 text-muted-foreground hover:border-primary/50",
                lifted && "cursor-grabbing bg-card shadow-2xl ring-2 ring-primary/60 transition-none",
              )}
            >
              {tab.children}
            </button>
            {/* Placeholder keeps the row from collapsing while the real tab is lifted. */}
            {lifted && <div aria-hidden style={{ width: drag.w, height: drag.h }} className="shrink-0" />}
          </div>
        )
      })}
      {/* Gap at the very end when the drop lands after the last tab. */}
      {drag && drag.beforeId === null && <DropGap w={drag.w} h={drag.h} />}
    </div>
  )
}

function DropGap({ w, h }: { w: number; h: number }) {
  return (
    <div
      aria-hidden
      style={{ width: w, height: h }}
      className="shrink-0 rounded-lg border-2 border-dashed border-primary/60 bg-primary/5"
    />
  )
}
