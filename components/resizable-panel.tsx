"use client"

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { usePersistentBoolean, usePersistentNumber } from "@/lib/use-persistent"

/**
 * Wraps a card/panel and lets the user drag its bottom edge to grow or shrink
 * it. The chosen height is saved per device (keyed by `storageKey`) so a
 * layout the user tunes sticks between visits. The wrapped content fills the
 * panel and scrolls internally if it overflows the chosen height, so nothing is
 * ever clipped out of reach.
 *
 * With `autoFit`, the panel measures its content and sizes itself to show
 * everything (clamped to [minHeight, maxHeight]) UNTIL the user drags the
 * handle — after that the manual height wins and is remembered. This keeps
 * variable-length cards (e.g. a shelf list that grows with more storage units)
 * fully visible without the user having to resize them.
 *
 * The panel can never be dragged TALLER than its content: the natural content
 * height is the ceiling, so the handle never floats over empty space. The user
 * can still drag it SHORTER than the content (down to `minHeight`), in which
 * case the content scrolls inside the panel.
 *
 * `defaultHeight` is the fallback starting height; drag adjusts within
 * [minHeight, contentHeight]. Keyboard users can focus the handle and use the
 * arrow keys.
 */
export function ResizablePanel({
  storageKey,
  defaultHeight,
  minHeight = 160,
  maxHeight = 1200,
  label = "panel",
  autoFit = false,
  children,
  className,
}: {
  storageKey: string
  defaultHeight: number
  minHeight?: number
  maxHeight?: number
  label?: string
  autoFit?: boolean
  children: ReactNode
  className?: string
}) {
  const [height, setHeight] = usePersistentNumber(storageKey, defaultHeight, minHeight, maxHeight)
  // Once the user drags/keys the handle we stop auto-fitting and honor `height`.
  const [manual, setManual] = usePersistentBoolean(`${storageKey}:manual`, false)
  const drag = useRef<{ startY: number; startH: number } | null>(null)

  // Natural content height, always measured so it can serve as the drag ceiling.
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [measured, setMeasured] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    // +12px leaves room for the drag handle strip below the content.
    const measure = () => setMeasured(el.scrollHeight + 12)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Ceiling = content height (capped by maxHeight); the panel can't grow past
  // what it has to show, but can still shrink to minHeight.
  const ceiling = measured != null ? Math.min(maxHeight, Math.max(minHeight, measured)) : maxHeight
  const clamp = useCallback((n: number) => Math.min(ceiling, Math.max(minHeight, n)), [ceiling, minHeight])

  const autoActive = autoFit && !manual
  // Auto-fit → exactly the content height. Manual → the saved height, but never
  // taller than the content (so the handle never floats over emptiness).
  const effectiveHeight = autoActive ? ceiling : clamp(height)

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      setHeight(d.startH + (e.clientY - d.startY))
    },
    [setHeight],
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
      // Lock in the current (possibly auto-fit) height as the manual baseline.
      if (!manual) {
        setManual(true)
        setHeight(Math.round(effectiveHeight))
      }
      drag.current = { startY: e.clientY, startH: Math.round(effectiveHeight) }
      window.addEventListener("pointermove", onPointerMove)
      window.addEventListener("pointerup", endDrag)
      document.body.style.cursor = "ns-resize"
      document.body.style.userSelect = "none"
    },
    [manual, effectiveHeight, setManual, setHeight, onPointerMove, endDrag],
  )

  const nudge = useCallback(
    (delta: number) => {
      if (!manual) {
        setManual(true)
        setHeight(Math.round(effectiveHeight) + delta)
      } else {
        setHeight((h) => h + delta)
      }
    },
    [manual, effectiveHeight, setManual, setHeight],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault()
        nudge(-24)
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        nudge(24)
      }
    },
    [nudge],
  )

  // Double-click the handle to return to auto-fit (when enabled).
  const onDoubleClick = useCallback(() => {
    if (autoFit) setManual(false)
  }, [autoFit, setManual])

  return (
    <div className={`group/panel relative flex flex-col ${className ?? ""}`} style={{ height: effectiveHeight }}>
      {/* Content renders at its natural height (measured via this ref to cap the
          drag ceiling). If the user shrinks the panel below that, it scrolls. */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div ref={contentRef}>{children}</div>
      </div>

      {/* Bottom drag handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${label}`}
        aria-valuenow={Math.round(effectiveHeight)}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        title={autoFit ? "Drag to resize · double-click to auto-fit" : "Drag to resize"}
        className="absolute inset-x-0 bottom-0 flex h-3 cursor-ns-resize items-center justify-center rounded-b-xl outline-none"
      >
        <span className="h-1 w-10 rounded-full bg-muted-foreground/25 transition-colors group-hover/panel:bg-muted-foreground/50 group-focus-within/panel:bg-primary/70" />
      </div>
    </div>
  )
}
