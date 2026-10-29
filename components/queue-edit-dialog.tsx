"use client"

import { useEffect, useState } from "react"
import { Pencil, Save } from "lucide-react"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { SpoolForm, draftToSpoolFields, spoolToDraft, type SpoolDraft } from "./spool-form"
import type { Spool } from "@/lib/types"

/** Edit a spool that is already waiting in the queue, keeping its place in it. */
export function QueueEditDialog({
  spool,
  onClose,
  onSave,
}: {
  spool: Spool | null
  onClose: () => void
  onSave: (spoolId: string, changes: Partial<Spool>) => void
}) {
  const [draft, setDraft] = useState<SpoolDraft | null>(spool ? spoolToDraft(spool) : null)

  useEffect(() => {
    setDraft(spool ? spoolToDraft(spool) : null)
  }, [spool])

  function submit() {
    if (!spool || !draft) return
    onSave(spool.id, draftToSpoolFields(draft))
    onClose()
  }

  return (
    <Dialog open={spool != null} onClose={onClose}>
      <DialogHeader
        icon={<Pencil className="h-5 w-5" />}
        title="Edit queued spool"
        description="Change the details. The spool keeps its place in the queue."
      />
      <DialogBody>{draft && <SpoolForm value={draft} onChange={setDraft} showProfiles />}</DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit}>
          <Save className="h-4 w-4" /> Save
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
