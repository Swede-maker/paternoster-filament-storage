"use client"

import { useState } from "react"
import { PackagePlus } from "lucide-react"
import { useStore } from "@/lib/store"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { SpoolForm, emptyDraft, type SpoolDraft } from "./spool-form"
import { newId } from "@/lib/filament"
import type { Spool } from "@/lib/types"

/**
 * Add filament straight into a library node's inventory. Unlike "Place new
 * filament" (which routes a spool to a balanced carousel slot via a job), a
 * library is an unbounded manual catalog — the spool is created and appended
 * instantly with no motion or queue. Supports creating several identical spools
 * at once via the quantity field.
 */
export function LibraryAddDialog({
  open,
  onClose,
  nodeId,
}: {
  open: boolean
  onClose: () => void
  nodeId: string
}) {
  const { state, dispatch } = useStore()
  const [draft, setDraft] = useState<SpoolDraft>(
    emptyDraft(state.settings.defaultSpoolWeight, state.settings.defaultDiameter),
  )

  const qty = Math.max(1, Math.round(draft.quantity ?? 1))

  function submit() {
    const { quantity: _q, ...fields } = draft
    for (let i = 0; i < qty; i++) {
      const spool: Spool = { id: newId("spool"), createdAt: Date.now(), ...fields }
      dispatch({ type: "LIBRARY_ADD_SPOOL", nodeId, spool })
    }
    setDraft(emptyDraft(state.settings.defaultSpoolWeight, state.settings.defaultDiameter))
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader
        icon={<PackagePlus className="h-5 w-5" />}
        title="Add filament to library"
        description="Catalog a spool you own. It's added to the library instantly — no slot, no movement."
      />
      <DialogBody>
        <SpoolForm value={draft} onChange={setDraft} showProfiles showQuantity showBarcode />
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit}>{qty > 1 ? `Add ${qty} spools` : "Add to library"}</Button>
      </DialogFooter>
    </Dialog>
  )
}
