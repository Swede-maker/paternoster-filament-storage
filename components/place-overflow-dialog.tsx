"use client"

import { useState } from "react"
import { AlertTriangle, ArrowRight, BookOpen } from "lucide-react"
import { useStore } from "@/lib/store"
import { nodeFreeSlots } from "@/lib/balance"
import { nodesForSystem } from "@/lib/selectors"
import { useFlow } from "./flow-controller"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { Input } from "./ui/field"

/**
 * Asked when a "place" batch has more spools than the chosen unit can hold.
 * - Another unit has room → choose where the leftovers go.
 * - Every slot everywhere is full → put them in the existing library, or
 *   offer to create one when there is none.
 */
export function PlaceOverflowDialog() {
  const { overflow } = useFlow()
  if (!overflow) return null
  // Keyed so the name field resets for each new batch.
  return <OverflowPrompt key={`${overflow.startIndex}-${overflow.remaining}-${overflow.fromNodeId ?? ""}`} />
}

function OverflowPrompt() {
  const { state } = useStore()
  const { overflow, inItems, placeOverflow, dismissOverflow } = useFlow()
  const filamentNodes = nodesForSystem(state, "filament")
  const libraries = filamentNodes.filter((n) => (n.type ?? "paternoster") === "library")
  const [name, setName] = useState(libraries.length === 0 ? "Library" : `Library ${libraries.length + 1}`)

  if (!overflow) return null
  const { remaining, total } = overflow
  const fromNode = overflow.fromNodeId ? filamentNodes.find((n) => n.id === overflow.fromNodeId) : undefined
  const queued = total - remaining

  // Free slots that aren't already claimed by a spool waiting in the queue.
  const freeIn = (nodeId: string) => {
    const node = filamentNodes.find((n) => n.id === nodeId)
    if (!node) return 0
    return Math.max(0, nodeFreeSlots(node) - inItems.filter((i) => i.nodeId === nodeId).length)
  }
  const unitsWithRoom = filamentNodes.filter(
    (n) => (n.type ?? "paternoster") !== "library" && n.id !== overflow.fromNodeId && freeIn(n.id) > 0,
  )
  const everythingFull = unitsWithRoom.length === 0
  const spools = remaining === 1 ? "1 spool" : `${remaining} spools`

  return (
    <Dialog open onClose={dismissOverflow}>
      <DialogHeader
        icon={<AlertTriangle className="h-5 w-5 text-warning" />}
        title={everythingFull ? "All storage is full" : `${fromNode?.name ?? "This unit"} is full`}
        description={
          queued > 0
            ? `${queued} of ${total} spools got a slot. ${spools} did not fit.`
            : `There is no free slot for ${spools}.`
        }
      />
      <DialogBody className="flex flex-col gap-3">
        {!everythingFull && (
          <>
            <p className="text-sm text-foreground text-pretty">Where should the remaining {spools} go?</p>
            <div className="flex flex-col gap-1.5">
              {[...unitsWithRoom, ...libraries].map((n) => {
                const isLibrary = (n.type ?? "paternoster") === "library"
                const free = freeIn(n.id)
                return (
                  <Button
                    key={n.id}
                    variant="outline"
                    className="w-full justify-between"
                    onClick={() => placeOverflow({ nodeId: n.id })}
                  >
                    <span className="flex items-center gap-2">
                      {isLibrary && <BookOpen className="h-4 w-4" aria-hidden />}
                      {n.name}
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {isLibrary ? "unlimited" : `${free} free${free < remaining ? ` (fits ${free})` : ""}`}
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </span>
                  </Button>
                )
              })}
            </div>
            {unitsWithRoom.some((n) => freeIn(n.id) < remaining) && (
              <p className="text-xs text-muted-foreground text-pretty">
                If the unit you choose can&apos;t take them all, you&apos;ll be asked again for the rest.
              </p>
            )}
          </>
        )}

        {everythingFull && libraries.length > 0 && (
          <>
            <p className="text-sm text-foreground text-pretty">
              Every slot in every unit is full.{" "}
              {libraries.length === 1
                ? `The ${spools} will be placed in your library "${libraries[0].name}".`
                : `The ${spools} will be placed in a library. Choose which one:`}
            </p>
            {libraries.length > 1 && (
              <div className="flex flex-col gap-1.5">
                {libraries.map((n) => (
                  <Button
                    key={n.id}
                    variant="outline"
                    className="w-full justify-between"
                    onClick={() => placeOverflow({ nodeId: n.id })}
                  >
                    <span className="flex items-center gap-2">
                      <BookOpen className="h-4 w-4" aria-hidden />
                      {n.name}
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  </Button>
                ))}
              </div>
            )}
          </>
        )}

        {everythingFull && libraries.length === 0 && (
          <form
            id="overflow-new-library"
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) placeOverflow({ newLibraryName: name })
            }}
          >
            <p className="text-sm text-foreground text-pretty">
              Every slot in every unit is full and you have no library yet. Do you want to create a library for the{" "}
              {spools}?
            </p>
            <label htmlFor="overflow-library-name" className="text-xs font-medium text-muted-foreground">
              Library name
            </label>
            <Input id="overflow-library-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <p className="text-xs text-muted-foreground text-pretty">
              A library is a manual, unlimited list for spools kept outside the carousel. You can rename it later under
              Settings → Storage.
            </p>
          </form>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={dismissOverflow}>
          Don&apos;t add {remaining === 1 ? "it" : "them"}
        </Button>
        {everythingFull && libraries.length === 1 && (
          <Button onClick={() => placeOverflow({ nodeId: libraries[0].id })}>
            <BookOpen className="h-4 w-4" aria-hidden /> Place in {libraries[0].name}
          </Button>
        )}
        {everythingFull && libraries.length === 0 && (
          <Button type="submit" form="overflow-new-library" disabled={!name.trim()}>
            <BookOpen className="h-4 w-4" aria-hidden /> Create library
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}
