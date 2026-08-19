"use client"

import { useMemo } from "react"
import { Droplets, AlertTriangle, RotateCcw, X, CalendarClock } from "lucide-react"
import { useStore } from "@/lib/store"
import { reminderDueAt, isReminderDue } from "@/lib/selectors"
import type { Spool } from "@/lib/types"
import { SpoolDisc, discColor2 } from "./spool"
import { spoolFill } from "@/lib/filament"
import { Button } from "./ui/button"
import { cn } from "@/lib/utils"

const DAY_MS = 86_400_000

/**
 * Filament Drying tab. Lists every spool that has a dry reminder, split into
 * "Time to dry" (overdue/due today) and "Scheduled". The due count drives the
 * alert badge on the bottom nav. Reminders are set from a spool's action sheet;
 * here the user can reset the countdown once dried, or clear the reminder.
 */
export function FilamentDryingView() {
  const { state, dispatch } = useStore()
  const now = Date.now()
  const spools = state.spools

  const { due, upcoming } = useMemo(() => {
    const withReminder = Object.values(spools).filter((s) => s.dryReminder)
    const due = withReminder
      .filter((s) => isReminderDue(s, now))
      .sort((a, b) => (reminderDueAt(a) ?? 0) - (reminderDueAt(b) ?? 0))
    const upcoming = withReminder
      .filter((s) => !isReminderDue(s, now))
      .sort((a, b) => (reminderDueAt(a) ?? 0) - (reminderDueAt(b) ?? 0))
    return { due, upcoming }
  }, [spools, now])

  const total = due.length + upcoming.length

  function reset(spoolId: string) {
    dispatch({ type: "RESET_DRY_REMINDER", spoolId })
  }
  function clear(spoolId: string) {
    dispatch({ type: "CLEAR_DRY_REMINDER", spoolId })
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-balance text-2xl font-semibold text-foreground">Filament Drying</h1>
        <p className="mt-1 text-pretty text-sm text-muted-foreground">
          Every spool with a dry reminder. Filament left out absorbs moisture and turns brittle — reset a spool&apos;s
          countdown once you&apos;ve dried it.
        </p>
      </header>

      {total === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-16 text-center">
          <Droplets className="h-8 w-8 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">No dry reminders yet</p>
            <p className="mt-1 text-xs text-muted-foreground text-pretty">
              Open a spool from storage or a printer and choose &ldquo;Set dry reminder&rdquo; to track it here.
            </p>
          </div>
        </div>
      ) : (
        <>
          {due.length > 0 && (
            <section aria-label="Filament that needs drying" className="mb-6">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <h2 className="text-sm font-semibold text-foreground">Time to dry ({due.length})</h2>
              </div>
              <ul className="flex flex-col gap-2">
                {due.map((s) => (
                  <ReminderRow key={s.id} spool={s} now={now} due onReset={reset} onClear={clear} />
                ))}
              </ul>
            </section>
          )}

          {upcoming.length > 0 && (
            <section aria-label="Scheduled dry reminders">
              <div className="mb-2 flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold text-muted-foreground">Scheduled ({upcoming.length})</h2>
              </div>
              <ul className="flex flex-col gap-2">
                {upcoming.map((s) => (
                  <ReminderRow key={s.id} spool={s} now={now} onReset={reset} onClear={clear} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

/** A single dry-reminder row with reset / clear controls. */
function ReminderRow({
  spool,
  now,
  due,
  onReset,
  onClear,
}: {
  spool: Spool
  now: number
  due?: boolean
  onReset: (id: string) => void
  onClear: (id: string) => void
}) {
  const dueAt = reminderDueAt(spool) ?? 0
  const diffDays = Math.round((dueAt - now) / DAY_MS)
  const when = due
    ? diffDays <= -1
      ? `Overdue by ${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? "" : "s"}`
      : "Due today"
    : diffDays <= 1
      ? "Due tomorrow"
      : `Due in ${diffDays} days`

  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-xl border p-3",
        due ? "border-warning/40 bg-warning/10" : "border-border bg-card",
      )}
    >
      <SpoolDisc color={spool.color} color2={discColor2(spool)} size={40} fill={spoolFill(spool)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {spool.material} · {spool.colorName}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {spool.brand} · {when}
          {spool.dryReminder ? ` · every ${spool.dryReminder.days} days` : ""}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onReset(spool.id)} className="h-8 gap-1 px-2 text-xs">
          <RotateCcw className="h-3.5 w-3.5" />
          Dried
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onClear(spool.id)}
          aria-label="Delete dry reminder"
          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </li>
  )
}
