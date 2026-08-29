"use client"

import { useState, useEffect } from "react"
import { Boxes, Package, Plus, Server, Loader2, MapPin } from "lucide-react"
import { useStore } from "@/lib/store"
import { useFlow, type NodeLocation } from "./flow-controller"
import { Button } from "./ui/button"
import { ResizableSidebar } from "./resizable-sidebar"
import { StatsBar } from "./stats-bar"
import { CarouselView } from "./carousel-view"
import { ShelfStorageView } from "./shelf-storage-view"
import { LibraryView } from "./library-view"
import { PrinterPanel } from "./printer-panel"
import { QueueTray } from "./queue-tray"
import { PickBrowser } from "./pick-browser"
import { PlaceDialog } from "./place-dialog"
import { LibraryAddDialog } from "./library-add-dialog"
import { SlotActionDialog } from "./slot-action-dialog"
import { UnloadDialog } from "./unload-dialog"
import { NewSpoolDialog } from "./new-spool-dialog"
import { SlotPickerDialog } from "./slot-picker-dialog"
import { PrinterPickerDialog } from "./printer-picker-dialog"
import { QueuePlaceDialog } from "./queue-place-dialog"
import { activeNode, printerSlotLabel, shelfLabel } from "@/lib/selectors"
import { newId } from "@/lib/filament"
import type { SpoolDraft } from "./spool-form"
import { draftToSpoolFields } from "./spool-form"
import type { Printer, Spool } from "@/lib/types"

export function HomeView() {
  const { state, dispatch } = useStore()
  const flow = useFlow()

  // Which printer slot a fresh pick should target (set when tapping an empty slot).
  const [pickTarget, setPickTarget] = useState<{ printer: Printer; slot: number } | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [placeOpen, setPlaceOpen] = useState(false)
  // "Add filament to library" dialog (library nodes only — instant catalog add).
  const [libraryAddOpen, setLibraryAddOpen] = useState(false)
  const [newSpoolOpen, setNewSpoolOpen] = useState(false)
  const [slotPickerOpen, setSlotPickerOpen] = useState(false)
  const [slotPickerMode, setSlotPickerMode] = useState<"empty" | "loaded">("empty")
  // Which printer the pick/take-out slot picker targets. Lets "Pick more" / "Take
  // out more" hit a DIFFERENT printer than the active one (choose printer first).
  const [slotPickerPrinter, setSlotPickerPrinter] = useState<Printer | null>(null)
  const [slotTarget, setSlotTarget] = useState<{ shelf: number; slot: number } | null>(null)
  // Manual shelf placement: tapped empty slot to fill from the waiting queue.
  const [queueFillTarget, setQueueFillTarget] = useState<{ shelf: number; slot: number } | null>(null)
  const [unloadTarget, setUnloadTarget] = useState<{ printer: Printer; slot: number; spool: Spool } | null>(null)
  // Filling a tapped empty storage slot straight from a printer: the destination
  // slot, plus the printer that seeds the loaded-spool picker's tabs.
  const [fillFromPrinterTarget, setFillFromPrinterTarget] = useState<{ shelf: number; slot: number } | null>(null)
  const [fillPickerPrinter, setFillPickerPrinter] = useState<Printer | null>(null)
  // Search-driven actions: printer picker + slot picker targets used when
  // loading a tapped stored spool onto a printer.
  const [printerPickTarget, setPrinterPickTarget] = useState<{ spool: Spool; loc: NodeLocation } | null>(null)
  const [searchLoad, setSearchLoad] = useState<{ spool: Spool; loc: NodeLocation; printer: Printer } | null>(null)

  // Consume an "act on this spool" request handed off from the All Filament In
  // Storage tab: focus that spool's unit and open the FULL slot action hub
  // (load / take out / move / dry reminder / edit / delete) — the same one a
  // direct slot tap opens — so the tab isn't limited to load/take-out. Since the
  // node is now active, the spool lives at loc.shelf/loc.slot on it. Runs once
  // per request, then clears it.
  useEffect(() => {
    const req = flow.inspectRequest
    if (!req) return
    if (state.activeNodeId !== req.loc.nodeId) {
      dispatch({ type: "SET_ACTIVE_NODE", id: req.loc.nodeId })
    }
    setSlotTarget({ shelf: req.loc.shelf, slot: req.loc.slot })
    flow.consumeInspect()
  }, [flow.inspectRequest, state.activeNodeId, dispatch, flow])

  const currentNode = activeNode(state)
  const isShelf = (currentNode.type ?? "paternoster") === "shelf"
  const isLibrary = (currentNode.type ?? "paternoster") === "library"
  // Both shelf and library are manual (no motor); the carousel chrome + auto
  // "place" button are paternoster-only.
  const isManual = isShelf || isLibrary

  const loadablePrinters = state.printers.filter((p) => p.loaded.some((s) => s == null))
  // Printers that currently have at least one loaded spool — the ones "Take out
  // more" can target.
  const unloadablePrinters = state.printers.filter((p) => p.loaded.some((s) => s != null))

  const queuedForActivePrinter = state.activePrinterId ? flow.queuedPrinterSlots(state.activePrinterId) : []
  // Only highlight the target slot on the unit that actually holds it. Shelf and
  // slot indices repeat across units, so an unscoped highlight would light up the
  // same coordinates on every tab (e.g. an empty slot on "Dumb pax").
  const currentItem = state.job ? state.job.items[state.job.currentIndex] : null
  const jobTarget =
    currentItem && currentItem.nodeId === state.activeNodeId
      ? { shelf: currentItem.shelf, slot: currentItem.slot }
      : null

  // Tapping an EMPTY printer slot → open the browser to choose a spool for it.
  function handleLoadSlot(printer: Printer, slot: number) {
    setPickTarget({ printer, slot })
    setBrowserOpen(true)
  }

  // Tapping a LOADED printer slot → store-or-delete dialog.
  function handleUnloadSlot(printer: Printer, slot: number, spool: Spool) {
    setUnloadTarget({ printer, slot, spool })
  }

  // A stored spool was chosen in the browser for the current pick target.
  function handlePicked(spool: Spool, loc: NodeLocation) {
    if (!pickTarget) return
    flow.startPick(spool, loc, pickTarget.printer, pickTarget.slot)
    setBrowserOpen(false)
    setPickTarget(null)
  }

  // User chose "Create new spool" in the browser → open the spool form.
  function handleChooseNew() {
    setBrowserOpen(false)
    setNewSpoolOpen(true)
  }

  // New spool described → it's in the user's hand, so load it straight onto the
  // printer slot. No storage location and no carousel movement needed.
  function handleNewSpool(draft: SpoolDraft) {
    if (!pickTarget) return
    const spool: Spool = { id: newId("spool"), createdAt: Date.now(), ...draftToSpoolFields(draft) }
    dispatch({ type: "UPSERT_SPOOL", spool })
    dispatch({ type: "SET_PRINTER_SLOT", printerId: pickTarget.printer.id, slot: pickTarget.slot, spoolId: spool.id })
    setNewSpoolOpen(false)
    setPickTarget(null)
  }

  // A stored spool was tapped in the SEARCH browser → focus its unit and open
  // the full slot action hub (same as a direct slot tap), so search and direct
  // taps offer identical options.
  function handleInspect(_spool: Spool, loc: NodeLocation) {
    setBrowserOpen(false)
    if (state.activeNodeId !== loc.nodeId) {
      dispatch({ type: "SET_ACTIVE_NODE", id: loc.nodeId })
    }
    setSlotTarget({ shelf: loc.shelf, slot: loc.slot })
  }

  // Begin loading a stored spool onto a printer: go straight to slot selection
  // when there's a single loadable printer, otherwise ask which printer first.
  // Shared by the search flow and the direct slot-tap action hub.
  function beginLoad(spool: Spool, loc: NodeLocation) {
    if (loadablePrinters.length === 1) {
      setSearchLoad({ spool, loc, printer: loadablePrinters[0] })
    } else if (loadablePrinters.length > 1) {
      setPrinterPickTarget({ spool, loc })
    }
  }

  // A printer was chosen for a search-load → move on to slot selection.
  function handlePrinterChosen(printer: Printer) {
    if (!printerPickTarget) return
    setSearchLoad({ ...printerPickTarget, printer })
    setPrinterPickTarget(null)
  }

  // An empty slot was chosen for a search-load → queue the pick.
  function handleSearchSlotPicked(printer: Printer, slot: number) {
    if (!searchLoad) return
    flow.startPick(searchLoad.spool, searchLoad.loc, printer, slot)
    setSearchLoad(null)
  }

  // Which printer the tabbed picker should open on: prefer the one the user last
  // acted on in this flow, so "Pick more" stays on the printer they were just
  // working with instead of resetting to the first tab. Fall back to the active
  // printer, then the first candidate.
  function preferredMorePrinter(candidates: Printer[]): Printer {
    const lastId = [...flow.inItems, ...flow.outItems].reverse().find((i) => i.printerId != null)?.printerId
    return (
      candidates.find((p) => p.id === lastId) ??
      candidates.find((p) => p.id === state.activePrinterId) ??
      candidates[0]
    )
  }

  // "Pick more" (pick flow) → load onto another slot on ANY printer with room.
  // Opens one dialog with printer tabs + that printer's empty slots.
  function handlePickMore() {
    if (loadablePrinters.length === 0) return
    setSlotPickerPrinter(preferredMorePrinter(loadablePrinters))
    setSlotPickerMode("empty")
    setSlotPickerOpen(true)
  }

  // "Take out more" (store flow) → unload from another loaded slot on ANY printer
  // that has one. Same combined tabs + slots dialog.
  function handleStoreMore() {
    if (unloadablePrinters.length === 0) return
    setSlotPickerPrinter(preferredMorePrinter(unloadablePrinters))
    setSlotPickerMode("loaded")
    setSlotPickerOpen(true)
  }

  // A slot was chosen in the slot picker.
  function handleSlotPicked(printer: Printer, slot: number) {
    setSlotPickerOpen(false)
    setSlotPickerPrinter(null)
    if (slotPickerMode === "loaded") {
      // Store flow: open the unload dialog for the chosen loaded spool.
      const spoolId = printer.loaded[slot]
      const spool = spoolId ? state.spools[spoolId] : undefined
      if (spool) setUnloadTarget({ printer, slot, spool })
    } else {
      // Pick flow: open the filament chooser for the chosen empty slot.
      setPickTarget({ printer, slot })
      setBrowserOpen(true)
    }
  }

  // A loaded spool was chosen in that picker → open the take-off dialog in
  // "place into this slot" mode (weight + container options, direct placement).
  function handleFillSpoolPicked(printer: Printer, slot: number) {
    const spoolId = printer.loaded[slot]
    const spool = spoolId ? state.spools[spoolId] : undefined
    setFillPickerPrinter(null)
    if (spool) setUnloadTarget({ printer, slot, spool })
    else setFillFromPrinterTarget(null)
  }

  // Confirmed in the take-off dialog → clear the printer slot and drop the spool
  // directly into the tapped storage slot (no queue, no carousel motion).
  function handlePlaceFromPrinter(printer: Printer, printerSlot: number, spool: Spool, grams?: number) {
    const dest = fillFromPrinterTarget
    if (!dest) return
    if (typeof grams === "number") dispatch({ type: "UPDATE_SPOOL", id: spool.id, changes: { grams } })
    dispatch({ type: "SET_PRINTER_SLOT", printerId: printer.id, slot: printerSlot, spoolId: null })
    dispatch({ type: "SET_STORAGE_SLOT", nodeId: currentNode.id, shelf: dest.shelf, slot: dest.slot, spoolId: spool.id })
    setUnloadTarget(null)
    setFillFromPrinterTarget(null)
  }

  const newSpoolTargetLabel = pickTarget
    ? `${pickTarget.printer.name} · Slot ${printerSlotLabel(pickTarget.printer, pickTarget.slot)}`
    : undefined

  return (
    <div className="flex flex-col gap-3 p-3 lg:min-h-0 lg:flex-1 lg:flex-row">
      {/* Left sidebar. Manual shelf storage has no carousel to navigate and shows
          every shelf full-width in the main column, so the sidebar (overview +
          controls + summary) is paternoster-only — dropping it lets the shelf
          grid and printer panel reclaim the full width. Library storage is also
          manual and full-width, so it hides the sidebar too. */}
      {!isManual && (
        <aside className="flex w-full shrink-0 flex-col rounded-2xl border border-border bg-panel lg:w-[300px] lg:min-h-0">
          <SidebarHeader />
          <ResizableSidebar />
        </aside>
      )}

      {/* Main column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <StatsBar onSearchClick={() => setBrowserOpen(true)} />

        {/* Node switcher — only shown when more than one unit is linked. */}
        {state.nodes.length > 1 && (
          <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Storage units">
            {state.nodes.map((n) => {
              const active = n.id === state.activeNodeId
              const nodeType = n.type ?? "paternoster"
              const nodeIsShelf = nodeType === "shelf"
              const nodeIsLibrary = nodeType === "library"
              const busy = nodeType === "paternoster" && n.machine.status === "moving"
              const Icon = nodeIsLibrary ? Boxes : nodeIsShelf ? Package : Server
              return (
                <button
                  key={n.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => dispatch({ type: "SET_ACTIVE_NODE", id: n.id })}
                  className={
                    "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors " +
                    (active
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background/50 text-muted-foreground hover:border-primary/50")
                  }
                >
                  <Icon className="h-4 w-4" />
                  <span className="font-medium">{n.name}</span>
                  {n.area ? (
                    <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                      <MapPin className="h-3 w-3" />
                      {n.area}
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {nodeIsLibrary ? "library" : nodeIsShelf ? "shelf" : n.role}
                    </span>
                  )}
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                </button>
              )
            })}
          </div>
        )}

        {/* Place-new action. A big "+" button appears on every unit type. On a
            library it opens the instant catalog-add dialog; on a paternoster or
            shelf it opens the "Place new filament" flow, which auto-picks the
            destination slot (balanced for a carousel, lowest-empty for a shelf). */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground text-pretty">
            {jobTarget
              ? "Operation in progress — follow the on-screen prompts."
              : isLibrary
                ? "Filter and sort your inventory, or tap + to add a new spool."
                : "Tap a slot to manage filament, or tap + to add a new spool."}
          </p>
          <Button
            size="icon"
            aria-label={isLibrary ? "Add filament to library" : "Place new filament in storage"}
            title={isLibrary ? "Add filament to library" : "Place new filament in storage"}
            className="h-12 w-12 shrink-0 rounded-xl shadow-sm"
            onClick={() => (isLibrary ? setLibraryAddOpen(true) : setPlaceOpen(true))}
            disabled={!!state.job}
          >
            <Plus className="h-7 w-7" strokeWidth={2.5} />
            <span className="sr-only">{isLibrary ? "Add filament to library" : "Place new filament in storage"}</span>
          </Button>
        </div>

        {isLibrary ? (
          <LibraryView
            onAddClick={() => setLibraryAddOpen(true)}
            onSpoolClick={(slot) => {
              if (state.job) return
              setSlotTarget({ shelf: 0, slot })
            }}
            highlight={jobTarget && jobTarget.shelf === 0 ? jobTarget.slot : null}
          />
        ) : isShelf ? (
          <ShelfStorageView
            onSlotClick={(shelf, slot) => {
              if (state.job) return // don't open slot editor during an active operation
              const occupied = currentNode.slots[shelf]?.[slot] != null
              const queueWaiting = flow.inItems.length > 0
              // Empty slot + spools waiting → drop a queued spool here.
              // Otherwise → the slot editor. For an empty slot that's the create
              // form, which itself offers printer tabs to instead pull a spool
              // off a printer (handled inside SlotActionDialog).
              if (!occupied && queueWaiting) setQueueFillTarget({ shelf, slot })
              else setSlotTarget({ shelf, slot })
            }}
            highlight={jobTarget}
          />
        ) : (
          <CarouselView
            onSlotClick={(shelf, slot) => {
              if (state.job) return // don't open slot editor during an active operation
              setSlotTarget({ shelf, slot })
            }}
            highlight={jobTarget}
          />
        )}

        <PrinterPanel
          onLoadSlot={handleLoadSlot}
          onUnloadSlot={handleUnloadSlot}
          queuedPrinterSlots={queuedForActivePrinter}
        />
      </div>

      {/* Queue tray — assemble the place-in and take-out queues side by side. */}
      <QueueTray
        onAddMore={(view) => {
          if (view === "out") {
            // Take-out: a retrieve-only queue (or an empty one) adds more via the
            // search browser; a printer-driven pick queue adds more slots to load.
            const retrieveOnly =
              flow.outItems.length === 0 || flow.outItems.every((i) => i.printerId == null)
            if (retrieveOnly) setBrowserOpen(true)
            else handlePickMore()
          } else {
            // Place-in: if the queue is purely spools coming off printers, add
            // another unload; otherwise add a brand-new spool to place.
            const storeOnly =
              flow.inItems.length > 0 &&
              flow.inItems.every((i) => i.printerId != null && !i.isNew && !i.from)
            if (storeOnly) handleStoreMore()
            else setPlaceOpen(true)
          }
        }}
      />

      {/* Dialogs */}
      <PickBrowser
        open={browserOpen}
        onClose={() => {
          setBrowserOpen(false)
          setPickTarget(null)
        }}
        onPick={pickTarget ? handlePicked : undefined}
        onInspect={pickTarget ? undefined : handleInspect}
        onNew={pickTarget ? handleChooseNew : undefined}
        excludeIds={flow.outItems.map((i) => i.spool.id)}
        title={pickTarget ? "Choose filament to load" : "Search filament"}
        readOnly={!pickTarget}
      />

      <NewSpoolDialog
        open={newSpoolOpen}
        targetLabel={newSpoolTargetLabel}
        onClose={() => {
          setNewSpoolOpen(false)
          setPickTarget(null)
        }}
        onConfirm={handleNewSpool}
      />

      {/* "Pick more" / "Take out more": one dialog with printer tabs + slots. */}
      <SlotPickerDialog
        printer={slotPickerOpen ? slotPickerPrinter : null}
        printers={slotPickerMode === "loaded" ? unloadablePrinters : loadablePrinters}
        queuedSlotsFor={(id) => flow.queuedPrinterSlots(id)}
        mode={slotPickerMode}
        onClose={() => {
          setSlotPickerOpen(false)
          setSlotPickerPrinter(null)
        }}
        onPick={handleSlotPicked}
      />

      <PrinterPickerDialog
        printers={loadablePrinters}
        open={printerPickTarget != null}
        onClose={() => setPrinterPickTarget(null)}
        onPick={handlePrinterChosen}
      />

      <SlotPickerDialog
        printer={searchLoad?.printer ?? null}
        queuedSlots={searchLoad ? flow.queuedPrinterSlots(searchLoad.printer.id) : []}
        mode="empty"
        onClose={() => setSearchLoad(null)}
        onPick={handleSearchSlotPicked}
      />

      {/* Fill an empty storage slot from a printer: tabbed picker of loaded spools,
          with a "New spool" tab that falls back to the create form. */}
      <SlotPickerDialog
        printer={fillPickerPrinter}
        printers={unloadablePrinters}
        mode="loaded"
        onClose={() => {
          setFillPickerPrinter(null)
          setFillFromPrinterTarget(null)
        }}
        onPick={handleFillSpoolPicked}
        onCreateNew={() => {
          const dest = fillFromPrinterTarget
          setFillPickerPrinter(null)
          setFillFromPrinterTarget(null)
          if (dest) setSlotTarget(dest)
        }}
      />

      <PlaceDialog open={placeOpen} onClose={() => setPlaceOpen(false)} />

      <LibraryAddDialog open={libraryAddOpen} onClose={() => setLibraryAddOpen(false)} nodeId={currentNode.id} />

      {/* Manual shelf placement: drop a queued spool into a tapped empty slot,
          or create a new one for it while the rest keep waiting. */}
      <QueuePlaceDialog
        target={queueFillTarget}
        items={flow.inItems}
        slotLabel={
          queueFillTarget ? `${shelfLabel(currentNode, queueFillTarget.shelf)} · Slot ${queueFillTarget.slot + 1}` : ""
        }
        onPickQueued={(spoolId) => {
          if (!queueFillTarget) return
          flow.assignItemToSlot(spoolId, currentNode.id, queueFillTarget.shelf, queueFillTarget.slot)
          setQueueFillTarget(null)
        }}
        onCreateNew={() => {
          if (!queueFillTarget) return
          const t = queueFillTarget
          setQueueFillTarget(null)
          setSlotTarget(t) // opens the fill form for this exact slot
        }}
        onClose={() => setQueueFillTarget(null)}
      />

      <SlotActionDialog
        target={slotTarget}
        canLoad={loadablePrinters.length > 0}
        fillPrinters={unloadablePrinters}
        onPickFillPrinter={(printer) => {
          const dest = slotTarget
          setSlotTarget(null)
          if (dest) {
            setFillFromPrinterTarget(dest)
            setFillPickerPrinter(printer)
          }
        }}
        onLoad={(spool, loc) => {
          setSlotTarget(null)
          beginLoad(spool, loc)
        }}
        onTakeOut={(spool, loc) => {
          setSlotTarget(null)
          flow.startRetrieve(spool, loc)
        }}
        onMove={(spool, loc, destNodeId) => {
          setSlotTarget(null)
          flow.startMove(spool, loc, destNodeId)
        }}
        onClose={() => setSlotTarget(null)}
      />

      <UnloadDialog
        target={unloadTarget}
        placeInto={
          fillFromPrinterTarget
            ? {
                label: `${shelfLabel(currentNode, fillFromPrinterTarget.shelf)} · Slot ${fillFromPrinterTarget.slot + 1}`,
              }
            : null
        }
        onClose={() => {
          setUnloadTarget(null)
          setFillFromPrinterTarget(null)
        }}
        onStore={(printer, slot, spool, grams, nodeId) => {
          flow.startStore(spool, printer, slot, grams, nodeId)
          setUnloadTarget(null)
        }}
        onPlace={handlePlaceFromPrinter}
      />
    </div>
  )
}

function SidebarHeader() {
  const { state } = useStore()
  return (
    <header className="flex items-center gap-3 border-b border-border px-4 py-3">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <Boxes className="h-6 w-6" />
      </div>
      <div className="min-w-0">
        <h1 className="truncate text-lg font-bold leading-tight">Filament Storage</h1>
        <p className="truncate text-xs text-muted-foreground">{state.settings.systemName}</p>
      </div>
    </header>
  )
}

