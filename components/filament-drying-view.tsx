"use client"

import { useEffect, useMemo, useState } from "react"
import { Droplets, AlertTriangle, RotateCcw, X, CalendarClock, Plus, Flame } from "lucide-react"
import { useStore } from "@/lib/store"
import { reminderDueAt, isReminderDue } from "@/lib/selectors"
import { getDryers } from "@/lib/dryers"
import type { Dryer, Spool } from "@/lib/types"
import { useFlow } from "./flow-controller"
import { DryerCard } from "./dryer-card"
import { DryerEditorDialog } from "./dryer-editor-dialog"
import { SendToDryerDialog } from "./send-to-dryer-dialog"
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
  const clock = useClock(30_000)
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

      <DryersSection now={clock} />

      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-lg font-semibold text-foreground">Dry reminders</h2>
      </div>

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

function useClock(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** Your filament dryers: capacity, what's inside, and each chamber's timer light. */
function DryersSection({ now }: { now: number }) {
  const { state } = useStore()
  const { outItems } = useFlow()
  const dryers = getDryers(state)
  const [editing, setEditing] = useState<Dryer | "new" | null>(null)
  const [sending, setSending] = useState(false)
  const queuedForDryers = outItems.filter((i) => i.dryerId).length

  return (
    <section aria-label="Dryers" className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">Dryers</h2>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing("new")} className="gap-1.5">
            <Plus className="h-4 w-4" />
            Add dryer
          </Button>
          {dryers.length > 0 && (
            <Button size="sm" onClick={() => setSending(true)} className="gap-1.5">
              <Flame className="h-4 w-4" />
              Send spools to dryer
            </Button>
          )}
        </div>
      </div>

      {queuedForDryers > 0 && (
        <p className="mb-3 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-sm text-foreground">
          {queuedForDryers} spool{queuedForDryers === 1 ? "" : "s"} queued for drying. Go to the{" "}
          <span className="font-semibold">Home</span> tab and press Start — PAX picks them all out first, then tells
          you which dryer each one goes in.
        </p>
      )}

      {dryers.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border py-10 text-center">
          <Flame className="h-7 w-7 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No dryers added</p>
          <p className="max-w-xs text-pretty text-xs text-muted-foreground">
            Add your filament dryers to queue spools straight from storage into them.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {dryers.map((d) => (
            <DryerCard key={d.id} dryer={d} now={now} onEdit={() => setEditing(d)} />
          ))}
        </div>
      )}

      <DryerEditorDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        dryer={editing && editing !== "new" ? editing : undefined}
      />
      <SendToDryerDialog open={sending} onClose={() => setSending(false)} />
    </section>
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
