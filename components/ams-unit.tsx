"use client"

import { Flame } from "lucide-react"
import { cn } from "@/lib/utils"
import { spoolFill } from "@/lib/filament"
import { SpoolRoll } from "./spool"
import type { Spool } from "@/lib/types"

/**
 * A rendered AMS unit: an enclosure holding N side-view spool rolls, with a row
 * of labelled slots underneath. Empty slots show a dashed placeholder.
 */
export function AmsUnit({
  index,
  slots,
  onSlotClick,
  activeSlot,
  queuedSlots,
}: {
  index: number
  slots: { spool: Spool | null; globalIndex: number }[]
  onSlotClick?: (globalIndex: number) => void
  activeSlot?: number | null
  queuedSlots?: number[]
}) {
  return (
    <div className="shrink-0">
      <div className="mb-1 flex items-center gap-2 px-1">
        <span className="h-2 w-2 rounded-full bg-success" />
        <span className="text-sm font-medium text-foreground">AMS {index + 1}</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-black/60 bg-gradient-to-b from-neutral-800 to-neutral-950 shadow-lg">
        {/* Roll bay */}
        <div className="flex items-end justify-center gap-1 border-b border-black/70 bg-black/40 px-3 pt-4 pb-1">
          {slots.map(({ spool }, i) =>
            spool ? (
              <SpoolRoll key={i} color={spool.color} height={72} fill={spoolFill(spool)} />
            ) : (
              <div
                key={i}
                className="mx-1 h-[72px] w-[38px] rounded-md border border-dashed border-white/10 bg-black/30"
                aria-hidden="true"
              />
            ),
          )}
        </div>

        {/* Slot labels */}
        <div className="flex justify-center gap-1 p-2">
          {slots.map(({ spool, globalIndex }, i) => {
            const isActive = activeSlot === globalIndex
            const isQueued = queuedSlots?.includes(globalIndex)
            return (
              <button
                key={i}
                type="button"
                disabled={!onSlotClick}
                onClick={() => onSlotClick?.(globalIndex)}
                className={cn(
                  "flex h-14 w-16 flex-col items-center justify-center gap-0.5 rounded-md border text-center transition-colors",
                  isActive
                    ? "border-primary bg-primary/15 ring-1 ring-primary"
                    : isQueued
                      ? "border-primary/50 bg-primary/10"
                      : "border-white/10 bg-black/30",
                  onSlotClick && "hover:border-primary/60",
                )}
              >
                <span className="font-mono text-xs text-muted-foreground">{i + 1}</span>
                {spool ? (
                  <>
                    <span className="text-[11px] font-semibold leading-none text-foreground">{spool.material}</span>
                    <span className="flex max-w-full items-center gap-1 text-[10px] leading-none text-muted-foreground">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full border border-border"
                        style={{ backgroundColor: spool.color }}
                        aria-hidden
                      />
                      <span className="truncate">{spool.colorName}</span>
                    </span>
                  </>
                ) : (
                  <span className="text-[10px] text-muted-foreground/50">empty</span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** A single toolhead render (toolchanger). */
export function Toolhead({
  index,
  spool,
  onClick,
  isActive,
  isQueued,
  actualTemp,
  targetTemp,
}: {
  index: number
  spool: Spool | null
  onClick?: () => void
  isActive?: boolean
  isQueued?: boolean
  /** Live actual nozzle temp (°C) read back from the printer, or null if unknown. */
  actualTemp?: number | null
  /** Live target nozzle temp (°C) reported by the printer, or null if unknown. */
  targetTemp?: number | null
}) {
  const color = spool?.color ?? "#2a2a2e"
  const hasActual = actualTemp != null
  const heating = targetTemp != null && targetTemp > 0
  return (
    <div className="flex w-[92px] shrink-0 flex-col gap-1">
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      className={cn(
        "flex w-full flex-col items-center gap-1 rounded-xl border p-2 transition-colors",
        isActive
          ? "border-primary bg-primary/15 ring-1 ring-primary"
          : isQueued
            ? "border-primary/50 bg-primary/10"
            : "border-border bg-card",
        onClick && "hover:border-primary/60",
      )}
    >
      <span className="font-mono text-xs font-semibold text-foreground">T{index + 1}</span>

      {/* Toolhead body */}
      <div className="relative h-16 w-14" aria-hidden="true">
        <div className="absolute inset-x-2 top-0 h-6 rounded-t-md bg-neutral-700" />
        <div
          className="absolute inset-x-0 top-4 h-7 rounded-md border border-black/50"
          style={{ background: `linear-gradient(180deg, ${color}, rgba(0,0,0,0.5))` }}
        />
        {/* nozzle */}
        <div className="absolute bottom-0 left-1/2 h-4 w-3 -translate-x-1/2 rounded-b-sm bg-neutral-500"
          style={{ clipPath: "polygon(0 0, 100% 0, 65% 100%, 35% 100%)" }}
        />
      </div>

      {spool ? (
        <div className="flex flex-col items-center leading-tight">
          <div className="text-[11px] font-semibold text-foreground">{spool.material}</div>
          <div className="flex max-w-full items-center gap-1 text-[10px] text-muted-foreground">
            <span
              className="h-2 w-2 shrink-0 rounded-full border border-border"
              style={{ backgroundColor: spool.color }}
              aria-hidden
            />
            <span className="truncate">{spool.colorName}</span>
          </div>
        </div>
      ) : (
        <span className="text-[10px] text-muted-foreground/50">empty</span>
      )}
    </button>

    {/* Read-only live nozzle temperature reported by the printer. Shows
        actual→target while heating, just the actual otherwise. */}
    {hasActual && (
      <div
        className={cn(
          "flex items-center justify-center gap-1 rounded-lg border px-1.5 py-1 text-[10px] font-medium tabular-nums",
          heating
            ? "border-amber-500/50 bg-amber-500/15 text-amber-500"
            : "border-border bg-background/50 text-muted-foreground",
        )}
        title={
          heating
            ? `Nozzle ${Math.round(actualTemp!)}°C, heating to ${Math.round(targetTemp!)}°C`
            : `Nozzle ${Math.round(actualTemp!)}°C`
        }
      >
        <Flame className={cn("h-3 w-3", heating && "animate-pulse")} />
        {heating ? `${Math.round(actualTemp!)}→${Math.round(targetTemp!)}°` : `${Math.round(actualTemp!)}°C`}
      </div>
    )}
    </div>
  )
}
