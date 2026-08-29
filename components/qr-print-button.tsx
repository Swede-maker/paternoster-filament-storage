"use client"

import { useState } from "react"
import { Printer } from "lucide-react"
import { Button } from "./ui/button"
import { printQrLabels, QR_PRINT_SIZES, DEFAULT_QR_SIZE_MM, type QrLabelSpec } from "@/lib/qr"

/**
 * Print one or more QR labels with a size picker (Small / Medium / Large). The
 * chosen size is a real physical measurement sent to the printer, so a label
 * comes out the requested millimeter size on paper. Used everywhere a QR can be
 * printed — spool creation, a spool's Edit dialog, and storage-location codes.
 */
export function QrPrintButton({
  labels,
  size = "sm",
  variant = "outline",
  className,
}: {
  /** The label(s) to print. When more than one, the button prints them all. */
  labels: QrLabelSpec[]
  /** Button size passed through to the underlying Button. */
  size?: "sm" | "md"
  variant?: "outline" | "ghost" | "primary" | "secondary"
  className?: string
}) {
  const [sizeMm, setSizeMm] = useState<number>(DEFAULT_QR_SIZE_MM)
  const count = labels.length
  if (count === 0) return null

  return (
    <div className={className ? className : "flex items-center gap-2"}>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="sr-only">QR print size</span>
        <select
          value={sizeMm}
          onChange={(e) => setSizeMm(Number(e.target.value))}
          aria-label="QR print size"
          className="h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
        >
          {QR_PRINT_SIZES.map((s) => (
            <option key={s.id} value={s.mm}>
              {s.label} ({s.mm}mm)
            </option>
          ))}
        </select>
      </label>
      <Button size={size} variant={variant} onClick={() => printQrLabels(labels, { sizeMm })}>
        <Printer className="h-4 w-4" /> {count > 1 ? `Print all ${count}` : "Print"}
      </Button>
    </div>
  )
}
