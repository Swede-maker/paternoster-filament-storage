"use client"

import { useEffect, useState } from "react"
import {
  Plus,
  Printer as PrinterIcon,
  Pencil,
  Trash2,
  Wifi,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStore } from "@/lib/store"
import { useFlow } from "@/components/flow-controller"
import { usePersistentBoolean } from "@/lib/use-persistent"
import { AddPrinterDialog } from "@/components/add-printer-dialog"
import { PrinterLoadedSpools } from "@/components/printer-panel"
import { PrinterEmbed, printerWebUrl } from "./printer-embed"
import { PrinterApiPanel } from "./printer-api-panel"
import { DispenseQueue } from "./dispense-queue"
import type { Printer } from "@/lib/types"
import { cn } from "@/lib/utils"

function firmwareLabel(p: Printer): string {
  switch (p.firmware) {
    case "klipper":
      return "Klipper / Moonraker"
    case "prusalink":
      return "PrusaLink"
    case "bambu":
      return "Bambu Lab"
    default:
      return "Printer"
  }
}

/** Selectable printer entry in the left rail. */
function PrinterCard({
  printer,
  active,
  onSelect,
  onEdit,
  onRemove,
}: {
  printer: Printer
  active: boolean
  onSelect: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const addr = printerWebUrl(printer)
  return (
    <div
      className={cn(
        "group rounded-xl border p-3 transition-colors",
        active ? "border-primary bg-primary/10" : "border-border bg-card/60 hover:bg-card",
      )}
    >
      <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 text-left">
        <span
          className={cn(
            "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
            active ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground",
          )}
        >
          <PrinterIcon className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{printer.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{firmwareLabel(printer)}</span>
          {addr && (
            <span className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground">
              <Wifi className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{addr.replace(/^https?:\/\//, "")}</span>
            </span>
          )}
        </span>
      </button>
      <div className="mt-2 flex items-center gap-1 border-t border-border/60 pt-2">
        <Button size="sm" variant="ghost" className="flex-1" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
        <Button size="sm" variant="ghost" className="flex-1 text-destructive hover:text-destructive" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </Button>
      </div>
    </div>
  )
}

/**
 * Collapsed left rail: one icon button per printer so switching still works
 * while the embed has the full width.
 */
function PrinterRailCollapsed({
  printers,
  selectedId,
  onSelect,
  onExpand,
}: {
  printers: Printer[]
  selectedId: string | null
  onSelect: (id: string) => void
  onExpand: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onExpand}
        aria-label="Show printer list"
        title="Show printer list"
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card/60 text-muted-foreground transition-colors hover:text-foreground"
      >
        <PanelLeftOpen className="h-4 w-4" />
      </button>
      {printers.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSelect(p.id)}
          aria-label={p.name}
          title={p.name}
          aria-pressed={p.id === selectedId}
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-xl border transition-colors",
            p.id === selectedId
              ? "border-primary bg-primary/15 text-primary"
              : "border-border bg-card/60 text-muted-foreground hover:text-foreground",
          )}
        >
          <PrinterIcon className="h-5 w-5" />
        </button>
      ))}
    </div>
  )
}

/**
 * The Printers section: manage 3D printers by IP, embed each printer's own web
 * UI so you never leave PAX, show what's loaded on it (tap a slot to pick a
 * spool or take one off), and expose the LAN API + dispense queue that let a
 * printer read spools and request a filament dispense from the paternoster.
 */
export function PrintersView({ onGoFilament }: { onGoFilament: () => void }) {
  const { state, dispatch } = useStore()
  const flow = useFlow()
  const printers = state.printers
  const [selectedId, setSelectedId] = useState<string | null>(printers[0]?.id ?? null)
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<Printer | null>(null)
  // Fold the printer list away to give the embedded UI the whole width.
  const [railOpen, setRailOpen] = usePersistentBoolean("pax:printers:railOpen", true)
  // Fold the loaded-spool grid under the embed.
  const [spoolsOpen, setSpoolsOpen] = usePersistentBoolean("pax:printers:spoolsOpen", true)
  // Fold the API + dispense-queue cards below the embed.
  const [apiOpen, setApiOpen] = usePersistentBoolean("pax:printers:apiOpen", true)
  const [queueOpen, setQueueOpen] = usePersistentBoolean("pax:printers:queueOpen", true)

  // Keep a valid selection as printers are added/removed.
  useEffect(() => {
    if (printers.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !printers.some((p) => p.id === selectedId)) {
      setSelectedId(printers[0].id)
    }
  }, [printers, selectedId])

  const selected = printers.find((p) => p.id === selectedId) ?? null

  const openAdd = () => {
    setEditing(null)
    setAddOpen(true)
  }
  const openEdit = (p: Printer) => {
    setEditing(p)
    setAddOpen(true)
  }
  const remove = (p: Printer) => {
    if (typeof window !== "undefined" && !window.confirm(`Remove "${p.name}"? This only unlinks it from PAX.`)) return
    dispatch({ type: "REMOVE_PRINTER", id: p.id })
  }

  // The pick/take-off dialogs and the carousel motion live in the Filament
  // home, so a slot tap here hands the request over and switches area.
  function handleSlot(p: Printer, slot: number) {
    flow.requestSlot(p.id, slot)
    onGoFilament()
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Printers</h1>
          <p className="text-sm text-muted-foreground text-pretty">
            Add a 3D printer by IP to view its interface here and let it pull filament from your paternoster.
          </p>
        </div>
        <Button onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add printer UI
        </Button>
      </header>

      {printers.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
            <PrinterIcon className="h-7 w-7" />
          </span>
          <div className="max-w-md">
            <h2 className="text-base font-semibold text-foreground">No printers yet</h2>
            <p className="mt-1 text-sm text-muted-foreground text-pretty">
              Enter a printer&apos;s local IP address (a Klipper/Moonraker, PrusaLink, or Bambu unit). PAX embeds its
              standalone UI and exposes an API so the printer can request spools.
            </p>
          </div>
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4" /> Add printer UI
          </Button>
        </div>
      ) : (
        <div className={cn("grid gap-4", railOpen ? "lg:grid-cols-[300px_1fr]" : "lg:grid-cols-[40px_1fr]")}>
          {/* Left rail: printer list (or a thin icon strip when folded) */}
          {railOpen ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {printers.length} {printers.length === 1 ? "printer" : "printers"}
                </span>
                <button
                  type="button"
                  onClick={() => setRailOpen(false)}
                  aria-label="Hide printer list"
                  title="Hide printer list"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              </div>
              {printers.map((p) => (
                <PrinterCard
                  key={p.id}
                  printer={p}
                  active={p.id === selectedId}
                  onSelect={() => setSelectedId(p.id)}
                  onEdit={() => openEdit(p)}
                  onRemove={() => remove(p)}
                />
              ))}
            </div>
          ) : (
            <PrinterRailCollapsed
              printers={printers}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onExpand={() => setRailOpen(true)}
            />
          )}

          {/* Right: embedded UI + loaded spools for the selected printer. The
              embed fills the viewport height so the printer's own UI is usable
              without scrolling; the lower panels sit below the fold. */}
          <div className="flex min-h-[70vh] flex-col gap-3 rounded-2xl border border-border bg-card/40 p-4 lg:min-h-[calc(100dvh-14rem)]">
            {selected ? (
              <>
                <div>
                  <h2 className="text-base font-semibold text-foreground">{selected.name}</h2>
                  <p className="text-xs text-muted-foreground">{firmwareLabel(selected)}</p>
                </div>
                <div className="flex min-h-[50vh] flex-1 flex-col">
                  <PrinterEmbed printer={selected} />
                </div>

                <section className="rounded-xl border border-border bg-background/40">
                  <button
                    type="button"
                    onClick={() => setSpoolsOpen((v) => !v)}
                    aria-expanded={spoolsOpen}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
                  >
                    <span>
                      <span className="text-sm font-semibold text-foreground">Loaded spools</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        Tap an empty slot to pick from storage, a loaded one to take it off.
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                        spoolsOpen ? "rotate-180" : "rotate-0",
                      )}
                    />
                  </button>
                  {spoolsOpen && (
                    <div className="border-t border-border/60 p-3">
                      <PrinterLoadedSpools
                        key={selected.id}
                        printer={selected}
                        onSlot={handleSlot}
                        queuedPrinterSlots={flow.queuedPrinterSlots(selected.id)}
                      />
                    </div>
                  )}
                </section>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Select a printer to view its interface.
              </div>
            )}
          </div>
        </div>
      )}

      {/* API + dispense queue span the full width below; each folds away. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <PrinterApiPanel open={apiOpen} onToggle={() => setApiOpen((v) => !v)} />
        <DispenseQueue open={queueOpen} onToggle={() => setQueueOpen((v) => !v)} />
      </div>

      <AddPrinterDialog open={addOpen} onClose={() => setAddOpen(false)} printer={editing ?? undefined} />
    </div>
  )
}
