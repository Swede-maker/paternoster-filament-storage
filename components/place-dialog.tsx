"use client"

import { useState } from "react"
import { PackagePlus } from "lucide-react"
import { useStore } from "@/lib/store"
import { useFlow } from "./flow-controller"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { SpoolForm, emptyDraft, type SpoolDraft } from "./spool-form"
import { getStats } from "@/lib/selectors"

/**
 * "Place new filament in storage" flow: describe the spool, then the machine
 * finds the best-balanced empty slot and rotates there.
 */
export function PlaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useStore()
  const { startPlace } = useFlow()
  const [draft, setDraft] = useState<SpoolDraft>(
    emptyDraft(state.settings.defaultSpoolWeight, state.settings.defaultDiameter),
  )

  const stats = getStats(state)
  const full = stats.emptySlots === 0
  const qty = Math.max(1, Math.round(draft.quantity ?? 1))

  function submit() {
    // Default the destination to the unit the user is currently viewing; they
    // can still redirect each queued spool from the queue tray.
    startPlace(draft, state.activeNodeId)
    setDraft(emptyDraft(state.settings.defaultSpoolWeight, state.settings.defaultDiameter))
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader
        icon={<PackagePlus className="h-5 w-5" />}
        title="Place new filament"
        description="Describe the spool. The system picks the slot that keeps the carousel balanced."
      />
      <DialogBody>
        {full ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
            Storage is full. Remove a spool before adding a new one.
          </p>
        ) : (
          <SpoolForm value={draft} onChange={setDraft} showProfiles showQuantity showBarcode />
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={full}>
          {qty > 1 ? `Find ${qty} slots` : "Find best slot"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
