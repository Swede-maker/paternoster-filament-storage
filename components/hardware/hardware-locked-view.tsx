"use client"

import { useMemo } from "react"
import { Lock, LockOpen, MapPin, PackageOpen } from "lucide-react"
import { useStore } from "@/lib/store"
import { formatGrams } from "@/lib/filament"
import { storedParts, partWeightGrams, type StoredPart } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import { Button } from "../ui/button"
import { PartThumb } from "./part-box"
import { GoToShelfButton } from "@/components/go-to-shelf-button"

/**
 * Every hardware slot that is locked to a specific part, in one place. A locked
 * slot keeps its box even at 0 pcs and receives new stock of that part first.
 * "Free slot" clears the lock; an empty locked box is removed so the slot
 * becomes available again.
 */
export function HardwareLockedView({ onGoHome }: { onGoHome?: () => void } = {}) {
  const { state, dispatch } = useStore()

  const locked = useMemo(
    () =>
      storedParts(state)
        .filter((e) => e.part.lockedSlot)
        .sort((a, b) => a.part.name.localeCompare(b.part.name) || a.part.count - b.part.count),
    [state],
  )
  const emptyCount = locked.filter((e) => e.part.count <= 0).length

  function free(entry: StoredPart) {
    if (entry.part.count <= 0) dispatch({ type: "REMOVE_PART", id: entry.part.id })
    else dispatch({ type: "UPSERT_PART", part: { ...entry.part, lockedSlot: false } })
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-5">
        <h1 className="text-balance text-2xl font-semibold text-foreground">Locked slots</h1>
        <p className="mt-1 text-pretty text-sm text-muted-foreground">
          Slots reserved for one part. They stay reserved when the box runs empty and are refilled first when that
          part is stored again. Lock a slot from the part&apos;s edit dialog.
        </p>
      </header>

      {locked.length > 0 && (
        <p className="mb-4 font-mono text-xs text-muted-foreground">
          {locked.length} locked · {emptyCount} waiting for stock
        </p>
      )}

      {locked.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-background/40 px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground" aria-hidden>
            <Lock className="h-6 w-6" />
          </span>
          <p className="text-sm text-muted-foreground text-pretty">
            No locked slots yet. Edit a part and tick &ldquo;Lock the slot to this part&rdquo; to reserve its slot.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {locked.map((entry) => {
            const { part, nodeName, shelfName, loc } = entry
            const empty = part.count <= 0
            return (
              <li
                key={part.id}
                className="flex flex-col gap-3 rounded-xl border border-border bg-background/50 p-3 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <PartThumb color={part.color} size={44} imageUrl={part.imageUrl} name={part.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{part.name}</span>
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                        <Lock className="h-3 w-3" /> locked
                      </span>
                      {empty && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          <PackageOpen className="h-3 w-3" /> empty
                        </span>
                      )}
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {part.category ? `${part.category} · ` : ""}
                      {empty ? "0 pcs · waiting for stock" : `${part.count} pcs · ${formatGrams(partWeightGrams(part))}`}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground/80">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {nodeName} · {shelfName} · slot {loc.slot + 1}
                    </p>
                  </div>
                  <span
                    className={cn("text-lg font-semibold tabular-nums", empty ? "text-muted-foreground" : "text-foreground")}
                    aria-hidden
                  >
                    {part.count}
                  </span>
                </div>
                <div className="flex gap-2 sm:shrink-0">
                  <GoToShelfButton nodeId={entry.nodeId} shelf={loc.shelf} onDone={onGoHome} className="flex-1 sm:flex-none" />
                  <Button variant="outline" className="flex-1 sm:flex-none" onClick={() => free(entry)}>
                    <LockOpen className="h-4 w-4" /> Free slot
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
