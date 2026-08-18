"use client"

import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { Plus, Trash2, Printer as PrinterIcon, Wifi, WifiOff, Loader2, Flame } from "lucide-react"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { activePrinter } from "@/lib/selectors"
import { formatRemaining, spoolFill, densityFor, newId } from "@/lib/filament"
import { klipperHeaterName } from "@/lib/printer-commands"
import { fetchMoonrakerStatus, isKlipperLinked, type MoonrakerStatus } from "@/lib/moonraker"
import { fetchPrusaLinkStatus, isPrusaLinked } from "@/lib/prusalink"
import { fetchBambuStatus, isBambuLinked, bambuCloudRefresh, type BambuStatus } from "@/lib/bambu"
import { Button } from "./ui/button"
import { Input } from "./ui/field"
import { AmsUnit, Toolhead } from "./ams-unit"
import { SpoolDisc } from "./spool"
import { AddPrinterDialog } from "./add-printer-dialog"
import { BambuCloudSignIn } from "./bambu-cloud-sign-in"
import { FilamentUsedCard } from "./filament-used-card"
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
    <div className="flex flex-col gap-4 lg:min-h-0">
      <FilamentUsedCard />
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
    </div>
  )
}

/**
 * Poll a Klipper printer's live status/temps via the Moonraker proxy. Disabled
 * (returns undefined) for printers that aren't a Klipper machine with an IP.
 */
// How many polls in a row must fail before we actually show "Not reachable".
// Printers (especially a busy Klipper host or one on WiFi) drop the occasional
// request; without this grace window the status bounces between Connected and
// Failed to fetch on every transient blip.
const CONNECTION_FAILURE_GRACE = 3

type SmoothState<T> = { lastGood?: T; lastSeen?: T; fails: number }

/**
 * Smooth a polled connection status so a single failed poll doesn't flip the UI
 * to an error. Keeps returning the last successful reading until we've seen
 * `grace` consecutive failures, then surfaces the real failure. Safe to mutate
 * the ref during render because each data object is only processed once (guarded
 * by identity via `lastSeen`).
 */
function smoothConnection<T extends { connected: boolean }>(
  ref: React.MutableRefObject<SmoothState<T>>,
  data: T | undefined,
  grace: number,
): T | undefined {
  if (data && data !== ref.current.lastSeen) {
    ref.current.lastSeen = data
    if (data.connected) {
      ref.current.lastGood = data
      ref.current.fails = 0
    } else {
      ref.current.fails += 1
    }
  }
  if (!data) return undefined
  // Within the grace window, keep showing the last good reading.
  if (!data.connected && ref.current.fails < grace && ref.current.lastGood) {
    return ref.current.lastGood
  }
  return data
}

function useMoonrakerLive(printer: Printer): MoonrakerStatus | undefined {
  const enabled = isKlipperLinked(printer)
  const { data } = useSWR<MoonrakerStatus>(
    enabled ? ["moonraker", printer.id, printer.ip, printer.port] : null,
    () => fetchMoonrakerStatus(printer),
    { refreshInterval: 3000, revalidateOnFocus: false, dedupingInterval: 2000, keepPreviousData: true },
  )
  const smoothRef = useRef<SmoothState<MoonrakerStatus>>({ fails: 0 })
  const smoothed = smoothConnection(smoothRef, data, CONNECTION_FAILURE_GRACE)
  return enabled ? smoothed : undefined
}

/**
 * Poll a Prusa printer over PrusaLink via the /api/prusalink proxy. Returns the
 * same `MoonrakerStatus` shape as Klipper, so temperature display and live
 * weight tracking work identically. Disabled unless it's a linked Prusa machine.
 */
function usePrusaLinkLive(printer: Printer): MoonrakerStatus | undefined {
  const enabled = isPrusaLinked(printer)
  const { data } = useSWR<MoonrakerStatus>(
    enabled ? ["prusalink", printer.id, printer.ip, printer.port] : null,
    () => fetchPrusaLinkStatus(printer),
    { refreshInterval: 3000, revalidateOnFocus: false, dedupingInterval: 2000, keepPreviousData: true },
  )
  const smoothRef = useRef<SmoothState<MoonrakerStatus>>({ fails: 0 })
  const smoothed = smoothConnection(smoothRef, data, CONNECTION_FAILURE_GRACE)
  return enabled ? smoothed : undefined
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
    { refreshInterval: 4000, revalidateOnFocus: false, dedupingInterval: 3000, keepPreviousData: true },
  )
  useBambuTokenRefresh(printer)
  const smoothRef = useRef<SmoothState<BambuStatus>>({ fails: 0 })
  const smoothed = smoothConnection(smoothRef, data, CONNECTION_FAILURE_GRACE)
  return enabled ? smoothed : undefined
}

/**
 * Keep a cloud-linked Bambu printer signed in without the user re-entering their
 * password. Cloud access tokens expire; before that happens we exchange the
 * stored refresh token for a fresh access token (and rotated refresh token) and
 * persist them. Runs only for cloud printers that have a refresh token.
 *
 * Refreshes when the token is within REFRESH_LEAD_MS of expiring (or already
 * expired). A per-printer ref guards against firing twice while a request is in
 * flight or after a permanent failure, so a bad refresh token can't hammer the
 * endpoint every tick.
 */
function useBambuTokenRefresh(printer: Printer) {
  const { dispatch } = useStore()
  // Guard: `true` while a refresh is in flight or has permanently failed for the
  // current token, so the interval doesn't retry on every tick. Keyed by token
  // so a freshly minted token clears the guard and can refresh again later.
  const lockRef = useRef<string | null>(null)

  const isCloud = printer.bambuMode === "cloud"
  const refreshToken = printer.bambuRefreshToken
  const expiresAt = printer.bambuTokenExpiresAt
  const region = printer.bambuRegion ?? "global"
  const printerId = printer.id
  const token = printer.bambuToken

  useEffect(() => {
    if (!isCloud || !refreshToken) return
    // Refresh this far ahead of expiry so a fresh token is ready before the
    // MQTT poll needs it. If we have no expiry hint, treat it as "refresh soon".
    const REFRESH_LEAD_MS = 5 * 60 * 1000

    const maybeRefresh = async () => {
      // Nothing to do until we're inside the lead window (or expiry unknown).
      const due = expiresAt === undefined || Date.now() >= expiresAt - REFRESH_LEAD_MS
      if (!due) return
      // Already tried for this exact token — don't spam the endpoint.
      if (lockRef.current === (token ?? refreshToken)) return
      lockRef.current = token ?? refreshToken

      const res = await bambuCloudRefresh(region, refreshToken)
      if (!res.ok) {
        // Leave the lock set so we don't retry a bad token every tick; a manual
        // Re-link (new token) resets it via the effect's dependency change.
        console.log("[v0] Bambu token refresh failed:", res.error)
        return
      }
      dispatch({
        type: "UPDATE_PRINTER",
        id: printerId,
        changes: {
          bambuToken: res.tokens.token,
          bambuUid: res.tokens.uid || undefined,
          bambuRefreshToken: res.tokens.refreshToken ?? refreshToken,
          bambuTokenExpiresAt: res.tokens.expiresAt,
        },
      })
    }

    // Check immediately on mount/token-change, then on a modest interval.
    void maybeRefresh()
    const iv = setInterval(maybeRefresh, 60 * 1000)
    return () => clearInterval(iv)
  }, [isCloud, refreshToken, expiresAt, region, printerId, token, dispatch])
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
  // Live status/temps are read-only: we poll the printer's controller (Klipper
  // via Moonraker, or Prusa via PrusaLink) and display the nozzle temperature it
  // reports. Both return the same shape; only one is ever active per printer.
  // The app never commands the heaters.
  const moonraker = useMoonrakerLive(printer)
  const prusa = usePrusaLinkLive(printer)
  const live = moonraker ?? prusa
  const bambu = useBambuLive(printer)
  // Filament consumption is tracked server-side by the Pi (see
  // lib/server/consumption-poller) so weights keep updating even with no browser
  // open — the browser no longer subtracts. We still auto-ingest AMS trays
  // (RFID) here so scanned Bambu spools can be stored afterwards.
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
  // Both Klipper (Moonraker) and Prusa (PrusaLink) provide real live status over
  // an IP, so either one drives the Connected / Not reachable indicator.
  const liveLinked = isKlipperLinked(printer) || isPrusaLinked(printer)

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

  // Derive the display status. Real for Klipper/PrusaLink (from live polling),
  // otherwise a neutral note since those are the transports we can actually read.
  const connecting = liveLinked && live === undefined
  const connected = liveLinked && live?.connected === true
  const error = liveLinked ? live?.error : undefined

  const status: "online" | "checking" | "offline" = connected ? "online" : connecting ? "checking" : "offline"
  const dot =
    status === "online" ? "bg-success" : status === "checking" ? "bg-warning animate-pulse" : "bg-muted-foreground/50"
  const StatusIcon = status === "online" ? Wifi : status === "checking" ? Loader2 : WifiOff
  const statusColor =
    status === "online" ? "text-success" : status === "checking" ? "text-warning" : "text-muted-foreground"
  const statusLabel = !liveLinked
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
          {!liveLinked && (
            <p className="text-xs text-muted-foreground">Live status needs a Klipper or Prusa (PrusaLink) printer.</p>
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
  const { dispatch } = useStore()
  const [signingIn, setSigningIn] = useState(false)
  const linked = isBambuLinked(printer)
  const connecting = linked && bambu === undefined
  const simulated = bambu?.connected === true && bambu.simulated === true
  const connected = bambu?.connected === true && !bambu.simulated
  const error = linked ? bambu?.error : undefined
  const isCloud = printer.bambuMode === "cloud"
  // Offer a cloud sign-in when this is a cloud printer that isn't linked yet
  // (never signed in, or the saved token was cleared).
  const needsCloudSignIn = isCloud && !linked

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
    <div className="mb-3 rounded-xl border border-border bg-background/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dot)} />
          <StatusIcon className={cn("h-4 w-4 shrink-0", statusColor, status === "checking" && "animate-spin")} />
          <div className="min-w-0">
            <p className={cn("text-sm font-medium", statusColor)}>{statusLabel}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {printer.serial ? `SN ${printer.serial}` : "No serial"}
              {isCloud ? " · cloud" : printer.ip ? ` · ${printer.ip}` : ""}
              {isCloud && printer.bambuAccountEmail ? ` · ${printer.bambuAccountEmail}` : ""}
            </p>
            {error && <p className="truncate text-xs text-destructive">{error}</p>}
            {simulated && (
              <p className="text-xs text-muted-foreground">Self-host on the printer&apos;s LAN for real AMS data.</p>
            )}
          </div>
        </div>
        {isCloud && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={() => setSigningIn((s) => !s)}>
            {signingIn ? "Close" : linked ? "Re-link" : "Sign in"}
          </Button>
        )}
      </div>

      {isCloud && (signingIn || needsCloudSignIn) && (
        <div className="mt-3">
          <BambuCloudSignIn
            onLinked={(link) => {
              dispatch({
                type: "UPDATE_PRINTER",
                id: printer.id,
                changes: {
                  bambuMode: "cloud",
                  bambuRegion: link.region,
                  bambuToken: link.token,
                  bambuUid: link.uid,
                  bambuAccountEmail: link.email,
                  bambuRefreshToken: link.refreshToken,
                  bambuTokenExpiresAt: link.expiresAt,
                  serial: link.serial,
                  link: "checking",
                },
              })
              setSigningIn(false)
            }}
          />
        </div>
      )}
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
