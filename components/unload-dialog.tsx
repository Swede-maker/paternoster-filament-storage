"use client"

import { useEffect, useState } from "react"
import { PackageMinus, Archive, Trash2, Server, Package, Library, MapPin } from "lucide-react"
import { useStore } from "@/lib/store"
import { printerSlotLabel } from "@/lib/selectors"
import { nodeFreeSlots } from "@/lib/balance"
import { formatGrams, formatRemaining, isLightColor, spoolFill } from "@/lib/filament"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { Field, Input, Select } from "./ui/field"
import { SpoolDisc } from "./spool"
import type { Printer, Spool } from "@/lib/types"

/**
 * Shown when a LOADED printer slot is tapped. The user chooses to store the
 * spool back in the paternoster (optionally updating grams) or delete it.
 */
export function UnloadDialog({
  target,
  placeInto,
  onClose,
  onStore,
  onPlace,
}: {
  target: { printer: Printer; slot: number; spool: Spool } | null
  /**
   * When set, the destination slot is already chosen (the user tapped a specific
   * empty storage slot). The unit picker is hidden and the spool is placed
   * directly into that slot via onPlace instead of the auto-store queue. */
  placeInto?: { label: string } | null
  onClose: () => void
  onStore: (printer: Printer, slot: number, spool: Spool, grams?: number, nodeId?: string) => void
  onPlace?: (printer: Printer, slot: number, spool: Spool, grams?: number) => void
}) {
  const { state, dispatch } = useStore()
  const [grams, setGrams] = useState("")
  // Which storage unit to store into. Seeded to the unit the user is viewing, but
  // they can redirect to any unit with room (e.g. paternoster vs a dumb shelf).
  const [destNodeId, setDestNodeId] = useState<string>("")
  // Container the spool goes back into (or none). Seeded from the spool's last
  // container so the common case is one tap, but the user can change it here.
  const [containerId, setContainerId] = useState<string>("")
  const containers = state.settings.containers ?? []

  // Units that still have room, with a friendly capacity/label for each. A
  // library is an unbounded catalog, so it always has room (never "Full") no
  // matter how many spools it already holds.
  const options = state.nodes.map((n) => {
    const type = n.type ?? "paternoster"
    const isLibrary = type === "library"
    return {
      node: n,
      free: nodeFreeSlots(n),
      unbounded: isLibrary,
      isShelf: type === "shelf",
      isLibrary,
    }
  })
  const hasRoom = options.filter((o) => o.unbounded || o.free > 0)
  const storageFull = hasRoom.length === 0

  useEffect(() => {
    if (!target) return
    setGrams(String(Math.round(target.spool.grams)))
    // A library never fills up; fixed grids need a free slot. Prefer the active
    // unit (the section the user is on) when it has room, else the first unit
    // that does.
    const roomFor = (n: (typeof state.nodes)[number]) =>
      (n.type ?? "paternoster") === "library" || nodeFreeSlots(n) > 0
    const active = state.nodes.find((n) => n.id === state.activeNodeId)
    const activeHasRoom = active && roomFor(active)
    const firstWithRoom = state.nodes.find(roomFor)
    setDestNodeId(activeHasRoom ? active!.id : firstWithRoom?.id ?? "")
    // Seed the container from whatever the spool was in; still valid only if that
    // container still exists in settings, otherwise fall back to "none".
    const stillExists = (state.settings.containers ?? []).some((c) => c.id === target.spool.containerId)
    setContainerId(stillExists ? target.spool.containerId! : "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  if (!target) return null
  const { printer, slot, spool } = target
  // Direct placement into a pre-chosen slot vs. the auto-store queue.
  const placing = !!placeInto

  function store() {
    const g = Number.parseInt(grams)
    const gramsVal = Number.isFinite(g) ? Math.max(0, g) : undefined
    const chosen = containerId || undefined
    // Persist the container choice on the spool first, then hand a spool that
    // already reflects it downstream so balance math and the box icon both use
    // the new value (and a cleared container really clears).
    if (chosen !== spool.containerId) {
      dispatch({ type: "UPDATE_SPOOL", id: spool.id, changes: { containerId: chosen } })
    }
    const corrected = { ...spool, containerId: chosen }
    if (placing) onPlace?.(printer, slot, corrected, gramsVal)
    else onStore(printer, slot, corrected, gramsVal, destNodeId || undefined)
  }

  function del() {
    if (confirm(`Delete ${spool.material} ${spool.colorName}? This removes it entirely.`)) {
      dispatch({ type: "DELETE_SPOOL", id: spool.id })
      onClose()
    }
  }

  return (
    <Dialog open={target !== null} onClose={onClose}>
      <DialogHeader
        icon={<PackageMinus className="h-5 w-5" />}
        title={placing ? "Place spool in slot" : "Take spool off printer"}
        description={
          placing
            ? `${printer.name} · slot ${printerSlotLabel(printer, slot)} → ${placeInto!.label}`
            : `${printer.name} · slot ${printerSlotLabel(printer, slot)}`
        }
      />
      <DialogBody className="space-y-5">
        <div className="flex items-center gap-4">
          <SpoolDisc color={spool.color} size={72} fill={spoolFill(spool)} />
          <div>
            <p className="text-lg font-semibold" style={{ color: isLightColor(spool.color) ? "#d4d4d8" : spool.color }}>
              {spool.material} · {spool.colorName}
            </p>
            <p className="text-sm text-muted-foreground">
              {spool.brand} · {formatRemaining(spool)}
            </p>
          </div>
        </div>

        {!placing && options.length > 1 && (
          <Field label="Store in">
            <div className="grid gap-2 sm:grid-cols-2">
              {options.map(({ node, free, isShelf, isLibrary }) => {
                const selected = node.id === destNodeId
                const full = !isLibrary && free === 0
                const Icon = isLibrary ? Library : isShelf ? Package : Server
                return (
                  <button
                    key={node.id}
                    type="button"
                    disabled={full}
                    onClick={() => setDestNodeId(node.id)}
                    className={
                      "flex items-start gap-2 rounded-xl border p-3 text-left transition-colors " +
                      (selected
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background/50 hover:border-primary/50") +
                      (full ? " cursor-not-allowed opacity-50" : "")
                    }
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{node.name}</span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        {node.area && (
                          <>
                            <MapPin className="h-3 w-3" />
                            {node.area}
                            <span aria-hidden>·</span>
                          </>
                        )}
                        {isLibrary ? "Library" : isShelf ? "Shelf" : "Paternoster"}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {isLibrary ? "Unlimited" : full ? "Full" : `${free} free`}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </Field>
        )}

        <Field label="Update remaining weight (optional)">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              inputMode="numeric"
              value={grams}
              onChange={(e) => setGrams(e.target.value)}
              placeholder="grams"
            />
            <span className="text-sm text-muted-foreground">g</span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            If the printer already updated the weight, leave this and the system keeps the last value.
          </p>
        </Field>

        <Field label="Store in container / dry box">
          <Select value={containerId} onChange={(e) => setContainerId(e.target.value)} aria-label="Storage container">
            <option value="">No container (bare spool)</option>
            {containers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} (+{formatGrams(c.weightGrams)})
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">
            {containers.length === 0
              ? "Set up dry boxes in Settings → Storage containers to select one here."
              : "The container's weight is added when balancing the carousel position."}
          </p>
        </Field>

        {!placing && storageFull && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
            Storage is full — you can still delete the spool, but there is nowhere to store it.
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="destructive" onClick={del}>
          <Trash2 className="h-4 w-4" /> Delete
        </Button>
        <Button onClick={store} disabled={placing ? false : storageFull || !destNodeId}>
          <Archive className="h-4 w-4" /> {placing ? "Place here" : "Store spool"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
