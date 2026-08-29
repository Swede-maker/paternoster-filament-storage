"use client"

import { useCallback, useRef, type ReactNode } from "react"
import { usePersistentNumber } from "@/lib/use-persistent"

/**
 * Wraps a card/panel and lets the user drag its bottom edge to grow or shrink
 * it. The chosen height is saved per device (keyed by `storageKey`) so a
 * layout the user tunes sticks between visits. The wrapped content fills the
 * panel and scrolls internally if it overflows the chosen height, so nothing is
 * ever clipped out of reach.
 *
 * `defaultHeight` is the natural starting height; drag adjusts within
 * [minHeight, maxHeight]. Keyboard users can focus the handle and use the
 * arrow keys.
 */
export function ResizablePanel({
  storageKey,
  defaultHeight,
  minHeight = 160,
  maxHeight = 1200,
  label = "panel",
  children,
  className,
}: {
  storageKey: string
  defaultHeight: number
  minHeight?: number
  maxHeight?: number
  label?: string
  children: ReactNode
  className?: string
}) {
  const [height, setHeight] = usePersistentNumber(storageKey, defaultHeight, minHeight, maxHeight)
  const drag = useRef<{ startY: number; startH: number } | null>(null)

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
      drag.current = { startY: e.clientY, startH: height }
      window.addEventListener("pointermove", onPointerMove)
      window.addEventListener("pointerup", endDrag)
      document.body.style.cursor = "ns-resize"
      document.body.style.userSelect = "none"
    },
    [height, onPointerMove, endDrag],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setHeight((h) => h - 24)
      } else if (e.key === "ArrowDown") {
        e.preventDefault()
        setHeight((h) => h + 24)
      }
    },
    [setHeight],
  )

  return (
    <div className={`group/panel relative flex flex-col ${className ?? ""}`} style={{ height }}>
      {/* The card fills the panel; its own content scrolls if taller. */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin [&>*]:h-full">{children}</div>

      {/* Bottom drag handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${label}`}
        aria-valuenow={Math.round(height)}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        className="absolute inset-x-0 bottom-0 flex h-3 cursor-ns-resize items-center justify-center rounded-b-xl outline-none"
      >
        <span className="h-1 w-10 rounded-full bg-muted-foreground/25 transition-colors group-hover/panel:bg-muted-foreground/50 group-focus-within/panel:bg-primary/70" />
      </div>
    </div>
  )
}
