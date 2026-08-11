"use client"

import { cn } from "@/lib/utils"

/**
 * Front-facing filament spool rendered purely with CSS: a wound colored
 * filament ring, a dark plastic hub with mounting holes, and a center bore.
 */
export function SpoolDisc({
  color,
  size = 72,
  className,
  dim,
  fill = 1,
  boxed = false,
  fit = false,
}: {
  color: string
  size?: number
  className?: string
  dim?: boolean
  /** Fraction of filament remaining (0–1). Lower values shrink and fade the
   *  colored winding so a nearly-empty spool reads at a glance. */
  fill?: number
  /** When true, draw a container/dry-box frame around the spool to show it's
   *  stored inside a box. Purely decorative. */
  boxed?: boolean
  /** When true, a boxed spool's frame stays within `size` (the disc shrinks to
   *  make room) so it occupies the same footprint as a bare disc. Used in tight
   *  layouts (e.g. the carousel) where a larger box would push neighboring
   *  labels out of place. */
  fit?: boolean
}) {
  const f = Math.max(0, Math.min(1, fill))
  // A boxed spool sits inside a rounded square frame. Normally the frame extends
  // beyond the disc; with `fit`, the frame stays within `size` and the disc
  // shrinks instead so the overall footprint matches a bare disc.
  const pad = boxed ? size * 0.14 : 0
  const d = boxed && fit ? size - pad * 2 : size
  // The colored winding shrinks toward the hub as filament is used.
  const filamentInset = d * (0.07 + (1 - f) * 0.2)
  const colorOpacity = 0.4 + 0.6 * f
  const disc = (
    <div
      className={cn("relative shrink-0 rounded-full", boxed ? undefined : className)}
      style={{ width: d, height: d, opacity: dim ? 0.5 : 1 }}
      aria-hidden="true"
    >
      {/* Outer flange rim */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: "radial-gradient(circle at 35% 30%, #3a3a40, #17171a 70%)",
          boxShadow: "inset 0 2px 4px rgba(255,255,255,0.12), 0 2px 6px rgba(0,0,0,0.5)",
        }}
      />
      {/* Empty winding track revealed as the spool depletes */}
      <div
        className="absolute rounded-full"
        style={{
          inset: d * 0.07,
          background: "radial-gradient(circle at 40% 32%, #26262b, #0d0d0f 78%)",
          boxShadow: `inset 0 0 ${d * 0.1}px rgba(0,0,0,0.7)`,
        }}
      />
      {/* Wound filament (shrinks + fades with remaining amount) */}
      <div
        className="absolute rounded-full transition-all"
        style={{
          inset: filamentInset,
          opacity: colorOpacity,
          background: `radial-gradient(circle at 34% 28%, ${color}, ${color} 55%, rgba(0,0,0,0.35) 100%)`,
          boxShadow: `inset 0 0 ${d * 0.08}px rgba(0,0,0,0.45)`,
        }}
      />
      {/* Filament winding texture */}
      <div
        className="absolute rounded-full mix-blend-overlay"
        style={{
          inset: filamentInset,
          background:
            "repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,0.10) 0, rgba(255,255,255,0.10) 1px, transparent 1px, transparent 4px)",
        }}
      />
      {/* Dark plastic hub */}
      <div
        className="absolute rounded-full"
        style={{
          inset: d * 0.3,
          background: "radial-gradient(circle at 38% 32%, #2c2c31, #101012 75%)",
          boxShadow: "inset 0 1px 2px rgba(255,255,255,0.14)",
        }}
      />
      {/* Center bore */}
      <div
        className="absolute rounded-full"
        style={{
          inset: d * 0.42,
          background: "radial-gradient(circle at 50% 40%, #050506, #1a1a1d)",
          boxShadow: "inset 0 1px 3px rgba(0,0,0,0.8)",
        }}
      />
    </div>
  )

  if (!boxed) return disc

  // Container / dry-box frame: a rounded square enclosure around the spool.
  // With `fit` the outer equals `size`; otherwise it extends beyond the disc.
  const outer = fit ? size : size + pad * 2
  return (
    <div
      className={cn("relative flex shrink-0 items-center justify-center", className)}
      style={{ width: outer, height: outer, opacity: dim ? 0.5 : 1 }}
      aria-hidden="true"
    >
      <div
        className="absolute inset-0"
        style={{
          borderRadius: Math.max(6, size * 0.16),
          background: "color-mix(in oklch, var(--color-primary) 12%, transparent)",
          border: "2px solid color-mix(in oklch, var(--color-primary) 70%, transparent)",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06), 0 1px 4px rgba(0,0,0,0.45)",
        }}
      />
      {disc}
    </div>
  )
}

/** An empty carousel slot: a dark, recessed circle. */
export function EmptySlot({ size = 72, className }: { size?: number; className?: string }) {
  return (
    <div
      className={cn("relative shrink-0 rounded-full", className)}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <div
        className="absolute inset-0 rounded-full border"
        style={{
          background: "radial-gradient(circle at 40% 35%, #1b1b1f, #0a0a0c 80%)",
          borderColor: "var(--slot-ring)",
          boxShadow: "inset 0 3px 8px rgba(0,0,0,0.7)",
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          inset: size * 0.4,
          background: "radial-gradient(circle at 50% 40%, #050506, #141416)",
          boxShadow: "inset 0 1px 3px rgba(0,0,0,0.9)",
        }}
      />
    </div>
  )
}

/** Side view of a spool as it sits in an AMS unit (a vertical roll). */
export function SpoolRoll({ color, height = 78, fill = 1 }: { color: string; height?: number; fill?: number }) {
  const width = height * 0.7
  const f = Math.max(0, Math.min(1, fill))
  // Thinner roll + faded color as the spool depletes.
  const sidePad = (1 - f) * width * 0.3
  const colorOpacity = 0.4 + 0.6 * f
  return (
    <div className="relative" style={{ width, height }} aria-hidden="true">
      {/* Empty core revealed behind the winding */}
      <div
        className="absolute bottom-0 left-0 right-0 rounded-md"
        style={{ top: height * 0.1, background: "linear-gradient(90deg, #1a1a1d, #0c0c0e)" }}
      />
      {/* body */}
      <div
        className="absolute bottom-0 rounded-md transition-all"
        style={{
          top: height * 0.1,
          left: sidePad,
          right: sidePad,
          opacity: colorOpacity,
          background: `linear-gradient(90deg, rgba(0,0,0,0.4), ${color} 30%, ${color} 60%, rgba(0,0,0,0.45))`,
          boxShadow: "inset 0 -6px 10px rgba(0,0,0,0.45)",
        }}
      />
      {/* winding lines */}
      <div
        className="absolute bottom-0 rounded-md opacity-40 mix-blend-overlay"
        style={{
          top: height * 0.1,
          left: sidePad,
          right: sidePad,
          background:
            "repeating-linear-gradient(180deg, rgba(255,255,255,0.25) 0, rgba(255,255,255,0.25) 1px, transparent 1px, transparent 6px)",
        }}
      />
      {/* top ellipse cap */}
      <div
        className="absolute rounded-[50%] transition-all"
        style={{
          top: 0,
          left: sidePad,
          right: sidePad,
          height: height * 0.2,
          opacity: colorOpacity,
          background: `radial-gradient(circle at 40% 30%, ${color}, rgba(0,0,0,0.55))`,
          boxShadow: "inset 0 2px 3px rgba(255,255,255,0.25)",
        }}
      />
    </div>
  )
}
