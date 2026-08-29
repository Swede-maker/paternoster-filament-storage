"use client"

import { useMemo } from "react"
import { qrPayload } from "@/lib/tags"
import { qrSvgMarkup } from "@/lib/qr"
import { cn } from "@/lib/utils"

/**
 * Renders a printable QR code for a tag id on a white card. The code encodes the
 * `PAX:`-prefixed payload so a camera scan is recognised as one of our tags.
 */
export function QrCode({
  id,
  size = 200,
  className,
}: {
  id: string
  size?: number
  className?: string
}) {
  const markup = useMemo(() => qrSvgMarkup(qrPayload(id), size), [id, size])

  if (!markup) {
    return (
      <div
        className={cn("flex items-center justify-center rounded-xl bg-muted text-xs text-muted-foreground", className)}
        style={{ width: size, height: size }}
      >
        QR unavailable
      </div>
    )
  }

  return (
    <div
      className={cn("rounded-xl bg-white p-3", className)}
      style={{ width: size, height: size }}
      // The markup is generated locally from our own id — no user HTML.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}
