"use client"

import { useMemo, useState } from "react"
import {
  History as HistoryIcon,
  ArrowDownToLine,
  ArrowUpFromLine,
  PackageCheck,
  Trash2,
  Droplets,
  RotateCcw,
  X,
  AlertTriangle,
  Scale,
} from "lucide-react"
import { useStore } from "@/lib/store"
import { reminderDueAt, isReminderDue } from "@/lib/selectors"
import type { FilamentUsageArchive, HistoryEvent, HistoryEventKind, Spool } from "@/lib/types"
import { SpoolDisc } from "./spool"
import { spoolFill, formatGrams } from "@/lib/filament"
import { lifetimeGrams } from "./filament-used-card"
import { Button } from "./ui/button"
import { cn } from "@/lib/utils"

const DAY_MS = 86_400_000

/** Relative "time ago" label, coarse but readable for a log. */
function timeAgo(then: number, now: number): string {
  const diff = Math.max(0, now - then)
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** Absolute timestamp for the tooltip / secondary line. */
function fullTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

const KIND_META: Record<
  HistoryEventKind,
  { label: string; icon: typeof ArrowDownToLine; tone: string }
> = {
  load: { label: "Loaded", icon: ArrowDownToLine, tone: "text-primary" },
  unload: { label: "Unloaded", icon: ArrowUpFromLine, tone: "text-muted-foreground" },
  placed: { label: "Placed", icon: PackageCheck, tone: "text-success" },
  removed: { label: "Removed", icon: Trash2, tone: "text-destructive" },
  "dry-set": { label: "Dry reminder set", icon: Droplets, tone: "text-warning" },
  "dry-reset": { label: "Dry reminder reset", icon: RotateCcw, tone: "text-warning" },
  "dry-cleared": { label: "Dry reminder cleared", icon: X, tone: "text-muted-foreground" },
}

type FilterKey = "all" | "moves" | "dry"

/**
 * Filament history + dry-reminder alerts. The top section calls out spools that
 * are due to be dried (with reset/clear controls); below it is the full activity
 * log of every load, unload, placement, and removal.
 */
export function HistoryView() {
  const { state, dispatch } = useStore()
  const now = Date.now()
  const [filter, setFilter] = useState<FilterKey>("all")
  const [confirmingReset, setConfirmingReset] = useState(false)

  const spools = state.spools
  const usage = state.usage

  // Reminders split into overdue ("due to dry now") and still-scheduled.
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

  const events = state.history ?? []
  const filtered = useMemo(() => {
    if (filter === "moves") return events.filter((e) => ["load", "unload", "placed", "removed"].includes(e.kind))
    if (filter === "dry") return events.filter((e) => e.kind.startsWith("dry-"))
    return events
  }, [events, filter])

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-balance text-2xl font-semibold text-foreground">History</h1>
          <p className="mt-1 text-pretty text-sm text-muted-foreground">
            Every load, unload, and placement of your filament — plus reminders to dry spools before they go brittle.
          </p>
        </div>
        {/* Reset the activity log. Two-step confirm since it can't be undone.
            Only clears the log — spools and dry reminders are untouched. */}
        {confirmingReset ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">Clear all history?</span>
            <Button size="sm" variant="destructive" onClick={resetHistory}>
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingReset(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5 text-muted-foreground"
            onClick={() => setConfirmingReset(true)}
            disabled={events.length === 0}
          >
            <Trash2 className="h-4 w-4" />
            Reset history
          </Button>
        )}
      </header>

      {/* Filament usage totals — the lifetime record plus every archived tally
          saved when the "Total filament used" counter was reset. */}
      <FilamentUsageSection archived={usage.archived} currentG={usage.currentG} since={usage.since} />

      {/* Dry alerts */}
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
        <section aria-label="Scheduled dry reminders" className="mb-6">
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Scheduled reminders ({upcoming.length})</h2>
          <ul className="flex flex-col gap-2">
            {upcoming.map((s) => (
              <ReminderRow key={s.id} spool={s} now={now} onReset={reset} onClear={clear} />
            ))}
          </ul>
        </section>
      )}

      {/* Activity log */}
      <section aria-label="Filament activity log">
        <div className="mb-3 flex items-center gap-2">
          {(
            [
              { k: "all", label: "All" },
              { k: "moves", label: "Movements" },
              { k: "dry", label: "Dry reminders" },
            ] as { k: FilterKey; label: string }[]
          ).map(({ k, label }) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === k
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
            <HistoryIcon className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">No activity yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Load, unload, or place a spool and it&apos;ll show up here.
              </p>
            </div>
          </div>
        ) : (
          <ol className="flex flex-col">
            {filtered.map((e) => (
              <EventRow key={e.id} event={e} now={now} />
            ))}
          </ol>
        )}
      </section>
    </div>
  )

  function reset(spoolId: string) {
    dispatch({ type: "RESET_DRY_REMINDER", spoolId })
  }
  function clear(spoolId: string) {
    dispatch({ type: "CLEAR_DRY_REMINDER", spoolId })
  }
  function resetHistory() {
    dispatch({ type: "CLEAR_HISTORY" })
    setConfirmingReset(false)
  }
}

/**
 * Filament-usage totals for the History tab: a headline lifetime figure plus the
 * list of archived tallies saved each time the "Total filament used" counter was
 * reset, so resetting never loses the record.
 */
function FilamentUsageSection({
  archived,
  currentG,
  since,
}: {
  archived: FilamentUsageArchive[]
  currentG: number
  since: number
}) {
  const lifetime = lifetimeGrams({ currentG, archived })
  // Nothing tracked yet and never reset — keep the tab uncluttered.
  if (lifetime <= 0 && archived.length === 0) return null

  return (
    <section aria-label="Filament used" className="mb-6">
      <div className="mb-2 flex items-center gap-2">
        <Scale className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Filament used</h2>
      </div>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
          <div>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Lifetime total</span>
            <p className="font-mono text-2xl font-bold text-foreground">{formatGrams(lifetime)}</p>
          </div>
          <div className="text-right">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Current tally</span>
            <p className="font-mono text-lg font-semibold text-primary">{formatGrams(currentG)}</p>
            <p className="text-xs text-muted-foreground">since {fullTime(since)}</p>
          </div>
        </div>

        {archived.length > 0 && (
          <ol className="mt-3 flex flex-col border-t border-border/60 pt-2">
            {archived.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 border-b border-border/40 py-2 last:border-b-0">
                <div className="min-w-0">
                  <p className="truncate text-sm text-foreground">
                    {new Date(a.from).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    {" – "}
                    {new Date(a.to).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </p>
                  <p className="text-xs text-muted-foreground">Archived tally</p>
                </div>
                <span className="shrink-0 font-mono text-sm font-semibold text-foreground">{formatGrams(a.grams)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
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
      <SpoolDisc color={spool.color} size={40} fill={spoolFill(spool)} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {spool.material} · {spool.colorName}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {spool.brand} · {when}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onReset(spool.id)} className="h-8 gap-1 px-2 text-xs">
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
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

/** A single activity-log entry. */
function EventRow({ event, now }: { event: HistoryEvent; now: number }) {
  const meta = KIND_META[event.kind]
  const Icon = meta.icon

  // Where/what context line, tailored to the event kind.
  let context = ""
  if (event.kind === "load" || event.kind === "unload") {
    context = [event.printerName, event.slotLabel].filter(Boolean).join(" · ")
  } else if (event.kind === "placed") {
    context = [event.nodeName, event.locationLabel].filter(Boolean).join(" · ")
  } else if (event.kind === "dry-set" || event.kind === "dry-reset") {
    context = event.days != null ? `Dry in ${event.days} day${event.days === 1 ? "" : "s"}` : ""
  }

  return (
    <li className="flex items-center gap-3 border-b border-border/60 py-3 last:border-b-0">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary">
        <Icon className={cn("h-4 w-4", meta.tone)} />
      </span>
      <span
        className="h-8 w-8 shrink-0 rounded-full border border-border"
        style={{ background: event.color }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          <span className="font-medium">{meta.label}</span>
          <span className="text-muted-foreground">
            {" · "}
            {event.material} {event.colorName}
          </span>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {context ? `${context} · ` : ""}
          {event.brand}
        </p>
      </div>
      <time
        dateTime={new Date(event.at).toISOString()}
        title={fullTime(event.at)}
        className="shrink-0 text-xs text-muted-foreground"
      >
        {timeAgo(event.at, now)}
      </time>
    </li>
  )
}
