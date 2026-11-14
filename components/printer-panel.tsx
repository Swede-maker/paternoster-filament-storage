"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import useSWR from "swr"
import {
  Plus,
  Trash2,
  Pencil,
  Printer as PrinterIcon,
  Wifi,
  WifiOff,
  Loader2,
  Flame,
  ChevronDown,
  RefreshCw,
  Hand,
  ArrowRightLeft,
  X,
  Check,
} from "lucide-react"
import {
  planAmsSync,
  resolveAmsConflict,
  spoolLabel,
  type AmsConflictChoice,
  type AmsSyncConflict,
  type AmsSyncEntry,
  type AmsSyncOp,
} from "@/lib/ams-sync"
import { Dialog, DialogFooter } from "./ui/dialog"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { activePrinter } from "@/lib/selectors"
import { formatRemaining, spoolFill, densityFor, newId } from "@/lib/filament"
import { klipperHeaterName } from "@/lib/printer-commands"
import { fetchMoonrakerStatus, isKlipperLinked, type MoonrakerStatus } from "@/lib/moonraker"
import { fetchPrusaLinkStatus, isPrusaLinked } from "@/lib/prusalink"
import { fetchBambuStatus, isBambuLinked, bambuCloudRefresh, bambuCloudProfile, type BambuStatus } from "@/lib/bambu"
import { Button } from "./ui/button"
import { Input } from "./ui/field"
import { AmsUnit, Toolhead } from "./ams-unit"
import { SpoolDisc, discColor2 } from "./spool"
import { AddPrinterDialog } from "./add-printer-dialog"
import { BambuCloudSignIn } from "./bambu-cloud-sign-in"
import { FilamentUsedCard } from "./filament-used-card"
import { usePersistentBoolean } from "@/lib/use-persistent"
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
  // When set, the printer dialog opens in EDIT mode for this printer.
  const [editPrinter, setEditPrinter] = useState<Printer | null>(null)
  // Collapse the printer section (selector + AMS grid) to reclaim space; the
  // title bar stays. Starts open and is remembered per device.
  const [savedOpen, setSavedOpen] = usePersistentBoolean("pax:home:printersOpen", true)
  // During a pick/place job the section always starts collapsed so the carousel
  // and the active-spool window get the room. Toggling it mid-job only affects
  // that job; the saved preference comes back once the job ends.
  const jobActive = !!state.job
  const [jobOpen, setJobOpen] = useState(false)
  const [prevJobActive, setPrevJobActive] = useState(jobActive)
  if (prevJobActive !== jobActive) {
    setPrevJobActive(jobActive)
    setJobOpen(false)
  }
  const open = jobActive ? jobOpen : savedOpen
  const toggleOpen = () => (jobActive ? setJobOpen((v) => !v) : setSavedOpen((v) => !v))
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
      <div className={cn("flex flex-wrap items-center justify-between gap-2", open && "mb-3")}>
        <div className="flex items-center gap-1.5">
          {/* Chevron toggles the whole printer section to free up space. */}
          <SectionToggle open={open} onToggle={toggleOpen} />
          <h2 className="text-base font-semibold">AMS / Toolchanger Status</h2>
        </div>
        <div className="ml-auto flex items-center gap-2">
        {open && (
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
        )}
          {/* Mirror toggle on the right: the active-spool window docks bottom-left
              during a job and covers the left chevron. */}
          <SectionToggle open={open} onToggle={toggleOpen} />
        </div>
      </div>

      {open &&
        (!printer ? (
          <EmptyPrinterState onAdd={() => setAddOpen(true)} />
        ) : (
          <PrinterCard
            key={printer.id}
            printer={printer}
            spools={state.spools}
            onSlot={handleSlot}
            onEdit={() => setEditPrinter(printer)}
            onRemove={() => {
              if (confirm(`Remove "${printer.name}"? Spools loaded on it will be discarded.`)) {
                dispatch({ type: "REMOVE_PRINTER", id: printer.id })
              }
            }}
            queuedPrinterSlots={queuedPrinterSlots}
          />
        ))}

      <AddPrinterDialog open={addOpen} onClose={() => setAddOpen(false)} />
      {/* Same dialog, edit mode — keyed by printer id so it re-mounts per target. */}
      {editPrinter && (
        <AddPrinterDialog
          key={editPrinter.id}
          open={!!editPrinter}
          printer={editPrinter}
          onClose={() => setEditPrinter(null)}
        />
      )}
      </section>
    </div>
  )
}

function SectionToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? "Hide printers" : "Show printers"}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ChevronDown className={cn("h-4 w-4 transition-transform", open ? "rotate-180" : "rotate-0")} />
    </button>
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

type AmsSyncReport = { at: number; entries: AmsSyncEntry[]; auto: boolean; error?: string }

/**
 * Keeps the app's AMS slots in step with the printer. In the background (every
 * poll) only RFID-tagged trays are reconciled; the manual Sync also handles
 * untagged spools, empty trays and swaps. Spools that leave the AMS go to
 * "In my hand" and every change is surfaced in a report.
 */
function useAmsSync(printer: Printer, bambu: BambuStatus | undefined) {
  const { state, dispatch } = useStore()
  const [report, setReport] = useState<AmsSyncReport | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [conflicts, setConflicts] = useState<AmsSyncConflict[]>([])
  const enabled = printer.firmware === "bambu" && printer.kind === "ams"
  const opts = { materialDefaults: state.settings.materialDefaults }

  function run(ops: AmsSyncOp[]) {
    const now = Date.now()
    for (const op of ops) {
      if (op.kind === "clear") dispatch({ type: "SET_PRINTER_SLOT", printerId: printer.id, slot: op.slot, spoolId: null })
      else if (op.kind === "seat")
        dispatch({ type: "SET_PRINTER_SLOT", printerId: printer.id, slot: op.slot, spoolId: op.spoolId })
      else if (op.kind === "ingest") dispatch({ type: "INGEST_AMS_TRAY", printerId: printer.id, slot: op.slot, spool: op.spool })
      else if (op.kind === "update") dispatch({ type: "UPDATE_SPOOL", id: op.id, changes: op.changes })
      else dispatch({ type: "UPDATE_SPOOL", id: op.id, changes: { inHandSince: now } })
    }
  }

  function apply(trays: BambuStatus["trays"], rfidOnly: boolean) {
    const plan = planAmsSync(printer, trays, state.spools, { ...opts, rfidOnly })
    run(plan.ops)
    return plan
  }

  /** Answer the first open conflict; the report fills in as the user goes. */
  function resolve(choice: AmsConflictChoice) {
    const [first, ...rest] = conflicts
    if (!first) return
    const res = resolveAmsConflict(first, choice, state.spools, opts)
    run(res.ops)
    setConflicts(rest)
    setReport((r) => ({ at: Date.now(), auto: false, entries: [...(r?.entries ?? []), ...res.entries] }))
  }

  useEffect(() => {
    if (!enabled || !bambu?.connected || syncing || conflicts.length > 0) return
    const plan = apply(bambu.trays, true)
    if (plan.entries.length > 0) setReport({ at: Date.now(), entries: plan.entries, auto: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bambu])

  async function sync() {
    setSyncing(true)
    try {
      const status = await fetchBambuStatus(printer)
      if (!status.connected) {
        setReport({ at: Date.now(), entries: [], auto: false, error: status.error ?? "Printer not reachable" })
        return
      }
      if (status.trays.length === 0) {
        setReport({
          at: Date.now(),
          entries: [],
          auto: false,
          error: "The printer didn't report any AMS trays. Check that the AMS is connected and try again.",
        })
        return
      }
      const plan = apply(status.trays, false)
      setConflicts(plan.conflicts)
      setReport({ at: Date.now(), entries: plan.entries, auto: false })
    } finally {
      setSyncing(false)
    }
  }

  return {
    enabled,
    sync,
    syncing,
    report,
    dismiss: () => setReport(null),
    conflict: conflicts[0] ?? null,
    conflictsLeft: conflicts.length,
    resolve,
    /** Leave the remaining slots as they are for now; the next Sync asks again. */
    skipConflicts: () => setConflicts([]),
  }
}

function PrinterCard({
  printer,
  spools,
  onSlot,
  onEdit,
  onRemove,
  queuedPrinterSlots,
}: {
  printer: Printer
  spools: Record<string, Spool>
  onSlot: (p: Printer, index: number) => void
  onEdit: () => void
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
  const amsSync = useAmsSync(printer, bambu)

  return (
    <div className="lg:min-h-0 lg:flex-1 lg:overflow-auto lg:scrollbar-thin">
      <PrinterHeader printer={printer} onEdit={onEdit} onRemove={onRemove} />
      <PrinterLinkRow printer={printer} live={live} bambu={bambu} />
      <PrinterBody
        printer={printer}
        spools={spools}
        onSlot={onSlot}
        queuedPrinterSlots={queuedPrinterSlots}
        live={live}
        amsAside={
          amsSync.enabled ? (
            <AmsSyncButton
              onSync={amsSync.sync}
              syncing={amsSync.syncing}
              disabled={!isBambuLinked(printer)}
              lastSync={amsSync.report?.auto === false ? amsSync.report.at : undefined}
            />
          ) : undefined
        }
      />
      {amsSync.report && <AmsSyncReportCard report={amsSync.report} onDismiss={amsSync.dismiss} />}
      <AmsConflictDialog
        conflict={amsSync.conflict}
        left={amsSync.conflictsLeft}
        onChoose={amsSync.resolve}
        onSkip={amsSync.skipConflicts}
      />
    </div>
  )
}

function PrinterHeader({
  printer,
  onEdit,
  onRemove,
}: {
  printer: Printer
  onEdit: () => void
  onRemove: () => void
}) {
  const kindLabel =
    printer.kind === "single" ? "Single Spool" : printer.kind === "ams" ? "AMS" : "Toolchanger"
  return (
    <div className="mb-3 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <PrinterIcon className="h-4 w-4" />
        <span className="font-medium text-foreground">{printer.name}</span>
        <span className="rounded-md bg-secondary px-2 py-0.5 text-xs">{kindLabel}</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
        <button
          type="button"
          onClick={onRemove}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </button>
      </div>
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
  // A cloud token saved without a uid (opaque global-region tokens) can usually
  // be repaired without re-entering the password: ask the profile API for it.
  const repairUid = isCloud && !!printer.bambuToken?.trim() && !printer.bambuUid?.trim()
  const uidRepair = useSWR(
    repairUid ? ["bambu-uid", printer.id, printer.bambuRegion ?? "global", printer.bambuToken] : null,
    ([, , region, token]) => bambuCloudProfile(region as "global" | "china", token as string),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
      onSuccess: (res) => {
        if (res.ok) dispatch({ type: "UPDATE_PRINTER", id: printer.id, changes: { bambuUid: res.uid, link: "checking" } })
      },
    },
  )
  const repairing = repairUid && uidRepair.isLoading
  const repairError = repairUid && uidRepair.data && !uidRepair.data.ok ? uidRepair.data.error : undefined
  const missingSerial = isCloud && !!printer.bambuToken?.trim() && !!printer.bambuUid?.trim() && !printer.serial?.trim()
  // Offer a cloud sign-in when this is a cloud printer that isn't linked yet
  // (never signed in, or the saved token couldn't be repaired).
  const needsCloudSignIn = isCloud && !linked && !repairing && !missingSerial

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
    ? isCloud
      ? repairing
        ? "Finishing cloud sign-in…"
        : missingSerial
          ? "Signed in — pick the printer's serial in Edit"
          : "Not signed in to Bambu cloud"
      : "Add serial + access code to link"
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
            {repairError && <p className="text-xs text-destructive">{repairError}</p>}
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

/**
 * The loaded-spool grid (single nozzle / toolheads / AMS trays) for one printer,
 * with live nozzle temperatures. Standalone so the Printers area can show what's
 * loaded next to the printer's own web UI; slot taps are reported to `onSlot`.
 */
export function PrinterLoadedSpools({
  printer,
  onSlot,
  queuedPrinterSlots,
}: {
  printer: Printer
  onSlot: (p: Printer, index: number) => void
  queuedPrinterSlots?: number[]
}) {
  const { state } = useStore()
  const moonraker = useMoonrakerLive(printer)
  const prusa = usePrusaLinkLive(printer)
  return (
    <PrinterBody
      printer={printer}
      spools={state.spools}
      onSlot={onSlot}
      queuedPrinterSlots={queuedPrinterSlots}
      live={moonraker ?? prusa}
    />
  )
}

function PrinterBody({
  printer,
  spools,
  onSlot,
  queuedPrinterSlots,
  live,
  amsAside,
}: {
  printer: Printer
  spools: Record<string, Spool>
  onSlot: (p: Printer, index: number) => void
  queuedPrinterSlots?: number[]
  live?: MoonrakerStatus
  /** Rendered beside the AMS units (e.g. the Bambu Sync control). */
  amsAside?: ReactNode
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
                {spool ? <SpoolDisc color={spool.color} color2={discColor2(spool)} size={84} fill={spoolFill(spool)} /> : <EmptyDisc />}
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
      {amsAside}
    </div>
  )
}

function AmsSyncButton({
  onSync,
  syncing,
  disabled,
  lastSync,
}: {
  onSync: () => void
  syncing: boolean
  disabled?: boolean
  lastSync?: number
}) {
  return (
    <div className="flex shrink-0 flex-col justify-end gap-2 pt-6">
      <button
        type="button"
        onClick={onSync}
        disabled={syncing || disabled}
        className="flex w-36 flex-col items-center justify-center gap-2 rounded-xl border border-primary/40 bg-primary/10 px-4 py-5 text-primary transition-colors hover:border-primary hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshCw className={cn("h-6 w-6", syncing && "animate-spin")} aria-hidden />
        <span className="text-sm font-semibold">{syncing ? "Syncing…" : "Sync AMS"}</span>
        <span className="text-center text-[11px] leading-snug text-muted-foreground text-pretty">
          Read spools from the printer
        </span>
      </button>
      <p className="text-center text-[11px] text-muted-foreground" aria-live="polite">
        {lastSync
          ? `Last sync ${new Date(lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : disabled
            ? "Link the printer first"
            : "Not synced yet"}
      </p>
    </div>
  )
}

function ConflictSide({
  heading,
  color,
  name,
  meta,
}: {
  heading: string
  color: string
  name: string
  meta: string
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2 rounded-xl border border-border bg-background/50 p-4 text-center">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{heading}</p>
      <SpoolDisc color={color} size={56} />
      <p className="text-sm font-semibold text-foreground text-balance">{name}</p>
      <p className="text-xs text-muted-foreground">{meta}</p>
    </div>
  )
}

/**
 * Asks whether a mismatched AMS slot is the same spool set up differently in
 * Bambu, or a different spool (then the app's spool goes to "In my hand").
 */
function AmsConflictDialog({
  conflict,
  left,
  onChoose,
  onSkip,
}: {
  conflict: AmsSyncConflict | null
  left: number
  onChoose: (choice: AmsConflictChoice) => void
  onSkip: () => void
}) {
  if (!conflict) return null
  const { current, reported } = conflict
  const appName = spoolLabel(current)
  const printerName = `${reported.colorName} ${reported.material}`
  return (
    <Dialog
      open
      onClose={onSkip}
      title={`Different spool in ${conflict.slotLabel}?`}
      description={left > 1 ? `${left} slots need your answer.` : undefined}
    >
      <p className="text-sm leading-relaxed text-muted-foreground text-pretty">
        The app has <span className="font-medium text-foreground">{appName}</span> in this slot, but the printer
        reports <span className="font-medium text-foreground">{printerName}</span>. Is it the same spool?
      </p>

      <div className="mt-4 flex items-stretch gap-3">
        <ConflictSide
          heading="In the app"
          color={current.color}
          name={appName}
          meta={`${current.brand} · ${formatRemaining(current)}`}
        />
        <div className="flex items-center text-muted-foreground" aria-hidden>
          <ArrowRightLeft className="h-4 w-4" />
        </div>
        <ConflictSide
          heading="Printer reports"
          color={reported.color}
          name={printerName}
          meta={reported.weightKnown ? `${reported.grams} / ${reported.capacity} g` : `${reported.capacity} g spool`}
        />
      </div>

      <div className="mt-5 flex flex-col gap-2">
        <Button className="h-auto justify-start py-3 text-left" onClick={() => onChoose("keep")}>
          <span className="flex flex-col items-start gap-0.5">
            <span>Same spool, keep {appName}</span>
            <span className="text-xs font-normal opacity-80">The app is right. Sync won&apos;t ask about this again.</span>
          </span>
        </Button>
        <Button variant="outline" className="h-auto justify-start py-3 text-left" onClick={() => onChoose("update")}>
          <span className="flex flex-col items-start gap-0.5">
            <span>Same spool, use the printer&apos;s info</span>
            <span className="text-xs font-normal text-muted-foreground">
              Change it to {printerName} in the app.
            </span>
          </span>
        </Button>
        <Button variant="outline" className="h-auto justify-start py-3 text-left" onClick={() => onChoose("replace")}>
          <span className="flex flex-col items-start gap-0.5">
            <span>Different spool</span>
            <span className="text-xs font-normal text-muted-foreground">
              Create {printerName} here and send {appName} to &quot;In my hand&quot;.
            </span>
          </span>
        </Button>
      </div>

      <DialogFooter className="mt-4">
        <Button variant="ghost" size="sm" onClick={onSkip}>
          Decide later
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

const SYNC_KIND_META: Record<AmsSyncEntry["kind"], { title: string; icon: typeof Plus; tone: string }> = {
  kept: { title: "Kept", icon: Check, tone: "text-muted-foreground" },
  created: { title: "New spool created", icon: Plus, tone: "text-success" },
  relinked: { title: "Recognised", icon: RefreshCw, tone: "text-primary" },
  moved: { title: "Moved", icon: ArrowRightLeft, tone: "text-primary" },
  updated: { title: "Updated", icon: Pencil, tone: "text-muted-foreground" },
  toHand: { title: "Sent to In my hand", icon: Hand, tone: "text-warning" },
}

function AmsSyncReportCard({ report, onDismiss }: { report: AmsSyncReport; onDismiss: () => void }) {
  const handCount = report.entries.filter((e) => e.kind === "toHand").length
  const heading = report.error
    ? "Sync failed"
    : report.entries.length === 0
      ? "AMS is in sync"
      : report.auto
        ? "AMS changes detected"
        : "Sync complete"
  return (
    <section
      aria-live="polite"
      className={cn(
        "mt-4 rounded-xl border bg-background/40 p-4",
        report.error ? "border-destructive/50" : handCount > 0 ? "border-warning/50" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className={cn("text-sm font-semibold", report.error ? "text-destructive" : "text-foreground")}>{heading}</h3>
          <p className="text-xs text-muted-foreground">
            {report.error
              ? report.error
              : report.entries.length === 0
                ? "Everything in the app already matches the AMS."
                : handCount > 0
                  ? `${handCount} spool${handCount === 1 ? " was" : "s were"} taken out of the AMS and moved to "In my hand".`
                  : `${report.entries.length} change${report.entries.length === 1 ? "" : "s"} from the printer.`}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss sync report"
          className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {report.entries.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {report.entries.map((e, i) => {
            const meta = SYNC_KIND_META[e.kind]
            const Icon = meta.icon
            return (
              <li key={i} className="flex items-center gap-3 rounded-lg bg-secondary/50 px-3 py-2">
                <Icon className={cn("h-4 w-4 shrink-0", meta.tone)} aria-hidden />
                <span
                  className="h-3 w-3 shrink-0 rounded-full border border-border"
                  style={{ backgroundColor: e.color }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">
                    <span className={cn("font-medium", meta.tone)}>{meta.title}:</span> {e.label}
                    {e.slotLabel && <span className="text-muted-foreground"> · {e.slotLabel}</span>}
                  </p>
                  {e.detail && <p className="truncate text-xs text-muted-foreground">{e.detail}</p>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
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
