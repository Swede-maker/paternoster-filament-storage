"use client"

import { useState } from "react"
import useSWR from "swr"
import { Plus, Trash2, Printer as PrinterIcon, Wifi, WifiOff, Loader2, Flame } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { activePrinter } from "@/lib/selectors"
import { isLightColor, formatRemaining, spoolFill } from "@/lib/filament"
import { klipperHeaterName } from "@/lib/printer-commands"
import { fetchMoonrakerStatus, isKlipperLinked, type MoonrakerStatus } from "@/lib/moonraker"
import { Button } from "./ui/button"
import { Input } from "./ui/field"
import { AmsUnit, Toolhead } from "./ams-unit"
import { SpoolDisc } from "./spool"
import { AddPrinterDialog } from "./add-printer-dialog"
import type { Printer, Spool } from "@/lib/types"

export function PrinterPanel({
  onLoadSlot,
  onUnloadSlot,
  queuedPrinterSlots,
}: {
  /** Called when an EMPTY printer slot is tapped (start a pick into it). */
  onLoadSlot: (printer: Printer, slotIndex: number) => void
  /** Called when a LOADED printer slot is tapped (store/delete it). */
  onUnloadSlot: (printer: Printer, slotIndex: number, spool: Spool) => void
  /** Printer slot indexes already queued for the active printer. */
  queuedPrinterSlots?: number[]
}) {
  const { state, dispatch } = useStore()
  const [addOpen, setAddOpen] = useState(false)
  const printer = activePrinter(state)

  function handleSlot(p: Printer, index: number) {
    const id = p.loaded[index]
    if (id && state.spools[id]) onUnloadSlot(p, index, state.spools[id])
    else onLoadSlot(p, index)
  }

  return (
    <section className="flex flex-col rounded-2xl border border-border bg-card p-4 lg:min-h-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">AMS / Toolchanger Status</h2>
        <div className="flex items-center gap-2">
          {/* Printer selector */}
          <div className="flex max-w-full items-center gap-1 overflow-x-auto scrollbar-thin">
            {state.printers.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => dispatch({ type: "SET_ACTIVE_PRINTER", id: p.id })}
                className={cn(
                  "shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
                  p.id === state.activePrinterId
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {p.name}
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Add printer
          </Button>
        </div>
      </div>

      {!printer ? (
        <EmptyPrinterState onAdd={() => setAddOpen(true)} />
      ) : (
        <PrinterCard
          key={printer.id}
          printer={printer}
          spools={state.spools}
          onSlot={handleSlot}
          onRemove={() => {
            if (confirm(`Remove "${printer.name}"? Spools loaded on it will be discarded.`)) {
              dispatch({ type: "REMOVE_PRINTER", id: printer.id })
            }
          }}
          queuedPrinterSlots={queuedPrinterSlots}
        />
      )}

      <AddPrinterDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </section>
  )
}

/**
 * Poll a Klipper printer's live status/temps via the Moonraker proxy. Disabled
 * (returns undefined) for printers that aren't a Klipper machine with an IP.
 */
function useMoonrakerLive(printer: Printer): MoonrakerStatus | undefined {
  const enabled = isKlipperLinked(printer)
  const { data } = useSWR<MoonrakerStatus>(
    enabled ? ["moonraker", printer.id, printer.ip, printer.port] : null,
    () => fetchMoonrakerStatus(printer),
    { refreshInterval: 3000, revalidateOnFocus: false, dedupingInterval: 2000 },
  )
  return enabled ? data : undefined
}

/** Live reading for a given tool slot (by Klipper heater name), if available. */
function liveTempForSlot(live: MoonrakerStatus | undefined, slot: number) {
  return live?.temps?.[klipperHeaterName(slot)]
}

function PrinterCard({
  printer,
  spools,
  onSlot,
  onRemove,
  queuedPrinterSlots,
}: {
  printer: Printer
  spools: Record<string, Spool>
  onSlot: (p: Printer, index: number) => void
  onRemove: () => void
  queuedPrinterSlots?: number[]
}) {
  // Live status/temps are read-only: we poll Moonraker and display the nozzle
  // temperature the printer reports. The app never commands the heaters.
  const live = useMoonrakerLive(printer)

  return (
    <div className="lg:min-h-0 lg:flex-1 lg:overflow-auto lg:scrollbar-thin">
      <PrinterHeader printer={printer} onRemove={onRemove} />
      <PrinterLinkRow printer={printer} live={live} />
      <PrinterBody printer={printer} spools={spools} onSlot={onSlot} queuedPrinterSlots={queuedPrinterSlots} live={live} />
    </div>
  )
}

function PrinterHeader({ printer, onRemove }: { printer: Printer; onRemove: () => void }) {
  const kindLabel =
    printer.kind === "single" ? "Single Spool" : printer.kind === "ams" ? "AMS" : "Toolchanger"
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <PrinterIcon className="h-4 w-4" />
        <span className="font-medium text-foreground">{printer.name}</span>
        <span className="rounded-md bg-secondary px-2 py-0.5 text-xs">{kindLabel}</span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
      >
        <Trash2 className="h-3.5 w-3.5" /> Remove
      </button>
    </div>
  )
}

/**
 * Printer-link row. For a Klipper printer with an IP, the status is real: it
 * reflects live polling of Moonraker (`live`), including any error message.
 * Non-Klipper / unlinked printers show a neutral "not linked" hint.
 */
function PrinterLinkRow({ printer, live }: { printer: Printer; live?: MoonrakerStatus }) {
  const { dispatch } = useStore()
  const [ip, setIp] = useState(printer.ip ?? "")
  const [editing, setEditing] = useState(!printer.ip)
  const klipperLinked = isKlipperLinked(printer)

  function save() {
    const trimmed = ip.trim()
    if (!trimmed) return
    setEditing(false)
    dispatch({ type: "UPDATE_PRINTER", id: printer.id, changes: { ip: trimmed, link: "checking" } })
  }

  function unlink() {
    dispatch({ type: "UPDATE_PRINTER", id: printer.id, changes: { ip: undefined, link: "offline" } })
    setIp("")
    setEditing(true)
  }

  if (editing) {
    return (
      <div className="mb-3 flex flex-col gap-2 rounded-xl border border-border bg-background/40 p-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Wifi className="h-4 w-4" />
          <span>Link printer</span>
        </div>
        <div className="flex flex-1 items-center gap-2">
          <Input
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="Printer IP e.g. 192.168.1.50"
            inputMode="decimal"
          />
          <Button size="sm" onClick={save} disabled={!ip.trim()}>
            Connect
          </Button>
          {printer.ip && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          )}
        </div>
      </div>
    )
  }

  // Derive the display status. Real for Klipper (from live polling), otherwise
  // a neutral note since we can only actually reach Moonraker/Klipper.
  const connecting = klipperLinked && live === undefined
  const connected = klipperLinked && live?.connected === true
  const error = klipperLinked ? live?.error : undefined

  const status: "online" | "checking" | "offline" = connected ? "online" : connecting ? "checking" : "offline"
  const dot =
    status === "online" ? "bg-success" : status === "checking" ? "bg-warning animate-pulse" : "bg-muted-foreground/50"
  const StatusIcon = status === "online" ? Wifi : status === "checking" ? Loader2 : WifiOff
  const statusColor =
    status === "online" ? "text-success" : status === "checking" ? "text-warning" : "text-muted-foreground"
  const statusLabel = !klipperLinked
    ? "Linked (no live status)"
    : connected
      ? "Connected"
      : connecting
        ? "Connecting…"
        : "Not reachable"

  return (
    <div className="mb-3 flex items-center justify-between gap-2 rounded-xl border border-border bg-background/40 p-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot)} />
        <StatusIcon className={cn("h-4 w-4 shrink-0", statusColor, status === "checking" && "animate-spin")} />
        <div className="min-w-0">
          <p className={cn("text-sm font-medium", statusColor)}>{statusLabel}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {printer.ip}
            {printer.port && printer.port !== 7125 ? `:${printer.port}` : ""}
          </p>
          {error && <p className="truncate text-xs text-destructive">{error}</p>}
          {!klipperLinked && printer.firmware !== "klipper" && (
            <p className="text-xs text-muted-foreground">Live status needs a Klipper printer.</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label="Edit IP">
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={unlink}>
          Unlink
        </Button>
      </div>
    </div>
  )
}

function PrinterBody({
  printer,
  spools,
  onSlot,
  queuedPrinterSlots,
  live,
}: {
  printer: Printer
  spools: Record<string, Spool>
  onSlot: (p: Printer, index: number) => void
  queuedPrinterSlots?: number[]
  live?: MoonrakerStatus
}) {
  if (printer.kind === "single") {
    const spool = printer.loaded[0] ? spools[printer.loaded[0]!] : null
    // Single-extruder printers report their nozzle on Klipper's `extruder` (slot 0).
    const nozzle = liveTempForSlot(live, 0)
    return (
      <div className="flex items-center gap-4 rounded-xl border border-border bg-background/40 p-4">
        <button
          type="button"
          onClick={() => onSlot(printer, 0)}
          className={cn(
            "flex flex-col items-center gap-2 rounded-xl border p-3 transition-colors hover:border-primary/60",
            queuedPrinterSlots?.includes(0) ? "border-primary/60 bg-primary/10" : "border-transparent",
          )}
        >
          {spool ? <SpoolDisc color={spool.color} size={84} fill={spoolFill(spool)} /> : <EmptyDisc />}
        </button>
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Loaded spool</p>
          {spool ? (
            <SpoolMeta spool={spool} />
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">Empty — tap the spool to load one.</p>
          )}
          {nozzle && <NozzleTempChip actual={nozzle.actual} target={nozzle.target} className="mt-2" />}
        </div>
      </div>
    )
  }

  if (printer.kind === "toolchanger") {
    return (
      <div>
        <p className="mb-2 text-sm text-muted-foreground">Toolheads ({printer.toolheads})</p>
        <div className="flex flex-wrap gap-2">
          {printer.loaded.map((id, i) => (
            <Toolhead
              key={i}
              index={i}
              spool={id ? spools[id] : null}
              isQueued={queuedPrinterSlots?.includes(i)}
              onClick={() => onSlot(printer, i)}
              // Live nozzle temperature read back from the printer (display only).
              actualTemp={liveTempForSlot(live, i)?.actual ?? null}
              targetTemp={liveTempForSlot(live, i)?.target ?? null}
            />
          ))}
        </div>
      </div>
    )
  }

  // AMS: split loaded array into units.
  const units: { spool: Spool | null; globalIndex: number }[][] = []
  for (let u = 0; u < printer.amsUnits; u++) {
    const unit: { spool: Spool | null; globalIndex: number }[] = []
    for (let s = 0; s < printer.slotsPerAms; s++) {
      const globalIndex = u * printer.slotsPerAms + s
      const id = printer.loaded[globalIndex]
      unit.push({ spool: id ? spools[id] : null, globalIndex })
    }
    units.push(unit)
  }

  return (
    <div className="flex flex-wrap gap-4">
      {units.map((unit, u) => (
        <AmsUnit
          key={u}
          index={u}
          slots={unit}
          queuedSlots={queuedPrinterSlots}
          onSlotClick={(globalIndex) => onSlot(printer, globalIndex)}
        />
      ))}
    </div>
  )
}

/**
 * Read-only live nozzle temperature. Shows the actual temperature, plus the
 * target when the printer is actively heating (target > 0). The app only
 * displays what the printer reports — it never sets the temperature.
 */
function NozzleTempChip({
  actual,
  target,
  className,
}: {
  actual: number | null
  target: number | null
  className?: string
}) {
  if (actual == null) return null
  const heating = target != null && target > 0
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium tabular-nums",
        heating ? "bg-warning/15 text-warning" : "bg-secondary text-muted-foreground",
        className,
      )}
      title={heating ? `Nozzle ${Math.round(actual)}°C, heating to ${Math.round(target!)}°C` : `Nozzle ${Math.round(actual)}°C`}
    >
      <Flame className={cn("h-3 w-3", heating && "animate-pulse")} />
      {heating ? `${Math.round(actual)}→${Math.round(target!)}°C` : `${Math.round(actual)}°C`}
    </span>
  )
}

function SpoolMeta({ spool }: { spool: Spool }) {
  return (
    <div className="mt-1">
      <p className="text-lg font-semibold" style={{ color: isLightColor(spool.color) ? "#d4d4d8" : spool.color }}>
        {spool.material} · {spool.colorName}
      </p>
      <p className="text-sm text-muted-foreground">
        {spool.brand} · {formatRemaining(spool)}
      </p>
    </div>
  )
}

function EmptyDisc() {
  return (
    <div
      className="flex h-[84px] w-[84px] items-center justify-center rounded-full border border-dashed border-border bg-background/60"
      aria-hidden="true"
    >
      <Plus className="h-6 w-6 text-muted-foreground/50" />
    </div>
  )
}

function EmptyPrinterState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
        <PrinterIcon className="h-6 w-6" />
      </div>
      <div>
        <p className="font-medium">No printers yet</p>
        <p className="text-sm text-muted-foreground">Add a printer to load filament onto it.</p>
      </div>
      <Button onClick={onAdd}>
        <Plus className="h-4 w-4" /> Add printer
      </Button>
    </div>
  )
}
