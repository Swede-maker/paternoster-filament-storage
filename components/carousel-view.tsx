"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from "lucide-react"
import { useStore } from "@/lib/store"
import { activeNode } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import { formatRemaining, spoolFill } from "@/lib/filament"
import { SpoolDisc, EmptySlot } from "./spool"

const ROW_HEIGHT = 156

export function CarouselView({
  onSlotClick,
  highlight,
}: {
  onSlotClick: (shelf: number, slot: number) => void
  /** Optional {shelf,slot} to pulse (e.g. the active job target). */
  highlight?: { shelf: number; slot: number } | null
}) {
  const { state, dispatch } = useStore()
  const node = activeNode(state)
  const shelves = node.slots.length
  const { currentShelf } = node.machine

  // Continuous eased position so shelves scroll through the access window.
  const posRef = useRef(currentShelf)
  const [pos, setPos] = useState(currentShelf)

  // Ref to the active (center) shelf's horizontally-scrolling slot row.
  const activeRowRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const target = currentShelf
      let p = posRef.current
      let diff = (((target - p) % shelves) + shelves) % shelves
      if (diff > shelves / 2) diff -= shelves
      if (Math.abs(diff) < 0.002) {
        posRef.current = target
        setPos(target)
        return
      }
      p += diff * 0.16
      posRef.current = p
      setPos(p)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [currentShelf, shelves])

  // When a target slot is highlighted on the active shelf, scroll the row so
  // the slot is centered — no manual left/right scrolling needed.
  useEffect(() => {
    if (!highlight || highlight.shelf !== currentShelf) return
    const container = activeRowRef.current
    if (!container) return
    const el = container.querySelector<HTMLElement>(`[data-slot="${highlight.slot}"]`)
    if (!el) return
    // Center the target slot within the scroll container. Use bounding rects so
    // this is correct regardless of which ancestor is the offsetParent.
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const delta = eRect.left - cRect.left - (container.clientWidth - eRect.width) / 2
    container.scrollTo({ left: container.scrollLeft + delta, behavior: "smooth" })
  }, [highlight, currentShelf, pos])

  const scrollRow = useCallback((dir: "left" | "right") => {
    const c = activeRowRef.current
    if (!c) return
    c.scrollBy({ left: dir === "left" ? -160 : 160, behavior: "smooth" })
  }, [])

  const canChangeShelf = node.machine.homed && node.machine.status === "idle" && !state.job

  const base = Math.round(pos)
  const offsets = [-2, -1, 0, 1, 2]

  return (
    <div
      id="pax-carousel"
      className="relative h-[380px] scroll-mt-3 overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-card to-background lg:h-auto lg:flex-1"
    >
      {/* Vertical rack rails */}
      <div className="pointer-events-none absolute inset-y-4 left-3 w-1.5 rounded-full bg-black/40" />
      <div className="pointer-events-none absolute inset-y-4 right-3 w-1.5 rounded-full bg-black/40" />

      {/* Fixed access-window band */}
      <div
        className="pointer-events-none absolute inset-x-6 top-1/2 z-20 -translate-y-1/2 rounded-2xl border-2 border-primary/70 shadow-[0_0_30px_rgba(80,150,255,0.15)]"
        style={{ height: ROW_HEIGHT - 12 }}
      />

      {/* Scrolling shelves */}
      <div className="absolute inset-0">
        {offsets.map((off) => {
          const k = base + off
          const shelfIndex = ((k % shelves) + shelves) % shelves
          const dist = Math.abs(k - pos)
          const scale = 1 - Math.min(dist, 2) * 0.08
          const opacity = 1 - Math.min(dist, 2) * 0.34
          const isCenter = dist < 0.5
          const y = (k - pos) * ROW_HEIGHT
          const row = node.slots[shelfIndex] ?? []

          return (
            <div
              key={k}
              className="absolute inset-x-0 top-1/2 flex items-center justify-center pl-14 pr-14 lg:pl-16 lg:pr-16"
              style={{
                height: ROW_HEIGHT,
                transform: `translateY(calc(-50% + ${y}px)) scale(${scale})`,
                opacity: Math.max(0, opacity),
                zIndex: isCenter ? 30 : 10,
                willChange: "transform",
              }}
            >
              {/* Shelf label */}
              <div className="mr-2 w-16 shrink-0 text-right lg:mr-4 lg:w-24">
                <span
                  className={cn(
                    "font-mono text-base font-semibold lg:text-lg",
                    isCenter ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  Shelf {shelfIndex + 1}
                </span>
              </div>

              {/* Slots */}
              <div
                ref={isCenter ? activeRowRef : undefined}
                className="flex flex-1 items-start justify-start gap-2 overflow-x-auto overflow-y-hidden scrollbar-thin lg:justify-around"
              >
                {row.map((id, slot) => {
                  const spool = id ? state.spools[id] : null
                  const size = isCenter ? 68 : 48
                  const isHi = isCenter && highlight && highlight.shelf === shelfIndex && highlight.slot === slot
                  return (
                    <button
                      key={slot}
                      type="button"
                      data-slot={isCenter ? slot : undefined}
                      disabled={!isCenter}
                      onClick={() => onSlotClick(shelfIndex, slot)}
                      className={cn(
                        "flex flex-col items-center gap-1 rounded-xl p-1 transition-colors",
                        isCenter && "hover:bg-primary/10",
                        isHi && "animate-slot-flash",
                      )}
                    >
                      <span
                        className={cn(
                          "font-mono text-xs",
                          isCenter ? "text-muted-foreground" : "text-muted-foreground/60",
                        )}
                      >
                        {slot + 1}
                      </span>
                      <span className="flex items-center justify-center" style={{ height: size }}>
                        {spool ? (
                          <SpoolDisc
                            color={spool.color}
                            size={size}
                            fill={spoolFill(spool)}
                            boxed={!!spool.containerId}
                            fit
                          />
                        ) : (
                          <EmptySlot size={size} />
                        )}
                      </span>
                      {isCenter && (
                        <span className="mt-0.5 flex h-9 flex-col items-center justify-start leading-tight">
                          {spool ? (
                            <>
                              <span
                                className="text-[11px] font-semibold"
                                style={{ color: spool.color === "#f4f4f5" ? "#e5e5e5" : spool.color }}
                              >
                                {spool.material}
                              </span>
                              <span className="text-[10px] text-muted-foreground">{formatRemaining(spool)}</span>
                            </>
                          ) : null}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Left / right: scroll slots on the active shelf */}
      <NavArrow side="left" onClick={() => scrollRow("left")} label="Scroll slots left" />
      <NavArrow side="right" onClick={() => scrollRow("right")} label="Scroll slots right" />

      {/* Up / down: change the active shelf */}
      <NavArrow
        side="up"
        disabled={!canChangeShelf}
        onClick={() => dispatch({ type: "MANUAL_MOVE", nodeId: node.id, direction: "up" })}
        label="Previous shelf"
      />
      <NavArrow
        side="down"
        disabled={!canChangeShelf}
        onClick={() => dispatch({ type: "MANUAL_MOVE", nodeId: node.id, direction: "down" })}
        label="Next shelf"
      />
    </div>
  )
}

function NavArrow({
  side,
  onClick,
  disabled,
  label,
}: {
  side: "left" | "right" | "up" | "down"
  onClick: () => void
  disabled?: boolean
  label: string
}) {
  const Icon =
    side === "left" ? ChevronLeft : side === "right" ? ChevronRight : side === "up" ? ChevronUp : ChevronDown
  const pos =
    side === "left"
      ? "left-1 top-1/2 -translate-y-1/2"
      : side === "right"
        ? "right-1 top-1/2 -translate-y-1/2"
        : side === "up"
          ? "top-1 left-1/2 -translate-x-1/2"
          : "bottom-1 left-1/2 -translate-x-1/2"
  const size = side === "up" || side === "down" ? "h-9 w-11" : "h-11 w-11"
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "absolute z-40 flex items-center justify-center rounded-full border border-border bg-card/85 text-primary backdrop-blur transition-colors hover:bg-card disabled:opacity-25",
        pos,
        size,
      )}
    >
      <Icon className="h-6 w-6" />
    </button>
  )
}
