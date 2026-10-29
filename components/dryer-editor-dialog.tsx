"use client"

import { useState } from "react"
import { useStore } from "@/lib/store"
import { newId } from "@/lib/filament"
import { MAX_CHAMBER_CAPACITY, MAX_DRYER_CHAMBERS } from "@/lib/dryers"
import type { Dryer, DryerChamber, DryerKind } from "@/lib/types"
import { Dialog, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { Field, Input, NumberChips, Segmented } from "./ui/field"

const KIND_OPTIONS: { value: DryerKind; label: string }[] = [
  { value: "single", label: "Single" },
  { value: "shared", label: "Multi-spool" },
  { value: "chambers", label: "Chambers" },
]

const KIND_HINT: Record<DryerKind, string> = {
  single: "Holds one spool with its own timer.",
  shared: "Several spools share one heater and one timer.",
  chambers: "Separate chambers, each with its own spools and timer.",
}

/** Add a new dryer, or edit one when `dryer` is given. */
export function DryerEditorDialog({ open, onClose, dryer }: { open: boolean; onClose: () => void; dryer?: Dryer }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={dryer ? "Edit dryer" : "Add dryer"}
      description="Tell PAX how many spools fit so it can stop you overfilling it."
    >
      {open && <DryerEditorForm key={dryer?.id ?? "new"} dryer={dryer} onClose={onClose} />}
    </Dialog>
  )
}

function DryerEditorForm({ dryer, onClose }: { dryer?: Dryer; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const occupied = dryer ? dryer.chambers.some((c) => c.spoolIds.length > 0) : false
  const [name, setName] = useState(dryer?.name ?? `Dryer ${(state.settings.dryers?.length ?? 0) + 1}`)
  const [kind, setKind] = useState<DryerKind>(dryer?.kind ?? "shared")
  const [capacity, setCapacity] = useState(dryer?.chambers[0]?.capacity ?? 4)
  const [chamberCount, setChamberCount] = useState(dryer?.kind === "chambers" ? dryer.chambers.length : 2)

  const perChamber = kind === "single" ? 1 : capacity
  const count = kind === "chambers" ? chamberCount : 1

  function save() {
    const trimmed = name.trim() || "Dryer"
    const chambers: DryerChamber[] = Array.from({ length: count }, (_, i) => {
      const prev = dryer?.chambers[i]
      return prev
        ? { ...prev, capacity: Math.max(perChamber, prev.spoolIds.length) }
        : { id: newId("chamber"), capacity: perChamber, spoolIds: [] }
    })
    // Never drop a chamber that still holds spools when shrinking.
    if (dryer) {
      for (const c of dryer.chambers.slice(count)) if (c.spoolIds.length > 0) chambers.push(c)
    }
    const next: Dryer = {
      id: dryer?.id ?? newId("dryer"),
      name: trimmed,
      kind,
      chambers,
      awaitingLoad: dryer?.awaitingLoad ?? [],
      createdAt: dryer?.createdAt ?? Date.now(),
    }
    dispatch(dryer ? { type: "UPDATE_DRYER", dryer: next } : { type: "ADD_DRYER", dryer: next })
    onClose()
  }

  return (
    <>
      <DialogBody className="flex flex-col gap-5">
        <Field label="Name" htmlFor="dryer-name">
          <Input id="dryer-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </Field>

        <div className="flex flex-col gap-2">
          <Field label="Type">
            <Segmented options={KIND_OPTIONS} value={kind} onChange={setKind} className="w-full" />
          </Field>
          <p className="text-xs text-muted-foreground">{KIND_HINT[kind]}</p>
          {occupied && kind !== dryer?.kind && (
            <p className="text-xs text-warning">Spools inside stay where they are.</p>
          )}
        </div>

        {kind === "chambers" && (
          <Field label="Number of chambers">
            <NumberChips min={2} max={MAX_DRYER_CHAMBERS / 2} value={chamberCount} onChange={setChamberCount} />
          </Field>
        )}

        {kind !== "single" && (
          <Field label={kind === "chambers" ? "Spools per chamber" : "Spools it holds"}>
            <NumberChips min={1} max={MAX_CHAMBER_CAPACITY / 2} value={capacity} onChange={setCapacity} />
          </Field>
        )}

        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          Total capacity:{" "}
          <span className="font-semibold text-foreground">
            {perChamber * count} spool{perChamber * count === 1 ? "" : "s"}
          </span>
        </p>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save}>{dryer ? "Save" : "Add dryer"}</Button>
      </DialogFooter>
    </>
  )
}
