"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { PartBox, HardwareEmptySlot } from "./part-box"
import { isPartLow } from "@/lib/selectors"
import type { StorageNode } from "@/lib/types"

const ROW_HEIGHT = 156

/**
 * Paternoster view for a HARDWARE unit. Structurally mirrors the filament
 * {@link CarouselView} — the same rotating rack, access-window band, and
 * per-shelf slot rows — but each occupied slot renders a {@link PartBox} (color
 * + count) instead of a spool disc, and it reads from `state.parts`. It takes an
 * explicit `node` rather than the shared active node, since the hardware area
 * tracks its own current unit independently of the filament area.
 */
export function HardwareCarousel({
  node,
  onSlotClick,
  highlight,
}: {
  node: StorageNode
  onSlotClick: (shelf: number, slot: number) => void
  highlight?: { shelf: number; slot: number } | null
}) {
  const { state, dispatch } = useStore()
  const shelves = node.slots.length
  const { currentShelf } = node.machine

  const posRef = useRef(currentShelf)
  const [pos, setPos] = useState(currentShelf)
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

  useEffect(() => {
    if (!highlight || highlight.shelf !== currentShelf) return
    const container = activeRowRef.current
    if (!container) return
    const el = container.querySelector<HTMLElement>(`[data-slot="${highlight.slot}"]`)
    if (!el) return
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

  // Shelf-sensor lamp state — same rule as the filament carousel: prefer the
  // real hardware sensor reading, else infer that metal is in the window when
  // the carousel is homed and settled on a shelf (not mid-move / homing).
  const settled = Math.abs(pos - currentShelf) < 0.06
  const inferredSensing =
    node.machine.homed && settled && node.machine.status !== "moving" && node.machine.status !== "homing"
  const sensing =
    node.driver === "hardware" && node.machine.sensor != null ? node.machine.sensor : inferredSensing

  const base = Math.round(pos)
  const offsets = [-2, -1, 0, 1, 2]

  return (
    <div
      id="pax-carousel"
      className="relative h-[380px] scroll-mt-3 overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-card to-background lg:h-auto lg:flex-1"
    >
      <div className="pointer-events-none absolute inset-y-4 left-3 w-1.5 rounded-full bg-black/40" />
      <div className="pointer-events-none absolute inset-y-4 right-3 w-1.5 rounded-full bg-black/40" />

      <div
        className="pointer-events-none absolute inset-x-6 top-1/2 z-20 -translate-y-1/2 rounded-2xl border-2 border-primary/70 shadow-[0_0_30px_rgba(80,150,255,0.15)]"
        style={{ height: ROW_HEIGHT - 12 }}
      />

      {/* Shelf-sensor indicator tucked inside the top-left of the access window,
          matching the filament paternoster. Amber glow when a shelf is detected. */}
      <div
        className="pointer-events-none absolute left-9 z-30"
        style={{ top: `calc(50% - ${(ROW_HEIGHT - 12) / 2}px + 10px)` }}
      >
        <SensorLight on={sensing} />
      </div>

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

              <div
                ref={isCenter ? activeRowRef : undefined}
                className="flex flex-1 items-start justify-start gap-2 overflow-x-auto overflow-y-hidden scrollbar-thin lg:justify-around"
              >
                {row.map((id, slot) => {
                  const part = id ? state.parts?.[id] : null
                  const size = isCenter ? 68 : 48
                  const isHi = isCenter && highlight && highlight.shelf === shelfIndex && highlight.slot === slot
                  const low = part ? isPartLow(part) : false
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
                        {part ? (
                          <PartBox color={part.color} size={size} imageUrl={part.imageUrl} name={part.name} />
                        ) : (
                          <HardwareEmptySlot size={size} />
                        )}
                      </span>
                      {isCenter && (
                        <span className="mt-0.5 flex h-12 flex-col items-center justify-start leading-tight">
                          {part ? (
                            <>
                              <span className="max-w-[92px] truncate text-[11px] font-semibold text-foreground">
                                {part.name}
                              </span>
                              <span
                                className={cn(
                                  "text-[10px]",
                                  low ? "font-semibold text-warning" : "text-muted-foreground",
                                )}
                              >
                                {part.count} pcs
                              </span>
                              {part.category ? (
                                <span className="max-w-[92px] truncate text-[10px] text-muted-foreground">
                                  {part.category}
                                </span>
                              ) : null}
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

      <NavArrow side="left" onClick={() => scrollRow("left")} label="Scroll slots left" />
      <NavArrow side="right" onClick={() => scrollRow("right")} label="Scroll slots right" />
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

/**
 * Small status lamp for the single-shelf inductive sensor. Solid amber with a
 * soft glow when detecting metal (`on`); a thin hollow ring otherwise. Matches
 * the filament carousel's indicator.
 */
function SensorLight({ on }: { on: boolean }) {
  return (
    <span
      role="img"
      aria-label={on ? "Shelf sensor: shelf detected" : "Shelf sensor: no shelf detected"}
      title={on ? "Sensor: shelf detected" : "Sensor: no shelf detected"}
      className={cn(
        "block h-7 w-7 rounded-full border-2 transition-all duration-200",
        on ? "border-warning bg-warning shadow-[0_0_14px_3px_var(--warning)]" : "border-muted-foreground/50 bg-card/40",
      )}
    />
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
