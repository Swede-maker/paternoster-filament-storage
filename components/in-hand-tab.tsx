"use client"

import { useMemo, useState } from "react"
import { Archive, Flame, Hand, Loader2 } from "lucide-react"
import { useStore } from "@/lib/store"
import { locateSpool } from "@/lib/tags"
import { findSpoolInDryer, getDryers } from "@/lib/dryers"
import type { AppState, Spool } from "@/lib/types"
import { useFlow } from "@/components/flow-controller"
import { SpoolDisc } from "@/components/spool"
import { Dialog, DialogFooter } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/**
 * Spools physically in the user's hand: taken out of storage with no printer
 * target and not placed anywhere since, plus spools picked for a dryer that
 * haven't been confirmed as loaded ("They're in") yet.
 */
export function getSpoolsInHand(state: AppState): Spool[] {
  const awaitingDryer = new Set(getDryers(state).flatMap((d) => d.awaitingLoad ?? []))
  return Object.values(state.spools)
    .filter((s) => {
      if (awaitingDryer.has(s.id)) return true
      if (!s.inHandSince) return false
      return locateSpool(state, s.id).kind === "none" && !findSpoolInDryer(state, s.id)
    })
    .sort((a, b) => (b.inHandSince ?? 0) - (a.inHandSince ?? 0))
}

type Mission = "dryer" | "none"

export function InHandTab({ onQueued, onContinueDryer }: { onQueued: () => void; onContinueDryer: () => void }) {
  const { state } = useStore()
  const flow = useFlow()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const spools = useMemo(() => getSpoolsInHand(state), [state])
  const count = spools.length

  const queuedIds = useMemo(() => new Set(flow.inItems.map((i) => i.spool.id)), [flow.inItems])
  const movingIds = useMemo(
    () => new Set((state.job?.mode === "store" ? state.job.items : []).filter((i) => !i.done).map((i) => i.spoolId)),
    [state.job],
  )
  const dryerFor = useMemo(() => {
    const map = new Map<string, string>()
    for (const d of getDryers(state)) for (const id of d.awaitingLoad ?? []) map.set(id, d.name)
    return map
  }, [state])

  const actionable = spools.filter((s) => !queuedIds.has(s.id) && !movingIds.has(s.id))

  const missionOf = (id: string): Mission => (dryerFor.has(id) ? "dryer" : "none")

  const selectedSpools = actionable.filter((s) => selected.has(s.id))
  const lockedMission = selectedSpools.length > 0 ? missionOf(selectedSpools[0].id) : null
  const compatible = lockedMission ? actionable.filter((s) => missionOf(s.id) === lockedMission) : actionable
  const compatibleIds = new Set(compatible.map((s) => s.id))
  const selectedForDryer = lockedMission === "dryer" ? selectedSpools : []
  const allSelected = lockedMission !== null && selectedSpools.length === compatible.length

  function toggle(id: string) {
    if (!compatibleIds.has(id)) return
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function close() {
    setOpen(false)
    setSelected(new Set())
  }

  function queueStore(list: Spool[]) {
    if (list.length === 0) return
    flow.startStoreFromDryer(list)
    close()
    onQueued()
  }

  function continueMission() {
    close()
    onContinueDryer()
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Spools without storage location (in my hand): ${count}`}
        className={cn(
          "flex min-w-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
          count > 0
            ? "border-primary/50 bg-primary/10 text-foreground hover:bg-primary/20"
            : "border-border bg-card/60 text-muted-foreground hover:text-foreground",
        )}
      >
        <Hand className="h-4 w-4 shrink-0" aria-hidden />
        <span className="hidden truncate lg:inline">Spools without storage location (In my hand)</span>
        <span className="truncate lg:hidden">In my hand</span>
        <span
          className={cn(
            "flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums",
            count > 0 ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
          )}
        >
          {count}
        </span>
      </button>

      <Dialog
        open={open}
        onClose={close}
        title="Spools without storage location"
        description="Taken out of storage but not yet placed anywhere. They stay pending here until they're stored, loaded or put in a dryer."
      >
        {count === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Hand className="h-8 w-8 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">Nothing in your hand</p>
            <p className="text-sm leading-relaxed text-muted-foreground">Every spool has a home right now.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
          {actionable.length > 1 &&
            (lockedMission ? (
              <label className="flex cursor-pointer items-center gap-3 px-3 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(compatibleIds))}
                  className="h-4 w-4 cursor-pointer accent-primary"
                />
                <span>
                  {selectedSpools.length} selected
                  <span className="text-muted-foreground/70">
                    {" · "}
                    {lockedMission === "dryer" ? "Heading to dryer" : "No mission"}
                    {!allSelected && compatible.length > selectedSpools.length && ` · select all ${compatible.length}`}
                  </span>
                </span>
              </label>
            ) : (
              <p className="px-3 text-sm leading-relaxed text-muted-foreground">
                Select spools that share the same mission.
              </p>
            ))}
          <ul className="flex flex-col gap-2">
            {spools.map((s) => {
              const queued = queuedIds.has(s.id)
              const moving = movingIds.has(s.id)
              const dryer = dryerFor.get(s.id)
              const selectable = compatibleIds.has(s.id)
              const lockedOut = lockedMission !== null && actionable.includes(s) && !selectable
              const isSelected = selected.has(s.id)
              return (
                <li
                  key={s.id}
                  aria-disabled={lockedOut || undefined}
                  title={lockedOut ? "Different mission than your current selection" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border bg-card p-3 transition-[opacity,colors]",
                    isSelected ? "border-primary/60 bg-primary/5" : "border-border",
                    lockedOut && "opacity-40 grayscale",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={!selectable}
                    onChange={() => toggle(s.id)}
                    aria-label={`Select ${s.material} ${s.colorName}`}
                    className="h-4 w-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
                  />
                  <SpoolDisc color={s.color} color2={s.dualColor ? s.color2 : undefined} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {s.material} · {s.colorName}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[s.brand, `${Math.round(s.grams)} g`, dryer ? `Heading to ${dryer}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  {moving ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      Storing
                    </span>
                  ) : queued ? (
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      Queued
                    </span>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                        Pending
                      </span>
                      <button
                        type="button"
                        onClick={() => queueStore([s])}
                        disabled={lockedOut}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-secondary"
                      >
                        <Archive className="h-3.5 w-3.5" aria-hidden />
                        Store
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
          </div>
        )}
        {selectedSpools.length > 0 ? (
          <DialogFooter className="flex-wrap">
            {selectedForDryer.length > 0 && (
              <button
                type="button"
                onClick={continueMission}
                className="flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-secondary"
              >
                <Flame className="h-4 w-4" aria-hidden />
                Continue mission
                {selectedForDryer.length > 1 && (
                  <span className="text-muted-foreground">({selectedForDryer.length} to dryer)</span>
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => queueStore(selectedSpools)}
              className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            >
              <Archive className="h-4 w-4" aria-hidden />
              Store {selectedSpools.length} selected
            </button>
          </DialogFooter>
        ) : (
          actionable.length > 1 && (
            <DialogFooter>
              <button
                type="button"
                onClick={() => queueStore(actionable)}
                className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                <Archive className="h-4 w-4" aria-hidden />
                Queue all {actionable.length} back to storage
              </button>
            </DialogFooter>
          )
        )}
      </Dialog>
    </>
  )
}
