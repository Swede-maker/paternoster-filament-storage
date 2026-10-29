"use client"

import { useEffect, useState } from "react"
import { PackagePlus } from "lucide-react"
import { useStore } from "@/lib/store"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { SpoolForm, emptyDraft, type SpoolDraft } from "./spool-form"

/**
 * Create a brand-new spool (one the user physically has in hand) and load it
 * straight onto a printer slot — no storage step, no carousel movement. Used
 * when loading an AMS / toolchanger slot.
 */
export function NewSpoolDialog({
  open,
  targetLabel,
  confirmLabel = "Load onto printer",
  fallbackDescription = "Describe the spool. It loads straight onto the printer.",
  onClose,
  onConfirm,
}: {
  open: boolean
  /** e.g. "Voron2.4 · Slot 1-2" — where the new spool will load. */
  targetLabel?: string
  confirmLabel?: string
  fallbackDescription?: string
  onClose: () => void
  onConfirm: (draft: SpoolDraft) => void
}) {
  const { state } = useStore()
  const [draft, setDraft] = useState<SpoolDraft>(
    emptyDraft(state.settings.defaultSpoolWeight, state.settings.defaultDiameter),
  )

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) setDraft(emptyDraft(state.settings.defaultSpoolWeight, state.settings.defaultDiameter))
  }, [open, state.settings.defaultSpoolWeight, state.settings.defaultDiameter])

  function submit() {
    onConfirm(draft)
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader
        icon={<PackagePlus className="h-5 w-5" />}
        title="New spool"
        description={
          targetLabel
            ? `Describe the spool. It loads straight into ${targetLabel}.`
            : fallbackDescription
        }
      />
      <DialogBody>
        <SpoolForm value={draft} onChange={setDraft} showProfiles showBarcode showTag />
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit}>
          <PackagePlus className="h-4 w-4" /> {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
