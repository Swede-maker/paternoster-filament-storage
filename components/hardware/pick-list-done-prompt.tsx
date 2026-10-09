"use client"

import { CheckCircle2 } from "lucide-react"
import { useStore } from "@/lib/store"
import { Button } from "../ui/button"
import { Dialog, DialogBody, DialogFooter } from "../ui/dialog"

/**
 * Shown once the final piece of a picking list has been taken out and the
 * carousel job has finished: the whole list is picked — remove it or keep it?
 */
export function PickListDonePrompt() {
  const { state, dispatch } = useStore()
  // Wait for the job to end so the prompt doesn't sit on top of the last stop.
  const list = state.job ? undefined : (state.hwPickLists ?? []).find((l) => l.donePromptPending)
  if (!list) return null

  const total = list.lines.reduce((s, ln) => s + ln.picked, 0)
  const keep = () => dispatch({ type: "PICKLIST_RESOLVE_DONE", id: list.id })

  return (
    <Dialog open onClose={keep} hideClose>
      <DialogBody>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success/15 text-success" aria-hidden>
            <CheckCircle2 className="h-7 w-7" />
          </span>
          <h2 className="text-balance text-xl font-semibold text-foreground">Everything is picked</h2>
          <p className="text-pretty text-sm text-muted-foreground">
            All {list.lines.length} {list.lines.length === 1 ? "part" : "parts"} on{" "}
            <span className="font-medium text-foreground">{list.name}</span> have been taken out ({total} pcs in
            total). Remove the list, or keep it for reference?
          </p>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={keep}>
          Keep the list
        </Button>
        <Button onClick={() => dispatch({ type: "PICKLIST_DELETE", id: list.id })}>Remove list</Button>
      </DialogFooter>
    </Dialog>
  )
}
