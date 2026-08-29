"use client"

import { useMemo, useState } from "react"
import { Scale, RotateCcw, ChevronDown } from "lucide-react"
import { useStore } from "@/lib/store"
import { formatGrams } from "@/lib/filament"
import { cn } from "@/lib/utils"
import { usePersistentBoolean } from "@/lib/use-persistent"
import { Button } from "./ui/button"

/** Sum of every gram ever tracked: the open tally plus all archived tallies. */
export function lifetimeGrams(usage: { currentG: number; archived: { grams: number }[] }): number {
  return usage.archived.reduce((sum, a) => sum + a.grams, 0) + usage.currentG
}

function sinceLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

/**
 * "Total filament used" window. Shows the lifetime grams the printers have
 * extruded (all tracked consumption) alongside the current tally since the last
 * reset. Resetting archives the current tally — nothing is lost, the archived
 * totals live under the History tab.
 */
export function FilamentUsedCard() {
  const { state, dispatch } = useStore()
  const usage = state.usage
  const [confirming, setConfirming] = useState(false)
  // Collapse the totals to reclaim space; header stays as a thin bar. Starts
  // open and the choice is remembered per device.
  const [open, setOpen] = usePersistentBoolean("pax:home:usageOpen", true)

  const lifetime = useMemo(() => lifetimeGrams(usage), [usage])
  const hasArchive = usage.archived.length > 0

  // Home-view visibility is user-controlled (chosen at setup, editable in
  // Settings). When off, the totals live only under History, so render nothing
  // here. Defaults to shown when the setting is absent (older saves).
  if (state.settings.showUsageCardOnHome === false) return null

  return (
    <section
      aria-label="Total filament used"
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          {/* Hide/show the totals to free up space. Sits on the left, matching
              the printer panel's collapse chevron. */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Hide total filament used" : "Show total filament used"}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform", open ? "rotate-180" : "rotate-0")} />
          </button>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary">
            <Scale className="h-4 w-4 text-muted-foreground" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Total filament used</h2>
            <p className="text-xs text-muted-foreground">Every gram your printers have extruded</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {open &&
            (confirming ? (
              <div className="flex items-center gap-2">
                <span className="hidden text-xs text-muted-foreground sm:inline">Reset counter?</span>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    dispatch({ type: "RESET_FILAMENT_USAGE" })
                    setConfirming(false)
                  }}
                >
                  Confirm
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-muted-foreground"
                onClick={() => setConfirming(true)}
                disabled={usage.currentG <= 0}
                title="Archive the current tally and start counting from zero"
              >
                <RotateCcw className="h-4 w-4" />
                Reset
              </Button>
            ))}
        </div>
      </div>

      {open && (
        <>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Since reset</span>
              <p className="font-mono text-3xl font-bold text-foreground">{formatGrams(usage.currentG)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Started {sinceLabel(usage.since)}</p>
            </div>
            {hasArchive && (
              <div>
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Lifetime</span>
                <p className="font-mono text-2xl font-semibold text-primary">{formatGrams(lifetime)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Across {usage.archived.length + 1} tall{usage.archived.length === 0 ? "y" : "ies"}
                </p>
              </div>
            )}
          </div>

          {hasArchive && (
            <p className="text-xs text-muted-foreground">Past totals are saved under the History tab.</p>
          )}
        </>
      )}
    </section>
  )
}
