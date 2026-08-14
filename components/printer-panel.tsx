"use client"

import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { Plus, Trash2, Printer as PrinterIcon, Wifi, WifiOff, Loader2, Flame } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { activePrinter } from "@/lib/selectors"
import {
  formatRemaining,
  spoolFill,
  lengthToGrams,
  spoolDensity,
  spoolDiameter,
  densityFor,
  newId,
} from "@/lib/filament"
import { klipperHeaterName } from "@/lib/printer-commands"
import { fetchMoonrakerStatus, isKlipperLinked, type MoonrakerStatus } from "@/lib/moonraker"
import { fetchBambuStatus, isBambuLinked, type BambuStatus } from "@/lib/bambu"
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

/**
 * Poll a Bambu Lab printer's AMS / RFID + print state via the /api/bambu proxy.
 * Disabled for printers that aren't a linked Bambu machine. Falls back to a
 * simulation server-side when the real printer is unreachable (preview).
 */
function useBambuLive(printer: Printer): BambuStatus | undefined {
  const enabled = isBambuLinked(printer)
  const { data } = useSWR<BambuStatus>(
    enabled ? ["bambu", printer.id, printer.ip, printer.serial] : null,
    () => fetchBambuStatus(printer),
    { refreshInterval: 4000, revalidateOnFocus: false, dedupingInterval: 3000 },
  )
  return enabled ? data : undefined
}

/**
 * Live weight tracking. Watches the printer's reported filament usage and
 * subtracts grams from *only the spool that is actually printing* — idle loaded
 * spools are never touched.
 *
 * - Klipper: `filament_used` is cumulative millimetres; each increase is
 *   converted to mass via the active spool's diameter + density and subtracted.
 *   A counter reset (new print) just re-baselines without consuming.
 * - Bambu: the active tray's remaining-% decrements are applied against the
 *   spool's full-spool capacity.
 */
function useLiveConsumption(
  printer: Printer,
  moonraker: MoonrakerStatus | undefined,
  bambu: BambuStatus | undefined,
) {
  const { state, dispatch } = useStore()
  const spools = state.spools
  const defaultDiameter = state.settings.defaultDiameter
  const prevMm = useRef<number | null>(null)
  const prevRemain = useRef<Record<number, number>>({})

  // Klipper: mm of filament → grams off the active tool's spool.
  useEffect(() => {
    if (!moonraker?.connected || typeof moonraker.filamentUsedMm !== "number") return
    const mm = moonraker.filamentUsedMm
    if (prevMm.current === null || mm < prevMm.current) {
      prevMm.current = mm // first read, or a new print reset the counter
      return
    }
    const delta = mm - prevMm.current
    prevMm.current = mm
    if (delta <= 0) return
    const slot = printer.kind === "toolchanger" ? moonraker.activeTool ?? 0 : 0
    const id = printer.loaded[slot]
    const spool = id ? spools[id] : null
    if (!spool) return
    const grams = lengthToGrams(delta, spoolDiameter(spool, defaultDiameter), spoolDensity(spool))
    if (grams > 0) dispatch({ type: "CONSUME_FILAMENT", spoolId: spool.id, grams })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moonraker])

  // Bambu: remaining-% decrements on the active tray → grams.
  useEffect(() => {
    if (!bambu?.connected) return
    for (const tray of bambu.trays) {
      if (!tray.present || typeof tray.remainPct !== "number") continue
      const prev = prevRemain.current[tray.globalIndex]
      prevRemain.current[tray.globalIndex] = tray.remainPct
      if (prev === undefined || tray.remainPct >= prev) continue
      const id = printer.loaded[tray.globalIndex]
      const spool = id ? spools[id] : null
      if (!spool) continue
      const cap = spool.capacity && spool.capacity > 0 ? spool.capacity : tray.capacityG ?? 1000
      const grams = ((prev - tray.remainPct) / 100) * cap
      if (grams > 0) dispatch({ type: "CONSUME_FILAMENT", spoolId: spool.id, grams })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bambu])
}

/**
 * Auto-create spools from Bambu AMS trays via their RFID uid and seat them in
 * the matching AMS slot, so a spool scanned by the printer can later be selected
 * and stored in the paternoster. Idempotent: a slot already holding the tray's
 * RFID spool is skipped.
 */
function useAmsRfidIngest(printer: Printer, bambu: BambuStatus | undefined) {
  const { state, dispatch } = useStore()
  const spools = state.spools
  useEffect(() => {
    if (!bambu?.connected || printer.kind !== "ams") return
    for (const tray of bambu.trays) {
      if (!tray.present || !tray.rfid) continue
      const currentId = printer.loaded[tray.globalIndex]
      const current = currentId ? spools[currentId] : null
      if (current && current.rfidUid === tray.rfid) continue // already seated

      // This tag already belongs to a spool we know about — the user physically
      // moved that spool to a new slot/AMS unit (or put it back after storing
      // it). Re-seat the SAME spool record here and refresh its live weight; the
      // reducer vacates whatever slot/storage it left, so it never ghosts or
      // duplicates. Its identity (brand/color/name) is preserved untouched. This
      // takes priority over adoption below so a stray manual spool in this slot
      // can't hijack a tag that's already assigned elsewhere.
      const known = Object.values(spools).find((s) => s.rfidUid && s.rfidUid === tray.rfid)
      if (known) {
        const cap = known.capacity && known.capacity > 0 ? known.capacity : tray.capacityG && tray.capacityG > 0 ? tray.capacityG : 1000
        const grams = typeof tray.remainPct === "number" ? Math.round((tray.remainPct / 100) * cap) : known.grams
        dispatch({ type: "INGEST_AMS_TRAY", printerId: printer.id, slot: tray.globalIndex, spool: { ...known, grams } })
        continue
      }

      // The slot already holds a spool the user picked/loaded manually (it has
      // no tag yet). Adopt it rather than replacing it: bind this tag so future
      // reads match, and refresh only the live remaining weight. The user's
      // chosen material/brand/color/name always win, so nothing is overwritten
      // or orphaned. A slot holding a *different* tagged spool falls through to
      // ingest below, since that means a tagged spool was physically swapped in.
      if (current && !current.rfidUid) {
        const changes: Partial<Spool> = { rfidUid: tray.rfid }
        if (typeof tray.remainPct === "number") {
          const cap =
            current.capacity && current.capacity > 0
              ? current.capacity
              : tray.capacityG && tray.capacityG > 0
                ? tray.capacityG
                : 1000
          changes.grams = Math.round((tray.remainPct / 100) * cap)
        }
        dispatch({ type: "UPDATE_SPOOL", id: current.id, changes })
        continue
      }

      const capacity = tray.capacityG && tray.capacityG > 0 ? tray.capacityG : 1000
      const remain = typeof tray.remainPct === "number" ? tray.remainPct : 100
      const material = tray.material || "PLA"
      const spool = {
        id: newId("spool"),
        material,
        brand: tray.brand || "Bambu",
        color: tray.color || "#8b5cf6",
        colorName: tray.colorName || `${material} ${tray.color ?? ""}`.trim(),
        grams: Math.round((remain / 100) * capacity),
        capacity,
        density: densityFor(material),
        rfidUid: tray.rfid,
        createdAt: Date.now(),
      }
      dispatch({ type: "INGEST_AMS_TRAY", printerId: printer.id, slot: tray.globalIndex, spool })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bambu])
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
  const bambu = useBambuLive(printer)
  // Subtract filament from the actively-printing spool, and auto-ingest AMS
  // trays (RFID) so scanned Bambu spools can be stored afterwards.
  useLiveConsumption(printer, live, bambu)
  useAmsRfidIngest(printer, bambu)

  return (
    <div className="lg:min-h-0 lg:flex-1 lg:overflow-auto lg:scrollbar-thin">
      <PrinterHeader printer={printer} onRemove={onRemove} />
      <PrinterLinkRow printer={printer} live={live} bambu={bambu} />
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
function PrinterLinkRow({ printer, live, bambu }: { printer: Printer; live?: MoonrakerStatus; bambu?: BambuStatus }) {
  const { dispatch } = useStore()
  const [ip, setIp] = useState(printer.ip ?? "")
  const [editing, setEditing] = useState(!printer.ip)
  const klipperLinked = isKlipperLinked(printer)

  // Bambu printers link via serial + access code (set when adding the printer),
  // so show a live MQTT/AMS status row instead of the Klipper IP editor.
  if (printer.firmware === "bambu") {
    return <BambuLinkRow printer={printer} bambu={bambu} />
  }

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

/**
 * Bambu Lab link status row. The connection (serial + access code) is set when
 * the printer is added; here we only reflect the live MQTT/AMS read. In the
 * hosted preview the LAN printer is unreachable, so the proxy returns a
 * simulation — surfaced honestly as "Simulated (preview)".
 */
function BambuLinkRow({ printer, bambu }: { printer: Printer; bambu?: BambuStatus }) {
  const linked = isBambuLinked(printer)
  const connecting = linked && bambu === undefined
  const simulated = bambu?.connected === true && bambu.simulated === true
  const connected = bambu?.connected === true && !bambu.simulated
  const error = linked ? bambu?.error : undefined

  const status: "online" | "checking" | "offline" = connected || simulated ? "online" : connecting ? "checking" : "offline"
  const dot =
    status === "online"
      ? simulated
        ? "bg-warning"
        : "bg-success"
      : status === "checking"
        ? "bg-warning animate-pulse"
        : "bg-muted-foreground/50"
  const StatusIcon = status === "online" ? Wifi : status === "checking" ? Loader2 : WifiOff
  const statusColor =
    status === "online" ? (simulated ? "text-warning" : "text-success") : status === "checking" ? "text-warning" : "text-muted-foreground"
  const statusLabel = !linked
    ? "Add serial + access code to link"
    : simulated
      ? "Simulated (preview)"
      : connected
        ? "Connected (MQTT)"
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
            {printer.serial ? `SN ${printer.serial}` : "No serial"}
            {printer.bambuMode === "cloud" ? " · cloud" : printer.ip ? ` · ${printer.ip}` : ""}
          </p>
          {error && <p className="truncate text-xs text-destructive">{error}</p>}
          {simulated && (
            <p className="text-xs text-muted-foreground">Self-host on the printer&apos;s LAN for real AMS data.</p>
          )}
        </div>
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
      <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
        <span
          className="h-3 w-3 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: spool.color }}
          aria-hidden
        />
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
