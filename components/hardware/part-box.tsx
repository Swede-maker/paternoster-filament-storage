"use client"

import { Package } from "lucide-react"
import { isLightColor } from "@/lib/filament"

/** Fallback slot color when a part has no color chosen — a friendly bin blue. */
export const DEFAULT_TOTE_COLOR = "#3b82f6"

/** Mix a hex color toward black (amount 0..1) for shaded tote facets. */
function shade(hex: string, amount: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  if (!m) return hex
  const r = Math.round(Number.parseInt(m[1], 16) * (1 - amount))
  const g = Math.round(Number.parseInt(m[2], 16) * (1 - amount))
  const b = Math.round(Number.parseInt(m[3], 16) * (1 - amount))
  return `rgb(${r}, ${g}, ${b})`
}

/**
 * An empty hardware slot — a dark, inset rounded square frame (mirrors the tote
 * footprint so full and empty slots line up in the carousel and grid). Replaces
 * the filament spherical {@link EmptySlot} on the hardware side to match the
 * "bin rack" look.
 */
export function HardwareEmptySlot({ size = 68 }: { size?: number }) {
  return (
    <div
      aria-hidden
      style={{ width: size, height: size }}
      className="rounded-[22%] border border-white/10 bg-black/30 shadow-inner"
    />
  )
}

/**
 * Visual for a hardware part occupying a slot — a stackable plastic storage
 * tote, rendered in the part's chosen color (falling back to bin blue). It fills
 * the slot footprint so occupied slots read as colored bins in a rack. If the
 * part has a photo it's framed inside the tote's front face instead of the
 * package glyph. Mirrors how {@link SpoolDisc} represents a filament spool.
 */
export function PartBox({
  color,
  size = 72,
  className,
  imageUrl,
  name,
}: {
  color?: string | null
  size?: number
  className?: string
  imageUrl?: string | null
  name?: string
}) {
  const c = color && color.trim() ? color : DEFAULT_TOTE_COLOR
  const rim = shade(c, 0.16)
  const side = shade(c, 0.34)
  const front = c
  const glyph = isLightColor(c) ? "#27272a" : "#ffffff"
  const uid = sanitize(c) + Math.round(size)

  return (
    <div className={className} style={{ width: size, height: size, position: "relative" }} aria-hidden title={name}>
      <svg viewBox="0 0 100 100" width={size} height={size} role="presentation">
        <defs>
          <clipPath id={`tote-face-${uid}`}>
            {/* Front face trapezoid — used to clip an optional photo. */}
            <path d="M12 30 H88 L82 92 Q81 96 76 96 H24 Q19 96 18 92 Z" />
          </clipPath>
          <linearGradient id={`tote-front-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={front} />
            <stop offset="1" stopColor={shade(c, 0.16)} />
          </linearGradient>
        </defs>

        {/* Back rim lip (slightly wider than the body, sits behind). */}
        <rect x="8" y="14" width="84" height="18" rx="5" fill={rim} />
        {/* Handle cutouts on the rim. */}
        <rect x="30" y="18" width="16" height="6" rx="3" fill={shade(c, 0.52)} />
        <rect x="54" y="18" width="16" height="6" rx="3" fill={shade(c, 0.52)} />

        {/* Left/right tapered side walls give the tote a 3D bin look. */}
        <path d="M12 30 L18 92 Q19 96 24 96 L26 30 Z" fill={side} />
        <path d="M88 30 L82 92 Q81 96 76 96 L74 30 Z" fill={side} />

        {/* Front face. */}
        <path d="M12 30 H88 L82 92 Q81 96 76 96 H24 Q19 96 18 92 Z" fill={`url(#tote-front-${uid})`} />

        {imageUrl ? (
          <image
            href={imageUrl}
            x="12"
            y="30"
            width="76"
            height="66"
            preserveAspectRatio="xMidYMid slice"
            clipPath={`url(#tote-face-${uid})`}
          />
        ) : (
          /* Two front ribs so an empty-labelled tote still reads as a bin. */
          <>
            <line x1="34" y1="38" x2="31" y2="90" stroke={shade(c, 0.24)} strokeWidth="1.6" opacity="0.55" />
            <line x1="66" y1="38" x2="69" y2="90" stroke={shade(c, 0.24)} strokeWidth="1.6" opacity="0.55" />
          </>
        )}
      </svg>

      {!imageUrl && (
        <span
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            paddingTop: size * 0.1,
          }}
        >
          <Package style={{ width: size * 0.36, height: size * 0.36, color: glyph, opacity: 0.92 }} />
        </span>
      )}
    </div>
  )
}

/**
 * List thumbnail for a part. When the part has a photo, show it plainly in a
 * rounded frame (clearer than squeezing it into the tote face); otherwise fall
 * back to the colored {@link PartBox} tote. Used in the "All Hardware" list.
 */
export function PartThumb({
  color,
  imageUrl,
  name,
  size = 44,
}: {
  color?: string | null
  imageUrl?: string | null
  name?: string
  size?: number
}) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl || "/placeholder.svg"}
        alt={name ? `Photo of ${name}` : "Hardware photo"}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-lg border border-border object-cover"
      />
    )
  }
  return <PartBox color={color} size={size} name={name} />
}

/** Make a hex safe for use inside an SVG id. */
function sanitize(hex: string): string {
  return hex.replace(/[^a-z0-9]/gi, "")
}
