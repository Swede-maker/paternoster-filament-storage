"use client"

import { useMemo, useState } from "react"
import { ArrowLeft, Check, Search, X } from "lucide-react"
import { useStore } from "@/lib/store"
import { chamberRoom, getDryers } from "@/lib/dryers"
import { spoolFill } from "@/lib/filament"
import type { Spool } from "@/lib/types"
import { Dialog, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { SpoolDisc, discColor2 } from "./spool"
import { useFlow, type NodeLocation } from "./flow-controller"
import { cn } from "@/lib/utils"

interface StoredSpool {
  spool: Spool
  loc: NodeLocation
  nodeName: string
}

export interface Target {
  dryerId: string
  chamberId: string
  label: string
  room: number
}

type Step = { kind: "select" } | { kind: "assign" } | { kind: "choose"; target: Target }

/**
 * Pick spools out of storage and route each to a dryer chamber. Whenever more
 * than one spool is still waiting, the user picks which ones go to the chosen
 * dryer (up to its free room); a full dryer is greyed out. The picks are added to the
 * take-out queue so every spool is fetched first, then directed to its dryer.
 */
export function SendToDryerDialog({
  open,
  onClose,
  preselected,
  fixedTarget,
}: {
  open: boolean
  onClose: () => void
  /** Spool ids to start with; skips straight to choosing a dryer. */
  preselected?: string[]
  /** When set, every picked spool goes straight to this chamber. */
  fixedTarget?: Target
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={fixedTarget ? `Fill ${fixedTarget.label}` : "Send spools to a dryer"}
      description={
        fixedTarget
          ? "Pick spools from storage. They're added to the take-out queue and already assigned to this chamber."
          : "Choose spools from storage, then point them at your dryers."
      }
      className="max-w-lg"
    >
      {open && <SendToDryerFlow onClose={onClose} preselected={preselected} fixedTarget={fixedTarget} />}
    </Dialog>
  )
}

function SendToDryerFlow({
  onClose,
  preselected,
  fixedTarget,
}: {
  onClose: () => void
  preselected?: string[]
  fixedTarget?: Target
}) {
  const { state } = useStore()
  const { outItems, queuedForChamber, startDryerPick } = useFlow()
  const [step, setStep] = useState<Step>(preselected?.length ? { kind: "assign" } : { kind: "select" })
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string[]>(preselected ?? [])
  // spoolId → target chosen in this dialog
  const [assigned, setAssigned] = useState<Record<string, Target>>({})
  const [chosen, setChosen] = useState<string[]>([])

  const stored = useMemo<StoredSpool[]>(() => {
    const queued = new Set(outItems.map((i) => i.spool.id))
    const list: StoredSpool[] = []
    for (const n of state.nodes) {
      if ((n.system ?? "filament") !== "filament") continue
      n.slots.forEach((row, shelf) =>
        row.forEach((id, slot) => {
          const spool = id ? state.spools[id] : null
          if (spool && !queued.has(spool.id)) list.push({ spool, loc: { nodeId: n.id, shelf, slot }, nodeName: n.name })
        }),
      )
    }
    return list
  }, [state.nodes, state.spools, outItems])

  const byId = useMemo(() => new Map(stored.map((s) => [s.spool.id, s])), [stored])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return stored
    return stored.filter(({ spool, nodeName }) =>
      [spool.material, spool.colorName, spool.brand, nodeName].some((v) => v?.toLowerCase().includes(q)),
    )
  }, [stored, query])

  const unassigned = selected.filter((id) => !assigned[id])

  const targets = useMemo<Target[]>(() => {
    const localCount: Record<string, number> = {}
    for (const t of Object.values(assigned)) localCount[t.chamberId] = (localCount[t.chamberId] ?? 0) + 1
    return getDryers(state).flatMap((d) =>
      d.chambers.map((c, i) => ({
        dryerId: d.id,
        chamberId: c.id,
        label: d.kind === "chambers" ? `${d.name} · Chamber ${i + 1}` : d.name,
        room: chamberRoom(c, queuedForChamber(c.id) + (localCount[c.id] ?? 0)),
      })),
    )
  }, [state, assigned, queuedForChamber])

  function toggle(list: string[], id: string, max = Infinity) {
    if (list.includes(id)) return list.filter((x) => x !== id)
    return list.length >= max ? list : [...list, id]
  }

  function assign(ids: string[], target: Target) {
    setAssigned((prev) => {
      const next = { ...prev }
      for (const id of ids) next[id] = target
      return next
    })
  }

  function pickTarget(target: Target) {
    if (target.room <= 0) return
    if (unassigned.length === 1) {
      assign(unassigned, target)
    } else {
      setChosen([])
      setStep({ kind: "choose", target })
    }
  }

  function queue() {
    const entries = Object.entries(assigned).flatMap(([id, t]) => {
      const s = byId.get(id)
      return s ? [{ spool: s.spool, from: s.loc, dryerId: t.dryerId, chamberId: t.chamberId }] : []
    })
    startDryerPick(entries)
    onClose()
  }

  if (fixedTarget) {
    const limit = fixedTarget.room
    return (
      <>
        <DialogBody className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <label htmlFor="dryer-slot-search" className="sr-only">
              Search spools
            </label>
            <input
              id="dryer-slot-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search material, color, brand…"
              className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground"
            />
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {selected.length} / {limit} chosen
          </p>
          <SpoolList
            items={filtered}
            selected={selected}
            onToggle={(id) => setSelected((l) => toggle(l, id, limit))}
            disableUnselected={selected.length >= limit}
            empty={stored.length === 0 ? "No spools in storage." : "No spools match your search."}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={selected.length === 0}
            onClick={() => {
              const entries = selected.flatMap((id) => {
                const s = byId.get(id)
                return s
                  ? [{ spool: s.spool, from: s.loc, dryerId: fixedTarget.dryerId, chamberId: fixedTarget.chamberId }]
                  : []
              })
              startDryerPick(entries)
              onClose()
            }}
          >
            Add {selected.length} to queue
          </Button>
        </DialogFooter>
      </>
    )
  }

  if (step.kind === "select") {
    return (
      <>
        <DialogBody className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <label htmlFor="dryer-search" className="sr-only">
              Search spools
            </label>
            <input
              id="dryer-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search material, color, brand…"
              className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm text-foreground"
            />
          </div>
          <SpoolList
            items={filtered}
            selected={selected}
            onToggle={(id) => setSelected((l) => toggle(l, id))}
            empty={stored.length === 0 ? "No spools in storage." : "No spools match your search."}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={selected.length === 0} onClick={() => setStep({ kind: "assign" })}>
            Choose dryer{selected.length > 0 ? ` (${selected.length})` : ""}
          </Button>
        </DialogFooter>
      </>
    )
  }

  if (step.kind === "choose") {
    const { target } = step
    const limit = target.room
    return (
      <>
        <DialogBody className="flex flex-col gap-3">
          <p className="text-sm text-foreground">
            <span className="font-semibold">{target.label}</span> has room for{" "}
            <span className="font-semibold">
              {limit} spool{limit === 1 ? "" : "s"}
            </span>
            . Which should go there? The rest can go to another dryer.
          </p>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {chosen.length} / {limit} chosen
          </p>
          <SpoolList
            items={unassigned.map((id) => byId.get(id)).filter(Boolean) as StoredSpool[]}
            selected={chosen}
            onToggle={(id) => setChosen((l) => toggle(l, id, limit))}
            disableUnselected={chosen.length >= limit}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setStep({ kind: "assign" })}>
            Back
          </Button>
          <Button
            disabled={chosen.length === 0}
            onClick={() => {
              assign(chosen, target)
              setStep({ kind: "assign" })
            }}
          >
            Send {chosen.length} to {target.label}
          </Button>
        </DialogFooter>
      </>
    )
  }

  const assignedCount = Object.keys(assigned).length
  return (
    <>
      <DialogBody className="flex flex-col gap-4">
        <p className="text-sm text-foreground" aria-live="polite">
          {unassigned.length > 0 ? (
            <>
              <span className="font-semibold">{unassigned.length}</span> spool{unassigned.length === 1 ? "" : "s"} still
              need a dryer.
            </>
          ) : (
            "Every spool has a dryer."
          )}
        </p>

        {targets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
            Add a dryer first.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {targets.map((t) => {
              const full = t.room <= 0
              return (
                <li key={t.chamberId}>
                  <button
                    type="button"
                    disabled={full || unassigned.length === 0}
                    onClick={() => pickTarget(t)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors",
                      full
                        ? "cursor-not-allowed border-border bg-muted text-muted-foreground opacity-60"
                        : "border-border bg-card text-foreground hover:border-primary disabled:cursor-not-allowed disabled:opacity-60",
                    )}
                  >
                    <span className="truncate text-sm font-medium">{t.label}</span>
                    <span className="shrink-0 text-xs font-semibold uppercase tracking-wide">
                      {full ? "Full" : `${t.room} free`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {assignedCount > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Planned</h3>
            <ul className="flex flex-col gap-1.5">
              {Object.entries(assigned).map(([id, t]) => {
                const s = byId.get(id)
                if (!s) return null
                return (
                  <li key={id} className="flex items-center gap-2 rounded-lg bg-muted px-2 py-1.5 text-sm">
                    <SpoolDisc color={s.spool.color} color2={discColor2(s.spool)} size={22} fill={spoolFill(s.spool)} />
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {s.spool.material} · {s.spool.colorName}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">→ {t.label}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setAssigned((prev) => {
                          const next = { ...prev }
                          delete next[id]
                          return next
                        })
                      }
                      aria-label="Remove from plan"
                      className="rounded p-1 text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={() => setStep({ kind: "select" })} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" />
          Spools
        </Button>
        <Button disabled={assignedCount === 0} onClick={queue}>
          Add {assignedCount} to queue
        </Button>
      </DialogFooter>
    </>
  )
}

function SpoolList({
  items,
  selected,
  onToggle,
  disableUnselected,
  empty,
}: {
  items: StoredSpool[]
  selected: string[]
  onToggle: (id: string) => void
  disableUnselected?: boolean
  empty?: string
}) {
  if (items.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>
  return (
    <ul className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
      {items.map(({ spool, nodeName, loc }) => {
        const on = selected.includes(spool.id)
        const disabled = !on && disableUnselected
        return (
          <li key={spool.id}>
            <button
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onToggle(spool.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors disabled:opacity-50",
                on ? "border-primary bg-primary/10" : "border-border bg-card hover:border-primary/50",
              )}
            >
              <SpoolDisc color={spool.color} color2={discColor2(spool)} size={32} fill={spoolFill(spool)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {spool.material} · {spool.colorName}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {spool.brand} · {nodeName} · shelf {loc.shelf + 1}
                </span>
              </span>
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                  on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                )}
                aria-hidden="true"
              >
                {on && <Check className="h-3.5 w-3.5" />}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
