"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Lock } from "lucide-react"
import { useStore } from "@/lib/store"
import { activeNode, isPartLow } from "@/lib/selectors"
import { PartBox, HardwareEmptySlot } from "@/features/hardware/part-box"
import type { StorageNode } from "@/lib/types"
import { sectionLabel } from "@/lib/orientation"
import { cn } from "@/lib/utils"
import { formatRemaining, spoolFill } from "@/lib/filament"
import { SpoolDisc, EmptySlot, discColor2 } from "@/components/spool"

const COL_WIDTH = 190

/**
 * Vertical carousel: the same storage model as the paternoster, turned on its
 * side. Sections are columns that pass left/right through a fixed vertical
 * access window; the slots of a section stack top-to-bottom. "up" in the
 * store's MANUAL_MOVE is clockwise, "down" is counter-clockwise.
 */
export function VerticalCarouselView({
  node: nodeProp,
  onSlotClick,
  highlight,
}: {
  /** Unit to draw; defaults to the shared active node. The hardware area passes its own. */
  node?: StorageNode
  onSlotClick: (shelf: number, slot: number) => void
  highlight?: { shelf: number; slot: number } | null
}) {
  const { state, dispatch } = useStore()
  const node = nodeProp ?? activeNode(state)
  const isHardware = node.system === "hardware"
  const sections = node.slots.length
  const { currentShelf } = node.machine

  const posRef = useRef(currentShelf)
  const [pos, setPos] = useState(currentShelf)
  const activeColRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const target = currentShelf
      let p = posRef.current
      let diff = (((target - p) % sections) + sections) % sections
      if (diff > sections / 2) diff -= sections
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
  }, [currentShelf, sections])

  useEffect(() => {
    if (!highlight || highlight.shelf !== currentShelf) return
    const container = activeColRef.current
    if (!container) return
    const el = container.querySelector<HTMLElement>(`[data-slot="${highlight.slot}"]`)
    if (!el) return
    const cRect = container.getBoundingClientRect()
    const eRect = el.getBoundingClientRect()
    const delta = eRect.top - cRect.top - (container.clientHeight - eRect.height) / 2
    container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" })
  }, [highlight, currentShelf, pos])

  const scrollCol = useCallback((dir: "up" | "down") => {
    activeColRef.current?.scrollBy({ top: dir === "up" ? -160 : 160, behavior: "smooth" })
  }, [])

  const canChangeSection = node.machine.homed && node.machine.status === "idle" && !state.job

  const settled = Math.abs(pos - currentShelf) < 0.06
  const inferredSensing =
    node.machine.homed && settled && node.machine.status !== "moving" && node.machine.status !== "homing"
  const sensing =
    node.driver === "hardware" && node.machine.sensor != null ? node.machine.sensor : inferredSensing

  const base = Math.round(pos)
  const offsets = [-3, -2, -1, 0, 1, 2, 3]

  return (
    <div
      id="pax-carousel"
      className="relative h-[560px] scroll-mt-3 overflow-hidden rounded-2xl border border-border bg-gradient-to-r from-background via-card to-background lg:h-auto lg:min-h-[300px] lg:flex-1"
    >
      {/* Horizontal rails the sections ride along */}
      <div className="pointer-events-none absolute inset-x-4 top-3 h-1.5 rounded-full bg-black/40" />
      <div className="pointer-events-none absolute inset-x-4 bottom-3 h-1.5 rounded-full bg-black/40" />

      {/* Fixed vertical access window */}
      <div
        className="pointer-events-none absolute inset-y-6 left-1/2 z-20 -translate-x-1/2 rounded-2xl border-2 border-primary/70 shadow-[0_0_30px_rgba(80,150,255,0.15)]"
        style={{ width: COL_WIDTH - 12 }}
      />

      <div
        className="pointer-events-none absolute top-9 z-30"
        style={{ left: `calc(50% + ${(COL_WIDTH - 12) / 2}px - 38px)` }}
      >
        <SensorLight on={sensing} />
      </div>

      <div className="absolute inset-0">
        {offsets.map((off) => {
          const k = base + off
          const index = ((k % sections) + sections) % sections
          const dist = Math.abs(k - pos)
          const scale = 1 - Math.min(dist, 3) * 0.07
          const opacity = 1 - Math.min(dist, 3) * 0.26
          const isCenter = dist < 0.5
          const x = (k - pos) * COL_WIDTH
          const col = node.slots[index] ?? []

          return (
            <div
              key={k}
              className="absolute inset-y-0 left-1/2 flex flex-col items-center pb-14 pt-14"
              style={{
                width: COL_WIDTH,
                transform: `translateX(calc(-50% + ${x}px)) scale(${scale})`,
                opacity: Math.max(0, opacity),
                zIndex: isCenter ? 30 : 10,
                willChange: "transform",
              }}
            >
              <span
                className={cn(
                  "mb-3 max-w-full truncate px-2 font-mono text-base font-semibold lg:text-lg",
                  isCenter ? "text-primary" : "text-muted-foreground",
                )}
              >
                {sectionLabel(node, index)}
              </span>

              <div
                ref={isCenter ? activeColRef : undefined}
                className="flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden scrollbar-thin"
              >
                {col.map((id, slot) => {
                  const size = isCenter ? 68 : 44
                  const isHi = isCenter && highlight && highlight.shelf === index && highlight.slot === slot
                  if (isHardware) {
                    const part = id ? state.parts?.[id] : null
                    const low = part ? isPartLow(part) : false
                    return (
                      <button
                        key={slot}
                        type="button"
                        data-slot={isCenter ? slot : undefined}
                        disabled={!isCenter}
                        onClick={() => onSlotClick(index, slot)}
                        className={cn(
                          "flex w-full shrink-0 items-center gap-2 rounded-xl px-2 py-1 transition-colors",
                          isCenter ? "hover:bg-primary/10" : "justify-center",
                          isHi && "animate-slot-flash",
                        )}
                      >
                        <span
                          className={cn(
                            "w-4 shrink-0 text-right font-mono text-xs",
                            isCenter ? "text-muted-foreground" : "text-muted-foreground/60",
                          )}
                        >
                          {slot + 1}
                        </span>
                        <span className="flex shrink-0 items-center justify-center" style={{ height: size }}>
                          {part ? (
                            <PartBox color={part.color} size={size} imageUrl={part.imageUrl} name={part.name} />
                          ) : (
                            <HardwareEmptySlot size={size} />
                          )}
                        </span>
                        {isCenter && part && (
                          <span className="flex min-w-0 flex-col items-start text-left leading-tight">
                            <span className="max-w-full truncate text-[11px] font-semibold text-foreground">
                              {part.name}
                            </span>
                            <span
                              className={cn("text-[10px]", low ? "font-semibold text-warning" : "text-muted-foreground")}
                            >
                              {part.lockedSlot && (
                                <Lock className="mr-0.5 inline h-2.5 w-2.5 align-[-1px]" aria-label="Locked slot" />
                              )}
                              {part.count} pcs
                            </span>
                            {part.category ? (
                              <span className="max-w-full truncate text-[10px] text-muted-foreground">
                                {part.category}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </button>
                    )
                  }
                  const spool = id ? state.spools[id] : null
                  return (
                    <button
                      key={slot}
                      type="button"
                      data-slot={isCenter ? slot : undefined}
                      disabled={!isCenter}
                      onClick={() => onSlotClick(index, slot)}
                      className={cn(
                        "flex w-full shrink-0 items-center gap-2 rounded-xl px-2 py-1 transition-colors",
                        isCenter ? "hover:bg-primary/10" : "justify-center",
                        isHi && "animate-slot-flash",
                      )}
                    >
                      <span
                        className={cn(
                          "w-4 shrink-0 text-right font-mono text-xs",
                          isCenter ? "text-muted-foreground" : "text-muted-foreground/60",
                        )}
                      >
                        {slot + 1}
                      </span>
                      <span className="flex shrink-0 items-center justify-center" style={{ height: size }}>
                        {spool ? (
                          <SpoolDisc
                            color={spool.color}
                            color2={discColor2(spool)}
                            size={size}
                            fill={spoolFill(spool)}
                            boxed={!!spool.containerId}
                            fit
                          />
                        ) : (
                          <EmptySlot size={size} />
                        )}
                      </span>
                      {isCenter && spool && (
                        <span className="flex min-w-0 flex-col items-start text-left leading-tight">
                          <span className="text-[11px] font-semibold text-foreground">{spool.material}</span>
                          <span className="flex max-w-full items-center gap-1 text-[10px] text-muted-foreground">
                            <span
                              className="h-2 w-2 shrink-0 rounded-full border border-border"
                              style={{ backgroundColor: spool.color }}
                              aria-hidden
                            />
                            <span className="truncate">{spool.colorName?.trim() || spool.color}</span>
                          </span>
                          <span className="text-[10px] text-muted-foreground">{formatRemaining(spool)}</span>
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

      {/* Up / down: scroll slots within the active section */}
      <NavArrow side="up" onClick={() => scrollCol("up")} label="Scroll slots up" />
      <NavArrow side="down" onClick={() => scrollCol("down")} label="Scroll slots down" />

      {/* Left / right: rotate the carousel to the neighbouring section */}
      <NavArrow
        side="left"
        disabled={!canChangeSection}
        onClick={() => dispatch({ type: "MANUAL_MOVE", nodeId: node.id, direction: "up" })}
        label="Rotate to the section on the left"
      />
      <NavArrow
        side="right"
        disabled={!canChangeSection}
        onClick={() => dispatch({ type: "MANUAL_MOVE", nodeId: node.id, direction: "down" })}
        label="Rotate to the section on the right"
      />
    </div>
  )
}

function SensorLight({ on }: { on: boolean }) {
  return (
    <span
      role="img"
      aria-label={on ? "Section sensor: section detected" : "Section sensor: no section detected"}
      title={on ? "Sensor: section detected" : "Sensor: no section detected"}
      className={cn(
        "block h-7 w-7 rounded-full border-2 transition-all duration-200",
        on
          ? "border-warning bg-warning shadow-[0_0_14px_3px_var(--warning)]"
          : "border-muted-foreground/50 bg-card/40",
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
          ? "top-5 left-1/2 -translate-x-1/2"
          : "bottom-5 left-1/2 -translate-x-1/2"
  const size = side === "left" || side === "right" ? "h-11 w-9" : "h-9 w-11"
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
