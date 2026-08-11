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
  const [draft, setDraft] = useState<SpoolDraft>(emptyDraft(state.settings.defaultSpoolWeight))

  const stats = getStats(state)
  const full = stats.emptySlots === 0

  function submit() {
    startPlace(draft)
    setDraft(emptyDraft(state.settings.defaultSpoolWeight))
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
          <SpoolForm value={draft} onChange={setDraft} />
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={full}>
          Find best slot
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
