"use client"

import { useState } from "react"
import { Boxes, Check } from "lucide-react"
import { useStore } from "@/lib/store"
import { Button } from "./ui/button"
import { draftToConfig, makeDraft, StorageLayoutEditor } from "./storage-layout-editor"

export function SetupWizard() {
  const { dispatch } = useStore()
  const [draft, setDraft] = useState(() => makeDraft("paternoster"))

  const isShelf = draft.nodeType === "shelf"

  const build = () => {
    const { storage, shelfMeta } = draftToConfig(draft)
    const fallbackName = isShelf ? "Shelf Storage 1" : "Paternoster 1"
    dispatch({
      type: "SETUP",
      nodeType: draft.nodeType,
      name: draft.name.trim() || fallbackName,
      area: draft.area,
      storage,
      shelfMeta,
      settings: { systemName: draft.name.trim() || "PAX System" },
    })
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <div className="w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-2xl sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Boxes className="h-7 w-7" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Set up your storage</h1>
            <p className="text-sm text-muted-foreground">
              Pick the kind of storage you have, then build it the way you actually made it.
            </p>
          </div>
        </div>

        <StorageLayoutEditor draft={draft} onChange={setDraft} />

        <div className="mt-6 space-y-3">
          <Button size="lg" className="w-full" onClick={build}>
            <Check className="h-5 w-5" />
            {isShelf ? "Create storage" : "Build machine"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            You can change these later, and add more storage units, in Settings.
            {!isShelf && " First you'll calibrate the carousel speed, then it homes itself."}
          </p>
        </div>
      </div>
    </div>
  )
}
