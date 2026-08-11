"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

interface DialogProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode
  /** max width class, e.g. "max-w-lg" */
  className?: string
  /** Hide the default close button (for flows that manage their own controls). */
  hideClose?: boolean
  title?: string
  description?: string
}

export function Dialog({ open, onClose, children, className, hideClose, title, description }: DialogProps) {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!mounted || !open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative z-10 w-full rounded-t-2xl border border-border bg-popover text-popover-foreground shadow-2xl",
          "sm:rounded-2xl animate-in fade-in slide-in-from-bottom-4 sm:zoom-in-95",
          "max-h-[92vh] overflow-y-auto scrollbar-thin",
          className ?? "max-w-lg",
        )}
      >
        {(title || !hideClose) && (
          <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-popover/95 px-5 py-4 backdrop-blur">
            <div className="min-w-0">
              {title && <h2 className="text-lg font-semibold leading-tight text-pretty">{title}</h2>}
              {description && <p className="mt-0.5 text-sm text-muted-foreground text-pretty">{description}</p>}
            </div>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function DialogFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}>{children}</div>
}

/**
 * Header for dialogs that render their own title area (instead of passing
 * `title`/`description` to <Dialog>). Includes an icon badge.
 */
export function DialogHeader({
  icon,
  title,
  description,
  className,
}: {
  icon?: React.ReactNode
  title: string
  description?: string
  className?: string
}) {
  return (
    <div className={cn("mb-5 flex items-start gap-3", className)}>
      {icon && (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h2 className="text-lg font-semibold leading-tight text-pretty">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground text-pretty">{description}</p>}
      </div>
    </div>
  )
}

export function DialogBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={className}>{children}</div>
}
