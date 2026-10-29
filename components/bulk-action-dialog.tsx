"use client"

import { useEffect, useMemo, useState } from "react"
import {
  ArrowLeft,
  ArrowLeftRight,
  Boxes,
  Droplets,
  Flame,
  HandMetal,
  ListChecks,
  MapPin,
  Package,
  Pencil,
  Printer as PrinterIcon,
  Save,
  Server,
  Trash2,
} from "lucide-react"
import { useStore } from "@/lib/store"
import { nodeSystem } from "@/lib/selectors"
import { nodeFreeSlots } from "@/lib/balance"
import { spoolFill } from "@/lib/filament"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { SpoolDisc, discColor2 } from "./spool"
import { SpoolForm, spoolToDraft, type SpoolDraft } from "./spool-form"
import { useFlow, type NodeLocation } from "./flow-controller"
import { SendToDryerDialog } from "./send-to-dryer-dialog"
import { getDryers } from "@/lib/dryers"
import type { Spool } from "@/lib/types"

export interface BulkEntry {
  spool: Spool
  loc: NodeLocation
}

type View = "actions" | "move" | "dry" | "edit" | "dryer"

/** Fields the bulk editor may copy onto every marked spool. Identity fields
 *  (barcode, tags) stay per spool. */
const BULK_EDITABLE: (keyof SpoolDraft)[] = [
  "material",
  "brand",
  "color",
  "color2",
  "dualColor",
  "colorName",
  "grams",
  "capacity",
  "nozzleTemp",
  "containerId",
  "density",
  "diameter",
]

/**
 * Action sheet for several marked spools at once. Mirrors the single-spool hub,
 * minus "Load onto a printer" (that needs one spool → one printer slot). Every
 * action is applied to all marked spools; take-out and move feed the existing
 * queues unchanged.
 */
export function BulkActionDialog({
  entries,
  onTakeOut,
  onMove,
  onClose,
}: {
  entries: BulkEntry[] | null
  onTakeOut: (entries: BulkEntry[]) => void
  onMove: (entries: BulkEntry[], destNodeId: string) => void
  onClose: () => void
}) {
  const { state, dispatch } = useStore()
  const { outItems } = useFlow()
  const [view, setView] = useState<View>("actions")
  const [dryDays, setDryDays] = useState(30)
  const [initialDraft, setInitialDraft] = useState<SpoolDraft | null>(null)
  const [draft, setDraft] = useState<SpoolDraft | null>(null)

  const open = entries !== null && entries.length > 0
  const firstId = entries?.[0]?.spool.id

  useEffect(() => {
    if (!entries || entries.length === 0) return
    setView("actions")
    setDryDays(entries[0].spool.dryReminder?.days ?? 30)
    const d = spoolToDraft(entries[0].spool)
    setInitialDraft(d)
    setDraft(d)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId, entries?.length])

  const moveTargets = useMemo(() => {
    if (!entries) return []
    return state.nodes.filter((n) => {
      if (nodeSystem(n) !== "filament") return false
      const incoming = entries.filter((e) => e.loc.nodeId !== n.id).length
      if (incoming === 0) return false
      return (n.type ?? "paternoster") === "library" || nodeFreeSlots(n) >= incoming
    })
  }, [entries, state.nodes])

  if (!open || !entries) return null

  const count = entries.length
  const title = `${count} spools selected`
  const anyReminder = entries.some((e) => e.spool.dryReminder)
  const editMismatch = editMismatchReasons(entries)
  const canEditAll = editMismatch.length === 0
  const hasDryers = getDryers(state).length > 0
  const queuedIds = new Set(outItems.map((i) => i.spool.id))
  const dryable = entries.filter((e) => !queuedIds.has(e.spool.id)).map((e) => e.spool.id)

  if (view === "dryer") {
    return (
      <SendToDryerDialog
        open
        preselected={dryable}
        onClose={() => {
          setView("actions")
          onClose()
        }}
      />
    )
  }

  function setReminders() {
    for (const e of entries!) dispatch({ type: "SET_DRY_REMINDER", spoolId: e.spool.id, days: dryDays })
    onClose()
  }

  function clearReminders() {
    for (const e of entries!) {
      if (e.spool.dryReminder) dispatch({ type: "CLEAR_DRY_REMINDER", spoolId: e.spool.id })
    }
    onClose()
  }

  function saveEdit() {
    if (!draft || !initialDraft) return
    const changes: Partial<SpoolDraft> = {}
    for (const key of BULK_EDITABLE) {
      if (draft[key] !== initialDraft[key]) (changes as Record<string, unknown>)[key] = draft[key]
    }
    if (Object.keys(changes).length > 0) {
      for (const e of entries!) dispatch({ type: "UPDATE_SPOOL", id: e.spool.id, changes })
    }
    onClose()
  }

  function deleteAll() {
    if (!confirm(`Delete ${count} spools? This cannot be undone.`)) return
    for (const e of entries!) dispatch({ type: "DELETE_SPOOL", id: e.spool.id })
    onClose()
  }

  if (view === "move") {
    return (
      <Dialog open onClose={onClose}>
        <DialogHeader icon={<ArrowLeftRight className="h-5 w-5" />} title="Move to which unit?" description={title} />
        <DialogBody className="space-y-3">
          {moveTargets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other unit has {count} free slots. Free up space or select fewer spools.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {moveTargets.map((n) => {
                const nType = n.type ?? "paternoster"
                const isLibrary = nType === "library"
                const isShelf = nType === "shelf"
                const Icon = isLibrary ? Boxes : isShelf ? Package : Server
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => onMove(entries, n.id)}
                    className="flex items-start gap-2 rounded-xl border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/60"
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{n.name}</span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        {n.area && (
                          <>
                            <MapPin className="h-3 w-3" />
                            {n.area}
                            <span aria-hidden>·</span>
                          </>
                        )}
                        {isLibrary ? "Library" : isShelf ? "Shelf" : "Paternoster"}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {isLibrary ? "unlimited" : `${nodeFreeSlots(n)} free`}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setView("actions")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  if (view === "dry") {
    return (
      <Dialog open onClose={onClose}>
        <DialogHeader icon={<Droplets className="h-5 w-5" />} title="Dry reminder" description={title} />
        <DialogBody className="space-y-5">
          <SelectedStrip entries={entries} />
          <div>
            <label htmlFor="bulk-dry-days" className="mb-1.5 block text-sm font-medium">
              Remind me to dry these after
            </label>
            <div className="flex items-center gap-3">
              <input
                id="bulk-dry-days"
                type="range"
                min={1}
                max={180}
                value={dryDays}
                onChange={(e) => setDryDays(Number(e.target.value))}
                className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary"
              />
              <div className="flex items-baseline gap-1 tabular-nums">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={dryDays}
                  aria-label="Days"
                  onChange={(e) => setDryDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
                  className="w-16 rounded-lg border border-input bg-background px-2 py-1 text-right text-sm"
                />
                <span className="text-sm text-muted-foreground">days</span>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Applies to all {count} spools and restarts each countdown from today.
            </p>
          </div>
        </DialogBody>
        <DialogFooter className="flex-wrap">
          <Button variant="ghost" onClick={() => setView("actions")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          {anyReminder && (
            <Button variant="destructive" onClick={clearReminders}>
              <Trash2 className="h-4 w-4" /> Delete reminders
            </Button>
          )}
          <Button onClick={setReminders}>
            <Droplets className="h-4 w-4" /> Set for all
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  if (view === "edit" && draft && canEditAll) {
    return (
      <Dialog open onClose={onClose}>
        <DialogHeader icon={<Pencil className="h-5 w-5" />} title={`Edit ${count} spools`} description="Only the fields you change are copied to every marked spool." />
        <DialogBody>
          <SpoolForm value={draft} onChange={setDraft} showProfiles />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setView("actions")}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
          <Button onClick={saveEdit}>
            <Save className="h-4 w-4" /> Save for all
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader icon={<ListChecks className="h-5 w-5" />} title="What do you want to do?" description={title} />
      <DialogBody className="space-y-5">
        <SelectedStrip entries={entries} />
        <div className="flex flex-col gap-2">
          <Button
  size="lg"
  variant="secondary"
  className="w-full justify-start border border-dashed border-border bg-transparent text-muted-foreground disabled:opacity-60"
  disabled
  aria-describedby="bulk-load-hint"
  >
            <PrinterIcon className="h-5 w-5" /> Load onto a printer
          </Button>
          <p id="bulk-load-hint" className="-mt-1 px-1 text-xs text-muted-foreground">
  Only possible with one spool selected.
  </p>
          <Button size="lg" variant="secondary" className="w-full justify-start" onClick={() => onTakeOut(entries)}>
            <HandMetal className="h-5 w-5" /> Take all out of storage
          </Button>
          {hasDryers && (
            <>
              <Button
                size="lg"
                variant="secondary"
                className="w-full justify-start"
                disabled={dryable.length === 0}
                onClick={() => setView("dryer")}
              >
                <Flame className="h-5 w-5" />
                <span className="flex-1 text-left">Send all to dryers</span>
              </Button>
              {dryable.length < count && (
                <p className="-mt-1 px-1 text-xs text-muted-foreground">
                  {dryable.length === 0
                    ? "All these spools are already in the queue."
                    : `${count - dryable.length} already in the queue — only ${dryable.length} will be sent.`}
                </p>
              )}
            </>
          )}
          <Button size="lg" variant="secondary" className="w-full justify-start" onClick={() => setView("move")}>
            <ArrowLeftRight className="h-5 w-5" /> Move all to another unit
          </Button>
          <Button size="lg" variant="secondary" className="w-full justify-start" onClick={() => setView("dry")}>
            <Droplets className="h-5 w-5" /> Set dry reminder for all
          </Button>
          <div className="mt-1 flex gap-2">
            <Button
              variant="outline"
              className="flex-1 disabled:border-dashed disabled:text-muted-foreground disabled:opacity-60"
              onClick={() => setView("edit")}
              disabled={!canEditAll}
              aria-describedby={canEditAll ? undefined : "bulk-edit-hint"}
            >
              <Pencil className="h-4 w-4" /> Edit all
            </Button>
            <Button variant="destructive" className="flex-1" onClick={deleteAll}>
              <Trash2 className="h-4 w-4" /> Delete all
            </Button>
          </div>
          {!canEditAll && (
            <p id="bulk-edit-hint" className="-mt-1 px-1 text-xs leading-relaxed text-muted-foreground">
              Edit all needs the same material, color and weight. These spools differ in{" "}
              {formatReasons(editMismatch)}.
            </p>
          )}
        </div>
      </DialogBody>
    </Dialog>
  )
}

type MismatchReason = "material" | "color" | "weight"

/** Weight is compared as shown on the cards (whole grams), so a 0.4 g scale
 *  wobble doesn't block editing two spools that both read "1.00 kg". */
function editMismatchReasons(entries: BulkEntry[]): MismatchReason[] {
  const [first, ...rest] = entries.map((e) => e.spool)
  if (!first) return []
  const colorKey = (s: Spool) =>
    [s.color.toLowerCase(), s.dualColor ? (s.color2 ?? "").toLowerCase() : ""].join("|")
  const reasons: MismatchReason[] = []
  if (rest.some((s) => s.material.trim().toLowerCase() !== first.material.trim().toLowerCase())) reasons.push("material")
  if (rest.some((s) => colorKey(s) !== colorKey(first))) reasons.push("color")
  if (rest.some((s) => Math.round(s.grams) !== Math.round(first.grams))) reasons.push("weight")
  return reasons
}

function formatReasons(reasons: MismatchReason[]): string {
  if (reasons.length <= 1) return reasons.join("")
  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`
}

function SelectedStrip({ entries }: { entries: BulkEntry[] }) {
  const shown = entries.slice(0, 8)
  const extra = entries.length - shown.length
  return (
    <div className="flex items-center gap-2">
      <ul className="flex -space-x-3" aria-label="Selected spools">
        {shown.map(({ spool }) => (
          <li key={spool.id} className="rounded-full ring-2 ring-panel" title={`${spool.material} · ${spool.colorName}`}>
            <SpoolDisc color={spool.color} color2={discColor2(spool)} size={40} fill={spoolFill(spool)} />
          </li>
        ))}
      </ul>
      {extra > 0 && <span className="text-sm text-muted-foreground">+{extra} more</span>}
    </div>
  )
}
