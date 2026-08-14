"use client"

import { useState } from "react"
import { CheckCheck, Trash2, X, AlertTriangle } from "lucide-react"
import { Button } from "./ui/button"
import { cn } from "@/lib/utils"

/**
 * Action strip shown above a manual storage grid while in multi-select mode.
 * Multi-select is a bulk-delete tool: it selects spools and removes them, plus
 * select-all / clear / exit controls. (Bulk "add to queue" was removed — queueing
 * many spools at once was error-prone; queue spools one at a time from the slot
 * action dialog instead.) Delete is a deliberate two-step (click → confirm)
 * since it's destructive and can hit many spools at once.
 */
export function SpoolSelectionBar({
  count,
  total,
  onDelete,
  onSelectAll,
  onClear,
  onExit,
}: {
  count: number
  total: number
  onDelete: () => void
  onSelectAll: () => void
  onClear: () => void
  onExit: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const none = count === 0
  const allSelected = count > 0 && count === total

  // Destructive confirm step replaces the whole strip so the intent is obvious.
  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 p-3">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          Delete {count} {count === 1 ? "spool" : "spools"}? This can&apos;t be undone.
        </span>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              onDelete()
              setConfirming(false)
            }}
          >
            <Trash2 className="h-4 w-4" /> Delete {count}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-3">
      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
        <span
          className={cn(
            "inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-semibold",
            none ? "bg-secondary text-muted-foreground" : "bg-primary text-primary-foreground",
          )}
        >
          {count}
        </span>
        selected
      </span>

      <button
        type="button"
        onClick={allSelected ? onClear : onSelectAll}
        className="rounded-full bg-secondary/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {allSelected ? "Clear" : `Select all (${total})`}
      </button>

      <div className="ml-auto flex flex-wrap gap-2">
        <Button variant="destructive" size="sm" disabled={none} onClick={() => setConfirming(true)}>
          <Trash2 className="h-4 w-4" /> Delete{none ? "" : ` (${count})`}
        </Button>
        <Button variant="ghost" size="sm" onClick={onExit} aria-label="Exit selection mode">
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

/** The "Select" button that enters multi-select mode. */
export function SelectModeButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
      <CheckCheck className="h-4 w-4" /> Select
    </Button>
  )
}
