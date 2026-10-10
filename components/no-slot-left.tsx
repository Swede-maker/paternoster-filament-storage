"use client"

import { useState } from "react"
import { AlertTriangle, BookOpen, ArrowRight } from "lucide-react"
import { useStore } from "@/lib/store"
import { nodeFreeSlots } from "@/lib/balance"
import { nodesForSystem } from "@/lib/selectors"
import { Button } from "./ui/button"
import { Input } from "./ui/field"
import type { QueueItem } from "@/lib/types"

/**
 * Shown on the store-confirm card when the operator has turned down every slot
 * the system could offer. Gives the two ways forward: another filament unit
 * with room (a library counts, it is unbounded), or a brand-new library.
 */
export function NoSlotLeft({ item }: { item: QueueItem }) {
  const { state, dispatch } = useStore()
  const [creating, setCreating] = useState(false)
  const existingLibraries = nodesForSystem(state, "filament").filter((n) => (n.type ?? "paternoster") === "library")
  const [name, setName] = useState(existingLibraries.length === 0 ? "Library" : `Library ${existingLibraries.length + 1}`)

  const rejectedIn = new Set((item.rejectedSlots ?? []).map((r) => r.nodeId))
  // Units that can still take this spool. The unit the operator just exhausted
  // is only listed if it is a library (always has room) — a fixed grid that ran
  // out of acceptable slots would just offer a rejected one again.
  const alternatives = nodesForSystem(state, "filament").filter((n) => {
    const isLibrary = (n.type ?? "paternoster") === "library"
    if (isLibrary) return true
    return n.id !== item.nodeId && !rejectedIn.has(n.id) && nodeFreeSlots(n) > 0
  })

  return (
    <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 p-3" role="status">
      <p className="flex items-start gap-2 text-sm font-medium text-foreground text-pretty">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        No slot left that fits this spool.
      </p>
      <p className="mt-1 text-xs text-muted-foreground text-pretty">
        {item.rejectedSlots?.length === 1
          ? "The 1 slot this unit could offer was marked as too tight."
          : `All ${item.rejectedSlots?.length ?? 0} slots this unit could offer were marked as too tight.`}{" "}
        {alternatives.length > 0
          ? "Send the spool to another unit, or put it in a library."
          : "There is no other unit with room. Put the spool in a library instead."}
      </p>

      {alternatives.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {alternatives.map((n) => {
            const isLibrary = (n.type ?? "paternoster") === "library"
            return (
              <Button
                key={n.id}
                size="sm"
                variant="outline"
                className="w-full justify-between"
                onClick={() => dispatch({ type: "RETARGET_STORE_ITEM", nodeId: n.id })}
              >
                <span className="flex items-center gap-2">
                  {isLibrary && <BookOpen className="h-4 w-4" aria-hidden />}
                  {n.name}
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {isLibrary ? "unlimited" : `${nodeFreeSlots(n)} free`}
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                </span>
              </Button>
            )
          })}
        </div>
      )}

      {creating ? (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            dispatch({ type: "RETARGET_STORE_ITEM", newLibraryName: name })
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Name for the new library"
            autoFocus
          />
          <Button type="submit" size="sm" className="shrink-0 whitespace-nowrap" disabled={!name.trim()}>
            Create &amp; store
          </Button>
          <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={() => setCreating(false)}>
            Back
          </Button>
        </form>
      ) : (
        <Button size="sm" variant={alternatives.length > 0 ? "ghost" : "primary"} className="mt-2 w-full" onClick={() => setCreating(true)}>
          <BookOpen className="h-4 w-4" /> Create a library and store it there
        </Button>
      )}
      <p className="mt-2 text-xs text-muted-foreground text-pretty">
        A library is a manual, unlimited list for spools kept outside the carousel. It appears as its own unit and can
        be renamed later under Settings → Storage.
      </p>
    </div>
  )
}
