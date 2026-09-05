"use client"

import { useState } from "react"
import {
  ScanLine,
  Nfc,
  QrCode as QrCodeIcon,
  PackagePlus,
  MapPin,
  Printer as PrinterIcon,
  Server,
  Package,
  Boxes,
  ArrowLeft,
  ArrowLeftRight,
  HandMetal,
  Wand2,
  Link2,
  Link2Off,
  CheckCircle2,
  AlertTriangle,
  Save,
  Trash2,
} from "lucide-react"
import { useStore } from "@/lib/store"
import { shelfLabel, printerSlotLabel } from "@/lib/selectors"
import { nodeSlotCount, nodesForSystem } from "@/lib/selectors"
import { bestNodeSlot, containerWeight } from "@/lib/balance"
import { printerSlotCount } from "@/lib/filament"
import { newId, spoolFill } from "@/lib/filament"
import { nfcSupported } from "@/lib/nfc"
import {
  findBinding,
  describeTarget,
  locateSpool,
  getPrinter,
  getNode,
} from "@/lib/tags"
import type { Spool, TagTarget, TagBindingVia } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "./ui/button"
import { SpoolDisc, discColor2 } from "./spool"
import { SpoolForm, emptyDraft, draftToSpoolFields, type SpoolDraft } from "./spool-form"
import { TagScanner } from "./tag-scanner"

/** Discriminated view state for the scan flow machine. */
type View =
  | { v: "home" }
  | { v: "unbound"; id: string; rebind?: boolean }
  | { v: "create-spool"; id: string }
  | { v: "place-choice"; id: string; spoolId: string }
  | { v: "bind-node"; id: string; rebind?: boolean }
  | { v: "bind-shelf"; id: string; nodeId: string; rebind?: boolean }
  | { v: "bind-printer"; id: string; rebind?: boolean }
  | { v: "bind-printer-slot"; id: string; printerId: string; rebind?: boolean }
  | { v: "spool-actions"; id: string; spoolId: string }
  | { v: "move-printer"; id: string; spoolId: string }
  | { v: "move-printer-slot"; id: string; spoolId: string; printerId: string }
  | { v: "shelf"; nodeId: string; shelf: number; pickFor?: string; tagId?: string }
  | { v: "printer-slot"; id: string; printerId: string; slot: number }
  | { v: "result"; kind: "success" | "error"; text: string }

/** What a pending scan is being used for. */
type ScanPurpose =
  | { kind: "primary" }
  | { kind: "location-for-spool"; spoolId: string }

export function ScanView() {
  const { state, dispatch } = useStore()
  const [view, setView] = useState<View>({ v: "home" })
  const [scan, setScan] = useState<ScanPurpose | null>(null)
  const [draft, setDraft] = useState<SpoolDraft>(emptyDraft())

  const via: TagBindingVia = nfcSupported() ? "nfc" : "qr"
  const containers = state.settings.containers ?? []

  function go(next: View) {
    setView(next)
  }

  function bindTag(id: string, target: TagTarget) {
    dispatch({ type: "BIND_TAG", binding: { id, target, boundAt: Date.now(), via } })
  }

  /** Clear a spool from wherever it currently sits (storage slot or printer). */
  function clearCurrent(spoolId: string) {
    const prev = locateSpool(state, spoolId)
    if (prev.kind === "storage") {
      dispatch({ type: "SET_STORAGE_SLOT", nodeId: prev.nodeId, shelf: prev.shelf, slot: prev.slot, spoolId: null })
    } else if (prev.kind === "printer") {
      dispatch({ type: "SET_PRINTER_SLOT", printerId: prev.printerId, slot: prev.slot, spoolId: null })
    }
  }

  function relocateToStorage(spoolId: string, nodeId: string, shelf: number, slot: number) {
    clearCurrent(spoolId)
    dispatch({ type: "SET_STORAGE_SLOT", nodeId, shelf, slot, spoolId })
  }

  function loadToPrinter(spoolId: string, printerId: string, slot: number) {
    clearCurrent(spoolId)
    dispatch({ type: "SET_PRINTER_SLOT", printerId, slot, spoolId })
  }

  // -------- Scan resolution --------
  function onScan(id: string) {
    const purpose = scan
    setScan(null)

    // Scanning a location for a spool we're placing/moving.
    if (purpose?.kind === "location-for-spool") {
      const binding = findBinding(state, id)
      if (!binding || binding.target.kind !== "shelf") {
        go({
          v: "result",
          kind: "error",
          text: "That tag isn't a storage place. Scan a tag that's bound to a shelf or unit (bind one first under Settings or the Scan tab).",
        })
        return
      }
      const node = getNode(state, binding.target.nodeId)
      if (!node) {
        go({ v: "result", kind: "error", text: "That storage tag points at a unit that no longer exists." })
        return
      }
      go({ v: "shelf", nodeId: binding.target.nodeId, shelf: binding.target.shelf, pickFor: purpose.spoolId })
      return
    }

    // Primary scan: route by whatever the tag is bound to.
    const binding = findBinding(state, id)
    if (!binding) {
      go({ v: "unbound", id })
      return
    }
    switch (binding.target.kind) {
      case "spool":
        go({ v: "spool-actions", id, spoolId: binding.target.spoolId })
        break
      case "shelf":
        go({ v: "shelf", nodeId: binding.target.nodeId, shelf: binding.target.shelf, tagId: id })
        break
      case "printerSlot":
        go({ v: "printer-slot", id, printerId: binding.target.printerId, slot: binding.target.slot })
        break
    }
  }

  // ============================ RENDER ============================
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 py-6 sm:py-8">
      <Header />

      {view.v === "home" && <HomeCard onScan={() => setScan({ kind: "primary" })} />}

      {view.v === "unbound" && (
        <UnboundCard
          onCreateSpool={() => {
            setDraft(emptyDraft(state.settings.defaultSpoolWeight, state.settings.defaultDiameter))
            go({ v: "create-spool", id: view.id })
          }}
          onBindLocation={() => go({ v: "bind-node", id: view.id, rebind: view.rebind })}
          onBindPrinter={() => go({ v: "bind-printer", id: view.id, rebind: view.rebind })}
          onCancel={() => go({ v: "home" })}
          rebind={view.rebind}
        />
      )}

      {view.v === "create-spool" && (
        <Panel
          title="Set up a new spool"
          subtitle="Fill in the filament, then choose where to store it."
          onBack={() => go({ v: "unbound", id: view.id })}
        >
          <SpoolForm value={draft} onChange={setDraft} showProfiles showBarcode />
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => go({ v: "home" })}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                // Bind to the just-scanned tag: its id wins over any draft QR
                // (this flow has no QR block, but keep the override explicit).
                const spool: Spool = { id: newId("spool"), createdAt: Date.now(), ...draftToSpoolFields(draft), tagId: view.id }
                dispatch({ type: "UPSERT_SPOOL", spool })
                bindTag(view.id, { kind: "spool", spoolId: spool.id })
                go({ v: "place-choice", id: view.id, spoolId: spool.id })
              }}
            >
              <PackagePlus className="h-4 w-4" /> Create spool
            </Button>
          </div>
        </Panel>
      )}

      {view.v === "place-choice" && (
        <Panel
          title="Where should it go?"
          subtitle="Scan a storage-place tag, or let the system pick a balanced slot."
          onBack={() => go({ v: "home" })}
        >
          <SpoolSummaryCard spool={state.spools[view.spoolId]} />
          <div className="mt-4 flex flex-col gap-2">
            <Button size="lg" className="justify-start" onClick={() => setScan({ kind: "location-for-spool", spoolId: view.spoolId })}>
              <QrCodeIcon className="h-5 w-5" /> Scan a storage place
            </Button>
            <Button
              size="lg"
              variant="secondary"
              className="justify-start"
              onClick={() => {
                const spool = state.spools[view.spoolId]
                if (!spool) return
                const weight = spool.grams + containerWeight(spool.containerId, containers)
                // Filament units only — a spool must never auto-place into a hardware rack.
                const place = bestNodeSlot(nodesForSystem(state, "filament"), state.spools, weight, [], containers)
                if (!place) {
                  go({ v: "result", kind: "error", text: "Every filament unit is full. Free a slot or add a unit, then try again." })
                  return
                }
                dispatch({ type: "SET_STORAGE_SLOT", ...place, spoolId: view.spoolId })
                const node = getNode(state, place.nodeId)
                go({
                  v: "result",
                  kind: "success",
                  text: `Placed ${spool.material} ${spool.colorName} in ${node?.name ?? "storage"} · ${node ? locLabel(node, place.shelf, place.slot) : ""}.`,
                })
              }}
            >
              <Wand2 className="h-5 w-5" /> Pick a location automatically
            </Button>
            <Button variant="ghost" className="justify-start" onClick={() => go({ v: "home" })}>
              Skip for now
            </Button>
          </div>
        </Panel>
      )}

      {view.v === "bind-node" && (
        <Panel
          title="Bind tag to a storage place"
          subtitle="Which storage unit does this tag represent?"
          onBack={() => go({ v: "unbound", id: view.id, rebind: view.rebind })}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {nodesForSystem(state, "filament").map((n) => {
              const type = n.type ?? "paternoster"
              const multiShelf = n.slots.length > 1 && type !== "library"
              const Icon = type === "library" ? Boxes : type === "shelf" ? Package : Server
              return (
                <NodeButton
                  key={n.id}
                  icon={<Icon className="h-4 w-4 text-primary" />}
                  title={n.name}
                  sub={`${type === "library" ? "Library" : type === "shelf" ? "Shelf" : "Paternoster"} · ${nodeSlotCount(n)} slots`}
                  onClick={() =>
                    multiShelf
                      ? go({ v: "bind-shelf", id: view.id, nodeId: n.id, rebind: view.rebind })
                      : commitShelfBind(n.id, 0)
                  }
                />
              )
            })}
          </div>
        </Panel>
      )}

      {view.v === "bind-shelf" && (() => {
        const node = getNode(state, view.nodeId)
        if (!node) return null
        return (
          <Panel
            title="Which shelf?"
            subtitle={`Pick the shelf on ${node.name} this tag should represent.`}
            onBack={() => go({ v: "bind-node", id: view.id, rebind: view.rebind })}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {node.slots.map((_row, shelf) => (
                <NodeButton
                  key={shelf}
                  icon={<MapPin className="h-4 w-4 text-primary" />}
                  title={shelfLabel(node, shelf)}
                  sub={`${node.slots[shelf].length} slots`}
                  onClick={() => commitShelfBind(node.id, shelf)}
                />
              ))}
            </div>
          </Panel>
        )
      })()}

      {view.v === "bind-printer" && (
        <Panel
          title="Bind tag to a printer"
          subtitle="Which printer does this tag represent?"
          onBack={() => go({ v: "unbound", id: view.id, rebind: view.rebind })}
        >
          {state.printers.length === 0 ? (
            <EmptyNote text="No printers set up yet. Add one under Settings first." />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {state.printers.map((p) => (
                <NodeButton
                  key={p.id}
                  icon={<PrinterIcon className="h-4 w-4 text-primary" />}
                  title={p.name}
                  sub={`${printerSlotCount(p)} slot${printerSlotCount(p) === 1 ? "" : "s"}`}
                  onClick={() => go({ v: "bind-printer-slot", id: view.id, printerId: p.id, rebind: view.rebind })}
                />
              ))}
            </div>
          )}
        </Panel>
      )}

      {view.v === "bind-printer-slot" && (() => {
        const printer = getPrinter(state, view.printerId)
        if (!printer) return null
        const count = printerSlotCount(printer)
        return (
          <Panel
            title="Which slot?"
            subtitle={`Pick the slot / toolhead on ${printer.name} for this tag.`}
            onBack={() => go({ v: "bind-printer", id: view.id, rebind: view.rebind })}
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Array.from({ length: count }, (_, slot) => (
                <NodeButton
                  key={slot}
                  icon={<PrinterIcon className="h-4 w-4 text-primary" />}
                  title={printerSlotLabel(printer, slot)}
                  sub={printer.loaded[slot] ? "occupied" : "empty"}
                  onClick={() => {
                    bindTag(view.id, { kind: "printerSlot", printerId: printer.id, slot })
                    go({
                      v: "result",
                      kind: "success",
                      text: `Tag bound to ${printer.name} · slot ${printerSlotLabel(printer, slot)}.`,
                    })
                  }}
                />
              ))}
            </div>
          </Panel>
        )
      })()}

      {view.v === "spool-actions" && (() => {
        const spool = state.spools[view.spoolId]
        if (!spool) {
          return (
            <Panel title="Spool not found" subtitle="This tag points at a spool that was deleted." onBack={() => go({ v: "home" })}>
              <TagControls id={view.id} onRebind={() => go({ v: "unbound", id: view.id, rebind: true })} onErase={() => eraseTag(view.id)} />
            </Panel>
          )
        }
        const place = locateSpool(state, spool.id)
        const canLoad = state.printers.some((p) => p.loaded.some((s) => s === null) || printerSlotCount(p) > p.loaded.filter(Boolean).length)
        return (
          <Panel title="What do you want to do?" subtitle={placeLabel(state, place)} onBack={() => go({ v: "home" })}>
            <SpoolSummaryCard spool={spool} />
            <div className="mt-4 flex flex-col gap-2">
              <Button size="lg" className="justify-start" onClick={() => setScan({ kind: "location-for-spool", spoolId: spool.id })}>
                <QrCodeIcon className="h-5 w-5" /> Move — scan a storage place
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="justify-start"
                onClick={() => {
                  const weight = spool.grams + containerWeight(spool.containerId, containers)
                  // Reserve the spool's own current slot so it isn't "found" as free.
                  const place2 = bestNodeSlot(nodesForSystem(state, "filament"), state.spools, weight, [], containers)
                  if (!place2) {
                    go({ v: "result", kind: "error", text: "Every filament unit is full." })
                    return
                  }
                  relocateToStorage(spool.id, place2.nodeId, place2.shelf, place2.slot)
                  const node = getNode(state, place2.nodeId)
                  go({ v: "result", kind: "success", text: `Moved to ${node?.name ?? "storage"} · ${node ? locLabel(node, place2.shelf, place2.slot) : ""}.` })
                }}
              >
                <ArrowLeftRight className="h-5 w-5" /> Move — pick a location automatically
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="justify-start"
                disabled={state.printers.length === 0}
                onClick={() => go({ v: "move-printer", id: view.id, spoolId: spool.id })}
              >
                <PrinterIcon className="h-5 w-5" /> Move to a printer
              </Button>
              <Button
                size="lg"
                variant="secondary"
                className="justify-start"
                disabled={place.kind === "none"}
                onClick={() => {
                  clearCurrent(spool.id)
                  go({ v: "result", kind: "success", text: `${spool.material} ${spool.colorName} taken out. It's now in your hand.` })
                }}
              >
                <HandMetal className="h-5 w-5" /> Take out
              </Button>
              <TagControls id={view.id} onRebind={() => go({ v: "unbound", id: view.id, rebind: true })} onErase={() => eraseTag(view.id)} />
            </div>
          </Panel>
        )
      })()}

      {view.v === "move-printer" && (
        <Panel title="Move to which printer?" onBack={() => go({ v: "spool-actions", id: view.id, spoolId: view.spoolId })}>
          <div className="grid gap-2 sm:grid-cols-2">
            {state.printers.map((p) => (
              <NodeButton
                key={p.id}
                icon={<PrinterIcon className="h-4 w-4 text-primary" />}
                title={p.name}
                sub={`${printerSlotCount(p)} slot${printerSlotCount(p) === 1 ? "" : "s"}`}
                onClick={() => go({ v: "move-printer-slot", id: view.id, spoolId: view.spoolId, printerId: p.id })}
              />
            ))}
          </div>
        </Panel>
      )}

      {view.v === "move-printer-slot" && (() => {
        const printer = getPrinter(state, view.printerId)
        if (!printer) return null
        const count = printerSlotCount(printer)
        return (
          <Panel title="Which slot?" subtitle={printer.name} onBack={() => go({ v: "move-printer", id: view.id, spoolId: view.spoolId })}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Array.from({ length: count }, (_, slot) => {
                const occupied = !!printer.loaded[slot]
                return (
                  <NodeButton
                    key={slot}
                    icon={<PrinterIcon className="h-4 w-4 text-primary" />}
                    title={printerSlotLabel(printer, slot)}
                    sub={occupied ? "occupied" : "empty"}
                    disabled={occupied}
                    onClick={() => {
                      loadToPrinter(view.spoolId, printer.id, slot)
                      const spool = state.spools[view.spoolId]
                      go({ v: "result", kind: "success", text: `Loaded ${spool?.material ?? "spool"} onto ${printer.name} · ${printerSlotLabel(printer, slot)}.` })
                    }}
                  />
                )
              })}
            </div>
          </Panel>
        )
      })()}

      {view.v === "shelf" && (() => {
        const node = getNode(state, view.nodeId)
        if (!node) return null
        return (
          <Panel
            title={view.pickFor ? "Pick a slot" : shelfLabel(node, view.shelf)}
            subtitle={
              view.pickFor
                ? `Tap where you placed it on ${node.name} · ${shelfLabel(node, view.shelf)}.`
                : `${node.name} · what's on this shelf`
            }
            onBack={() => go({ v: "home" })}
          >
            <ShelfContents
              nodeId={node.id}
              shelf={view.shelf}
              pickFor={view.pickFor}
              onPick={(slot) => {
                if (!view.pickFor) return
                relocateToStorage(view.pickFor, node.id, view.shelf, slot)
                const spool = state.spools[view.pickFor]
                go({ v: "result", kind: "success", text: `Placed ${spool?.material ?? "spool"} in ${node.name} · ${locLabel(node, view.shelf, slot)}.` })
              }}
            />
            {view.tagId && !view.pickFor && (
              <div className="mt-4">
                <TagControls id={view.tagId} onRebind={() => go({ v: "unbound", id: view.tagId!, rebind: true })} onErase={() => eraseTag(view.tagId!)} />
              </div>
            )}
          </Panel>
        )
      })()}

      {view.v === "printer-slot" && (() => {
        const printer = getPrinter(state, view.printerId)
        if (!printer) return null
        const loadedId = printer.loaded[view.slot]
        const spool = loadedId ? state.spools[loadedId] : undefined
        return (
          <Panel title={`${printer.name} · ${printerSlotLabel(printer, view.slot)}`} subtitle="Printer slot" onBack={() => go({ v: "home" })}>
            {spool ? (
              <SpoolSummaryCard spool={spool} />
            ) : (
              <EmptyNote text="This slot is currently empty." />
            )}
            <div className="mt-4">
              <TagControls id={view.id} onRebind={() => go({ v: "unbound", id: view.id, rebind: true })} onErase={() => eraseTag(view.id)} />
            </div>
          </Panel>
        )
      })()}

      {view.v === "result" && (
        <ResultCard kind={view.kind} text={view.text} onDone={() => go({ v: "home" })} onScanAgain={() => { go({ v: "home" }); setScan({ kind: "primary" }) }} />
      )}

      <TagScanner
        open={scan !== null}
        title={scan?.kind === "location-for-spool" ? "Scan a storage place" : "Scan a tag"}
        description={
          scan?.kind === "location-for-spool"
            ? "Scan the tag bound to the shelf or unit where this spool goes."
            : "Tap an RFID tag or point the camera at a QR code."
        }
        onScan={onScan}
        onClose={() => setScan(null)}
      />
    </div>
  )

  // -------- inline helpers that need closure over state/dispatch --------
  function commitShelfBind(nodeId: string, shelf: number) {
    const node = getNode(state, nodeId)
    if (view.v !== "bind-shelf" && view.v !== "bind-node") return
    const id = view.id
    bindTag(id, { kind: "shelf", nodeId, shelf })
    const label = node ? (node.slots.length > 1 && (node.type ?? "paternoster") !== "library" ? `${node.name} · ${shelfLabel(node, shelf)}` : node.name) : "storage"
    go({ v: "result", kind: "success", text: `Tag bound to ${label}. Scan it any time to see what's stored there.` })
  }

  function eraseTag(id: string) {
    dispatch({ type: "UNBIND_TAG", id })
    go({ v: "result", kind: "success", text: "Tag erased. It's now blank and ready to be reused." })
  }
}

/* ------------------------------- sub-views ------------------------------- */

function Header() {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <ScanLine className="h-6 w-6" />
      </span>
      <div>
        <h1 className="text-xl font-semibold leading-tight">Scan</h1>
        <p className="text-sm text-muted-foreground">Track spools and places with RFID tags and QR codes.</p>
      </div>
    </div>
  )
}

function HomeCard({ onScan }: { onScan: () => void }) {
  const nfc = nfcSupported()
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 rounded-2xl border border-border bg-card px-6 py-12 text-center">
      <button
        type="button"
        onClick={onScan}
        className="group flex h-40 w-40 flex-col items-center justify-center gap-2 rounded-full border-2 border-primary/40 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
        aria-label="Scan a tag"
      >
        <ScanLine className="h-14 w-14 transition-transform group-hover:scale-105" />
        <span className="text-sm font-semibold">Scan a tag</span>
      </button>
      <div className="max-w-sm space-y-2 text-sm text-muted-foreground text-pretty">
        <p>Scan an RFID tag or QR code to set up a new spool, bind a storage place, or move a spool you already tagged.</p>
        <p className="flex items-center justify-center gap-2 text-xs">
          {nfc ? (
            <>
              <Nfc className="h-3.5 w-3.5 text-primary" /> NFC + QR available on this device
            </>
          ) : (
            <>
              <QrCodeIcon className="h-3.5 w-3.5 text-primary" /> QR + manual entry available (NFC needs Android Chrome)
            </>
          )}
        </p>
      </div>
    </div>
  )
}

function UnboundCard({
  onCreateSpool,
  onBindLocation,
  onBindPrinter,
  onCancel,
  rebind,
}: {
  onCreateSpool: () => void
  onBindLocation: () => void
  onBindPrinter: () => void
  onCancel: () => void
  rebind?: boolean
}) {
  return (
    <Panel
      title={rebind ? "Rebind this tag" : "New tag"}
      subtitle={rebind ? "Choose what this tag should point at now." : "This tag is blank. What should it represent?"}
      onBack={onCancel}
    >
      <div className="flex flex-col gap-2">
        <BigChoice icon={<PackagePlus className="h-5 w-5" />} title="Set up a new spool" sub="Create a filament spool and bind this tag to it." onClick={onCreateSpool} />
        <BigChoice icon={<MapPin className="h-5 w-5" />} title="Bind to a storage place" sub="Represent a shelf or unit — scan it later to see its contents." onClick={onBindLocation} />
        <BigChoice icon={<PrinterIcon className="h-5 w-5" />} title="Bind to a printer slot" sub="Represent a toolhead or AMS slot on a printer." onClick={onBindPrinter} />
      </div>
    </Panel>
  )
}

function Panel({
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string
  subtitle?: string
  onBack?: () => void
  children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-4 flex items-start gap-3">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold leading-tight text-pretty">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-muted-foreground text-pretty">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  )
}

function BigChoice({ icon, title, sub, onClick }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 rounded-xl border border-border bg-background/50 p-4 text-left transition-colors hover:border-primary/60"
    >
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground text-pretty">{sub}</span>
      </span>
    </button>
  )
}

function NodeButton({ icon, title, sub, onClick, disabled }: { icon: React.ReactNode; title: string; sub?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-start gap-2 rounded-xl border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/60 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        {sub && <span className="block text-xs text-muted-foreground">{sub}</span>}
      </span>
    </button>
  )
}

function TagControls({ id, onRebind, onErase }: { id: string; onRebind: () => void; onErase: () => void }) {
  return (
    <div className="mt-1 flex gap-2 border-t border-border pt-3">
      <Button variant="outline" className="flex-1" onClick={onRebind}>
        <Link2 className="h-4 w-4" /> Rebind
      </Button>
      <Button
        variant="destructive"
        className="flex-1"
        onClick={() => {
          if (confirm("Erase this tag? Its binding is removed and the tag can be reused.")) onErase()
        }}
      >
        <Link2Off className="h-4 w-4" /> Erase tag
      </Button>
    </div>
  )
}

function SpoolSummaryCard({ spool }: { spool?: Spool }) {
  if (!spool) return null
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-background/50 p-3">
      <SpoolDisc color={spool.color} color2={discColor2(spool)} size={48} fill={spoolFill(spool)} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold">
          {spool.material} · {spool.colorName}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {spool.brand} · {Math.round(spool.grams)} g
        </p>
      </div>
    </div>
  )
}

/** Slot grid for a shelf; taps on empty slots call onPick when picking. */
function ShelfContents({ nodeId, shelf, pickFor, onPick }: { nodeId: string; shelf: number; pickFor?: string; onPick: (slot: number) => void }) {
  const { state } = useStore()
  const node = getNode(state, nodeId)
  if (!node) return null
  const isLibrary = (node.type ?? "paternoster") === "library"
  const row = node.slots[shelf] ?? []

  if (isLibrary) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {row.map((id, i) => {
            const spool = id ? state.spools[id] : undefined
            if (!spool) return null
            return <SpoolSummaryCard key={`${id}-${i}`} spool={spool} />
          })}
          {row.filter(Boolean).length === 0 && <EmptyNote text="Nothing stored here yet." />}
        </div>
        {pickFor && (
          <Button className="w-full" onClick={() => onPick(row.length)}>
            <PackagePlus className="h-4 w-4" /> Place here
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {row.map((id, slot) => {
        const spool = id ? state.spools[id] : undefined
        const selectable = pickFor && !spool
        return (
          <button
            key={slot}
            type="button"
            disabled={!selectable}
            onClick={() => selectable && onPick(slot)}
            className={cn(
              "flex items-center gap-2 rounded-xl border p-2.5 text-left transition-colors",
              spool ? "border-border bg-background/50" : selectable ? "border-dashed border-primary/50 bg-primary/5 hover:border-primary" : "border-dashed border-border bg-background/30",
              !selectable && !spool && "opacity-70",
            )}
          >
            {spool ? (
              <SpoolDisc color={spool.color} color2={discColor2(spool)} size={30} fill={spoolFill(spool)} />
            ) : (
              <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-dashed border-border text-[10px] text-muted-foreground">
                {slot + 1}
              </span>
            )}
            <span className="min-w-0">
              <span className="block text-[11px] font-medium text-muted-foreground">Slot {slot + 1}</span>
              <span className="block truncate text-xs">
                {spool ? `${spool.material} · ${spool.colorName}` : selectable ? "Tap to place" : "Empty"}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed border-border bg-background/40 p-4 text-center text-sm text-muted-foreground">{text}</p>
}

function ResultCard({ kind, text, onDone, onScanAgain }: { kind: "success" | "error"; text: string; onDone: () => void; onScanAgain: () => void }) {
  const success = kind === "success"
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 rounded-2xl border border-border bg-card px-6 py-12 text-center">
      <span
        className={cn(
          "flex h-16 w-16 items-center justify-center rounded-full",
          success ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
        )}
      >
        {success ? <CheckCircle2 className="h-9 w-9" /> : <AlertTriangle className="h-9 w-9" />}
      </span>
      <p className="max-w-sm text-pretty text-sm">{text}</p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onScanAgain}>
          <ScanLine className="h-4 w-4" /> Scan another
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  )
}

/* ------------------------------- utils ------------------------------- */

function locLabel(node: ReturnType<typeof getNode>, shelf: number, slot: number): string {
  if (!node) return ""
  const isLibrary = (node.type ?? "paternoster") === "library"
  if (isLibrary) return "Library"
  return `${shelfLabel(node, shelf)} · Slot ${slot + 1}`
}

function placeLabel(state: ReturnType<typeof useStore>["state"], place: ReturnType<typeof locateSpool>): string {
  if (place.kind === "none") return "Currently not stored (in your hand)"
  if (place.kind === "storage") {
    const node = getNode(state, place.nodeId)
    return node ? `In ${node.name} · ${locLabel(node, place.shelf, place.slot)}` : "In storage"
  }
  const printer = getPrinter(state, place.printerId)
  return printer ? `Loaded on ${printer.name} · ${printerSlotLabel(printer, place.slot)}` : "On a printer"
}
