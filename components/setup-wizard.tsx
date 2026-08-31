"use client"

import { useState } from "react"
import { Boxes, Check, Scale, Layers, Wrench } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import type { SystemKind } from "@/lib/types"
import { Button } from "./ui/button"
import { draftToConfig, makeDraft, StorageLayoutEditor } from "./storage-layout-editor"

export function SetupWizard() {
  const { dispatch } = useStore()
  const [draft, setDraft] = useState(() => makeDraft("paternoster"))
  // Which area this first unit belongs to. Filament is the classic flow;
  // hardware stores parts (bolts, nuts…) by count instead of spools.
  const [system, setSystem] = useState<SystemKind>("filament")
  // Where to surface the "Total filament used" totals. Chosen here at setup,
  // editable later under Settings.
  const [showUsageCardOnHome, setShowUsageCardOnHome] = useState(true)

  const isShelf = draft.nodeType === "shelf"
  const isLibrary = draft.nodeType === "library"
  // Both shelf and library are manual (no motor), so they skip carousel copy.
  const isManual = isShelf || isLibrary

  const isHardware = system === "hardware"

  const build = () => {
    const { storage, shelfMeta } = draftToConfig(draft)
    const fallbackName = isLibrary ? "Library 1" : isShelf ? "Shelf Storage 1" : "Paternoster 1"
    dispatch({
      type: "SETUP",
      nodeType: draft.nodeType,
      name: draft.name.trim() || fallbackName,
      system,
      area: draft.area,
      storage,
      shelfMeta,
      settings: {
        systemName: draft.name.trim() || "PAX System",
        showUsageCardOnHome,
        // Open the app in the area the user just set up.
        activeArea: system,
      },
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

        {/* What are you storing? Filament vs hardware. */}
        <div className="mb-6">
          <p className="mb-1.5 text-sm font-medium text-muted-foreground">What are you storing?</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setSystem("filament")}
              className={cn(
                "flex items-center gap-2 rounded-lg border p-3 text-left transition-colors",
                !isHardware
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <Layers className="h-5 w-5 shrink-0" />
              <span>
                <span className="block text-sm font-medium">Filament</span>
                <span className="block text-xs text-muted-foreground">Spools, by weight</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setSystem("hardware")}
              className={cn(
                "flex items-center gap-2 rounded-lg border p-3 text-left transition-colors",
                isHardware
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <Wrench className="h-5 w-5 shrink-0" />
              <span>
                <span className="block text-sm font-medium">Hardware</span>
                <span className="block text-xs text-muted-foreground">Parts, by count</span>
              </span>
            </button>
          </div>
        </div>

        <StorageLayoutEditor draft={draft} onChange={setDraft} />

        {/* Filament-usage visibility preference (filament area only). */}
        {!isHardware && (
        <div className="mt-6 rounded-xl border border-border bg-background/60 p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary">
              <Scale className="h-4 w-4 text-muted-foreground" />
            </span>
            <div>
              <h2 className="text-sm font-semibold text-foreground">Total filament used</h2>
              <p className="text-xs text-muted-foreground">Where should the running weight counter show?</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setShowUsageCardOnHome(true)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                showUsageCardOnHome
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="block text-sm font-medium">On every view</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Paternoster, shelf &amp; library — plus History
              </span>
            </button>
            <button
              type="button"
              onClick={() => setShowUsageCardOnHome(false)}
              className={cn(
                "rounded-lg border p-3 text-left transition-colors",
                !showUsageCardOnHome
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="block text-sm font-medium">History only</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">Keep the storage views clean</span>
            </button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">You can change this later under Settings.</p>
        </div>
        )}

        <div className="mt-6 space-y-3">
          <Button size="lg" className="w-full" onClick={build}>
            <Check className="h-5 w-5" />
            {isLibrary ? "Create library" : isShelf ? "Create storage" : "Build machine"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            You can change these later, and add more storage units, in Settings.
            {!isManual && " The carousel homes itself, then you can tune its PWM speed in Manual control."}
          </p>
        </div>
      </div>
    </div>
  )
}
