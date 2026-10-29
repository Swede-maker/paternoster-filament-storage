"use client"

import { useState } from "react"
import { Archive, Check, Pencil, Plus, Timer, Trash2, X } from "lucide-react"
import { useStore } from "@/lib/store"
import {
  chamberRoom,
  dryerCapacity,
  dryerOccupancy,
  formatDuration,
  timerRemainingMs,
  timerStatus,
  type TimerStatus,
} from "@/lib/dryers"
import type { Dryer, DryerChamber, Spool } from "@/lib/types"
import { newId, spoolFill } from "@/lib/filament"
import { NewSpoolDialog } from "./new-spool-dialog"
import { draftToSpoolFields, type SpoolDraft } from "./spool-form"
import { SpoolDisc, discColor2 } from "./spool"
import { Button } from "./ui/button"
import { useFlow } from "./flow-controller"
import { SendToDryerDialog, type Target } from "./send-to-dryer-dialog"
import { cn } from "@/lib/utils"

const TIMER_PRESETS_H = [2, 4, 6, 8, 12]

/** Status light: blue while a timer runs, green when done, nothing without a timer. */
export function TimerLight({ status, className }: { status: TimerStatus; className?: string }) {
  if (status === "none") return null
  return (
    <span className={cn("relative flex h-3 w-3 shrink-0", className)} aria-hidden="true">
      {status === "running" && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-60" />
      )}
      <span className={cn("relative inline-flex h-3 w-3 rounded-full", status === "running" ? "bg-info" : "bg-success")} />
    </span>
  )
}

export function DryerCard({ dryer, now, onEdit }: { dryer: Dryer; now: number; onEdit: () => void }) {
  const { state, dispatch } = useStore()
  const { queuedForChamber, startStoreFromDryer, inItems } = useFlow()
  const storingIds = new Set(inItems.map((i) => i.spool.id))
  const capacity = dryerCapacity(dryer)
  const occupancy = dryerOccupancy(dryer)
  const queued = dryer.chambers.reduce((n, c) => n + queuedForChamber(c.id), 0)
  const full = dryer.chambers.every((c) => chamberRoom(c, queuedForChamber(c.id)) === 0)
  const awaiting = (dryer.awaitingLoad ?? []).map((id) => state.spools[id]).filter(Boolean) as Spool[]
  const allSpools = dryer.chambers.flatMap((c) => c.spoolIds).map((id) => state.spools[id]).filter(Boolean) as Spool[]
  const [newSpoolOpen, setNewSpoolOpen] = useState(false)
  const [pickingChamber, setPickingChamber] = useState(false)
  const [chosenChamberId, setChosenChamberId] = useState<string | null>(null)
  const [slotTarget, setSlotTarget] = useState<Target | null>(null)
  const multiChamber = dryer.chambers.length > 1
  const firstFreeChamber = dryer.chambers.find((c) => chamberRoom(c, queuedForChamber(c.id)) > 0)
  const targetChamber = (chosenChamberId && dryer.chambers.find((c) => c.id === chosenChamberId)) || firstFreeChamber
  const targetChamberIndex = targetChamber ? dryer.chambers.indexOf(targetChamber) : -1

  function handleAddClick() {
    if (multiChamber) {
      setPickingChamber((v) => !v)
      return
    }
    setChosenChamberId(null)
    setNewSpoolOpen(true)
  }

  function pickChamber(chamberId: string) {
    setChosenChamberId(chamberId)
    setPickingChamber(false)
    setNewSpoolOpen(true)
  }

  function handleNewSpool(draft: SpoolDraft) {
    if (!targetChamber) return
    const spool: Spool = { id: newId("spool"), createdAt: Date.now(), ...draftToSpoolFields(draft) }
    dispatch({ type: "UPSERT_SPOOL", spool })
    dispatch({ type: "DRYER_ADD_SPOOL", dryerId: dryer.id, chamberId: targetChamber.id, spoolId: spool.id })
  }

  return (
    <article
      className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-4"
      aria-label={dryer.name}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold text-foreground">{dryer.name}</h3>
            {full && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                Full
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {occupancy} / {capacity} spools
            {queued > 0 ? ` · ${queued} queued` : ""}
            {dryer.kind === "chambers" ? ` · ${dryer.chambers.length} chambers` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            onClick={handleAddClick}
            disabled={!firstFreeChamber}
            aria-expanded={multiChamber ? pickingChamber : undefined}
            aria-label={`Set up a new spool in ${dryer.name}`}
            title={targetChamber ? `Set up a new spool in ${dryer.name}` : `${dryer.name} is full`}
            className="h-8 w-8 rounded-lg"
          >
            <Plus className="h-5 w-5" strokeWidth={2.5} />
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} aria-label={`Edit ${dryer.name}`} className="h-8 w-8 p-0">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={occupancy > 0}
            onClick={() => dispatch({ type: "REMOVE_DRYER", id: dryer.id })}
            aria-label={`Delete ${dryer.name}`}
            title={occupancy > 0 ? "Empty the dryer before deleting it" : undefined}
            className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {pickingChamber && multiChamber && (
        <div className="flex flex-col gap-2 rounded-xl border border-primary/40 bg-primary/10 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">Which chamber should the new spool go in?</p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPickingChamber(false)}
              aria-label="Cancel"
              className="h-7 w-7 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {dryer.chambers.map((c, i) => {
              const room = chamberRoom(c, queuedForChamber(c.id))
              return (
                <Button
                  key={c.id}
                  size="sm"
                  variant="outline"
                  disabled={room === 0}
                  onClick={() => pickChamber(c.id)}
                  className="h-auto flex-col items-start gap-0 px-3 py-1.5"
                >
                  <span className="text-sm font-medium">Chamber {i + 1}</span>
                  <span className="text-[11px] text-muted-foreground">{room === 0 ? "Full" : `${room} free`}</span>
                </Button>
              )
            })}
          </div>
        </div>
      )}

      {awaiting.length > 0 && (
        <div className="flex flex-col gap-2 rounded-xl border border-info/40 bg-info/10 p-3">
          <p className="text-sm font-medium text-foreground">
            Put {awaiting.length} spool{awaiting.length === 1 ? "" : "s"} into {dryer.name}
          </p>
          <ul className="flex flex-wrap gap-2">
            {awaiting.map((s) => (
              <li key={s.id} className="flex items-center gap-1.5 rounded-lg bg-card px-2 py-1 text-xs text-foreground">
                <SpoolDisc color={s.color} color2={discColor2(s)} size={18} fill={spoolFill(s)} />
                {s.material} · {s.colorName}
                {dryer.kind === "chambers" && (
                  <span className="text-muted-foreground">
                    {" "}
                    → Ch {dryer.chambers.findIndex((c) => c.spoolIds.includes(s.id)) + 1}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            onClick={() => dispatch({ type: "DRYER_CONFIRM_LOADED", dryerId: dryer.id })}
            className="gap-1.5 self-start"
          >
            <Check className="h-4 w-4" />
            They&apos;re in
          </Button>
        </div>
      )}

      <div className={cn("grid gap-3", dryer.chambers.length > 1 && "sm:grid-cols-2")}>
        {dryer.chambers.map((c, i) => (
          <ChamberPanel
            key={c.id}
            dryer={dryer}
            chamber={c}
            label={dryer.kind === "chambers" ? `Chamber ${i + 1}` : undefined}
            now={now}
            queued={queuedForChamber(c.id)}
            storingIds={storingIds}
            onStore={(spools) => startStoreFromDryer(spools)}
            onFillSlot={() =>
              setSlotTarget({
                dryerId: dryer.id,
                chamberId: c.id,
                label: dryer.kind === "chambers" ? `${dryer.name} · Chamber ${i + 1}` : dryer.name,
                room: chamberRoom(c, queuedForChamber(c.id)),
              })
            }
          />
        ))}
      </div>

      {allSpools.some((s) => storingIds.has(s.id)) && (
        <p className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
          <Archive className="h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            {allSpools.filter((s) => storingIds.has(s.id)).length} queued back to storage. Go to the{" "}
            <span className="font-semibold">Home</span> tab and press Start.
          </span>
        </p>
      )}

      {allSpools.some((s) => !storingIds.has(s.id)) && dryer.chambers.length > 1 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => startStoreFromDryer(allSpools.filter((s) => !storingIds.has(s.id)))}
          className="gap-1.5 self-start"
        >
          <Archive className="h-4 w-4" />
          Queue all back to storage
        </Button>
      )}

      <NewSpoolDialog
        open={newSpoolOpen}
        targetLabel={
          multiChamber && targetChamberIndex >= 0
            ? `${dryer.name} · Chamber ${targetChamberIndex + 1}`
            : dryer.name
        }
        confirmLabel={`Put in ${dryer.name}`}
        onClose={() => {
          setNewSpoolOpen(false)
          setChosenChamberId(null)
        }}
        onConfirm={handleNewSpool}
      />

      <SendToDryerDialog
        open={slotTarget !== null}
        onClose={() => setSlotTarget(null)}
        fixedTarget={slotTarget ?? undefined}
      />
    </article>
  )
}

function ChamberPanel({
  dryer,
  chamber,
  label,
  now,
  queued,
  storingIds,
  onStore,
  onFillSlot,
}: {
  dryer: Dryer
  chamber: DryerChamber
  label?: string
  now: number
  queued: number
  storingIds: Set<string>
  onStore: (spools: Spool[]) => void
  onFillSlot: () => void
}) {
  const { state, dispatch } = useStore()
  const [settingTimer, setSettingTimer] = useState(false)
  const [customHours, setCustomHours] = useState("")
  const status = timerStatus(chamber.timer, now)
  const spools = chamber.spoolIds.map((id) => state.spools[id]).filter(Boolean) as Spool[]
  const empty = Math.max(0, chamber.capacity - spools.length - queued)
  const unqueued = spools.filter((s) => !storingIds.has(s.id))

  function setTimer(minutes: number | null) {
    dispatch({ type: "SET_DRYER_TIMER", dryerId: dryer.id, chamberId: chamber.id, durationMin: minutes })
    setSettingTimer(false)
    setCustomHours("")
  }

  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-3",
        status === "running" && "border-info/50",
        status === "done" && "border-success/60",
        status === "none" && "border-border",
      )}
      aria-label={label ?? `${dryer.name} chamber`}
    >
  <div className="flex flex-col gap-0.5">
  <div className="flex min-w-0 items-center gap-2">
  <TimerLight status={status} />
  <span className="break-words text-sm font-medium leading-snug text-foreground">
  {label ?? "Chamber"}
  </span>
  </div>
  <span
  className={cn(
  "whitespace-nowrap text-xs font-medium",
            status === "running" ? "text-info" : status === "done" ? "text-success" : "text-muted-foreground",
          )}
        >
          {status === "running" && chamber.timer
            ? `${formatDuration(timerRemainingMs(chamber.timer, now))} left`
            : status === "done"
              ? "Done drying"
              : "No timer"}
        </span>
      </div>

      <ul className="flex flex-wrap gap-2" aria-label="Spools in chamber">
        {spools.map((s) => (
          <li
            key={s.id}
            title={`${s.brand} ${s.material} · ${s.colorName}${storingIds.has(s.id) ? " · queued for storage" : ""}`}
            className={cn("relative", storingIds.has(s.id) && "opacity-50")}
          >
            <SpoolDisc color={s.color} color2={discColor2(s)} size={36} fill={spoolFill(s)} />
            {storingIds.has(s.id) && (
              <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-warning text-background">
                <Archive className="h-2.5 w-2.5" />
              </span>
            )}
            <span className="sr-only">
              {s.material} {s.colorName}
              {storingIds.has(s.id) ? " (queued for storage)" : ""}
            </span>
          </li>
        ))}
        {Array.from({ length: queued }).map((_, i) => (
          <li
            key={`q${i}`}
            className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-dashed border-info/60 text-[10px] font-semibold text-info"
          >
            Q
            <span className="sr-only">Queued spool</span>
          </li>
        ))}
        {Array.from({ length: empty }).map((_, i) => (
          <li key={`e${i}`}>
  <button
  type="button"
  onClick={onFillSlot}
  aria-label={`Add a spool from storage to ${label ?? dryer.name}`}
  title="Add a spool from storage"
  className="group flex h-9 w-9 items-center justify-center rounded-full border-2 border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary focus-visible:border-primary focus-visible:outline-none"
  >
  <Plus className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
  </button>
  </li>
        ))}
      </ul>

      {settingTimer ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-1.5">
            {TIMER_PRESETS_H.map((h) => (
              <Button key={h} size="sm" variant="outline" onClick={() => setTimer(h * 60)} className="h-8 px-2.5 text-xs">
                {h} h
              </Button>
            ))}
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const h = Number.parseFloat(customHours)
              if (h > 0) setTimer(Math.round(h * 60))
            }}
          >
            <label htmlFor={`timer-${chamber.id}`} className="sr-only">
              Custom hours
            </label>
            <input
              id={`timer-${chamber.id}`}
              type="number"
              inputMode="decimal"
              min={0.25}
              step={0.25}
              placeholder="Hours"
              value={customHours}
              onChange={(e) => setCustomHours(e.target.value)}
              className="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm text-foreground"
            />
            <Button size="sm" type="submit" className="h-8 px-2.5 text-xs">
              Start
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setSettingTimer(false)}
              aria-label="Close timer options"
              className="h-8 w-8 p-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </form>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setSettingTimer(true)} className="h-8 gap-1.5 px-2.5 text-xs">
            <Timer className="h-3.5 w-3.5" />
            {status === "none" ? "Set timer" : "New timer"}
          </Button>
          {status !== "none" && (
            <Button size="sm" variant="ghost" onClick={() => setTimer(null)} className="h-8 px-2.5 text-xs">
              {status === "done" ? "Clear" : "Stop timer"}
            </Button>
          )}
          {unqueued.length > 0 ? (
            <Button size="sm" variant="outline" onClick={() => onStore(unqueued)} className="h-8 gap-1.5 px-2.5 text-xs">
              <Archive className="h-3.5 w-3.5" />
              Back to storage
            </Button>
          ) : spools.length > 0 ? (
            <span className="flex h-8 items-center gap-1.5 px-2.5 text-xs font-medium text-warning">
              <Archive className="h-3.5 w-3.5" />
              Queued for storage
            </span>
          ) : null}
        </div>
      )}
    </section>
  )
}
