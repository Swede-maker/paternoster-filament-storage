"use client"

import { useEffect, useState } from "react"
import { Printer as PrinterIcon, Plus, X } from "lucide-react"
import { useStore } from "@/lib/store"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { Field, Input, Segmented, NumberChips } from "./ui/field"
import { newId, printerSlotCount, printerAmsUnits, MAX_PRINTERS } from "@/lib/filament"
import type { AmsUnit, Printer, PrinterKind, PrinterFirmware } from "@/lib/types"
import { BambuCloudSignIn, type BambuCloudLink } from "./bambu-cloud-sign-in"

/** Max AMS units on one printer, and max slots per unit. */
const MAX_AMS_UNITS = 8
const MAX_SLOTS_PER_UNIT = 8

/**
 * Add / edit a printer. When `printer` is supplied the dialog opens in EDIT mode
 * — fields are prefilled and saving dispatches UPDATE_PRINTER (which re-maps the
 * loaded spools to the new slot layout) instead of ADD_PRINTER. This is what
 * lets users change a printer in place rather than deleting and recreating it.
 */
export function AddPrinterDialog({
  open,
  onClose,
  printer: editing,
}: {
  open: boolean
  onClose: () => void
  printer?: Printer
}) {
  const { state, dispatch } = useStore()
  const isEdit = !!editing
  const [name, setName] = useState("")
  const [kind, setKind] = useState<PrinterKind>("single")
  // Mixed AMS units: each has a custom name and its own slot count.
  const [ams, setAms] = useState<AmsUnit[]>([{ id: newId("ams"), name: "AMS 1", slots: 4 }])
  const [toolheads, setToolheads] = useState(4)
  const [firmware, setFirmware] = useState<PrinterFirmware>("klipper")
  const [ip, setIp] = useState("")
  const [port, setPort] = useState("7125")
  const [apiKey, setApiKey] = useState("")
  // Bambu Lab link (MQTT): serial + LAN access code, or cloud mode.
  const [serial, setSerial] = useState("")
  const [accessCode, setAccessCode] = useState("")
  const [bambuMode, setBambuMode] = useState<"lan" | "cloud">("lan")
  // Result of a completed Bambu cloud sign-in (cloud mode only).
  const [cloudLink, setCloudLink] = useState<BambuCloudLink | null>(null)

  // Prefill the form whenever the dialog opens (or the target printer changes).
  // Add mode resets to defaults; edit mode mirrors the existing printer.
  useEffect(() => {
    if (!open) return
    if (editing) {
      setName(editing.name)
      setKind(editing.kind)
      setAms(printerAmsUnits(editing))
      setToolheads(Math.max(1, editing.toolheads || 4))
      setFirmware(editing.firmware ?? "klipper")
      setIp(editing.ip ?? "")
      setPort(editing.port ? String(editing.port) : editing.firmware === "prusalink" ? "80" : "7125")
      setApiKey(editing.apiKey ?? "")
      setSerial(editing.serial ?? "")
      setAccessCode(editing.accessCode ?? "")
      setBambuMode(editing.bambuMode ?? "lan")
      setCloudLink(null)
    } else {
      reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing])

  const atLimit = !isEdit && state.printers.length >= MAX_PRINTERS
  const isBambu = firmware === "bambu"
  const isPrusa = firmware === "prusalink"

  function reset() {
    setName("")
    setKind("single")
    setAms([{ id: newId("ams"), name: "AMS 1", slots: 4 }])
    setToolheads(4)
    setFirmware("klipper")
    setIp("")
    setPort("7125")
    setApiKey("")
    setSerial("")
    setAccessCode("")
    setBambuMode("lan")
    setCloudLink(null)
  }

  // --- AMS unit editing helpers ---
  function addAmsUnit() {
    setAms((prev) =>
      prev.length >= MAX_AMS_UNITS ? prev : [...prev, { id: newId("ams"), name: `AMS ${prev.length + 1}`, slots: 4 }],
    )
  }
  function removeAmsUnit(id: string) {
    setAms((prev) => (prev.length <= 1 ? prev : prev.filter((u) => u.id !== id)))
  }
  function updateAmsUnit(id: string, changes: Partial<AmsUnit>) {
    setAms((prev) => prev.map((u) => (u.id === id ? { ...u, ...changes } : u)))
  }

  // Cloud Bambu printers are only ready once the user has signed in and picked
  // a device; LAN printers just need their fields filled as before.
  const isBambuCloud = isBambu && bambuMode === "cloud"
  const canSubmit = !atLimit && (!isBambuCloud || !!cloudLink)

  function submit() {
    // For a cloud Bambu printer the serial comes from the chosen cloud device.
    const bambuSerial = isBambuCloud ? cloudLink?.serial : serial.trim() || undefined
    // Sanitise the AMS units the reducer will normalise anyway (names + slots).
    const cleanAms: AmsUnit[] = ams.map((u, i) => ({
      id: u.id,
      name: u.name.trim() || `AMS ${i + 1}`,
      slots: Math.max(1, Math.min(MAX_SLOTS_PER_UNIT, Math.floor(u.slots) || 1)),
    }))

    const common = {
      name: name.trim() || `Printer ${state.printers.length + 1}`,
      kind,
      ams: kind === "ams" ? cleanAms : undefined,
      toolheads,
      // Firmware selects the live-read transport (Klipper heater names over
      // Moonraker, or Bambu AMS/RFID over MQTT). Store it for toolchangers, any
      // linked Klipper/Marlin printer, and any Bambu printer.
      firmware: (kind === "toolchanger" || ip.trim() || isBambu ? firmware : undefined) as
        | PrinterFirmware
        | undefined,
      // Bambu LAN also uses the IP; cloud mode doesn't require it.
      ip: isBambuCloud ? undefined : ip.trim() || undefined,
      port: !isBambu && ip.trim() ? Number.parseInt(port) || (isPrusa ? 80 : 7125) : undefined,
      apiKey: !isBambu && ip.trim() && apiKey.trim() ? apiKey.trim() : undefined,
      serial: isBambu ? bambuSerial : undefined,
      accessCode: isBambu && !isBambuCloud && accessCode.trim() ? accessCode.trim() : undefined,
      bambuMode: (isBambu ? bambuMode : undefined) as "lan" | "cloud" | undefined,
      // Cloud account link (tokens only — never the password).
      bambuRegion: isBambuCloud ? cloudLink?.region : undefined,
      bambuToken: isBambuCloud ? cloudLink?.token : undefined,
      bambuUid: isBambuCloud ? cloudLink?.uid : undefined,
      bambuAccountEmail: isBambuCloud ? cloudLink?.email : undefined,
      bambuRefreshToken: isBambuCloud ? cloudLink?.refreshToken : undefined,
      bambuTokenExpiresAt: isBambuCloud ? cloudLink?.expiresAt : undefined,
    }

    if (isEdit && editing) {
      // UPDATE_PRINTER re-normalises and re-maps the loaded array, keeping the
      // spools that still fit the new layout.
      dispatch({ type: "UPDATE_PRINTER", id: editing.id, changes: common })
    } else {
      const count = printerSlotCount({ kind, ams: common.ams, amsUnits: cleanAms.length, slotsPerAms: cleanAms[0]?.slots ?? 1, toolheads })
      const printer: Printer = {
        id: newId("printer"),
        ...common,
        // Legacy uniform fields (kept in sync by the reducer's normalizePrinter).
        amsUnits: cleanAms.length,
        slotsPerAms: cleanAms[0]?.slots ?? 4,
        loaded: Array.from({ length: count }, () => null),
        link: "offline",
      }
      dispatch({ type: "ADD_PRINTER", printer })
    }
    reset()
    onClose()
  }

  const preview =
    kind === "ams"
      ? ams.reduce((sum, u) => sum + Math.max(1, u.slots || 1), 0)
      : printerSlotCount({ kind, amsUnits: 1, slotsPerAms: 1, toolheads })

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader
        icon={<PrinterIcon className="h-5 w-5" />}
        title={isEdit ? "Edit printer" : "Add a printer"}
        description={
          isEdit
            ? "Change this printer's setup. Loaded spools that still fit are kept."
            : "Tell the system what kind of machine this is."
        }
      />
      <DialogBody>
        {atLimit ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning">
            You have reached the maximum of {MAX_PRINTERS} printers. Remove one before adding another.
          </p>
        ) : (
          <div className="space-y-5">
            <Field label="Printer name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Workshop X1" autoFocus />
            </Field>

            <Field label="Filament system">
              <Segmented
                className="w-full [&>button]:flex-1"
                value={kind}
                onChange={(v) => setKind(v as PrinterKind)}
                options={[
                  { value: "single", label: "Single Spool" },
                  { value: "ams", label: "AMS" },
                  { value: "toolchanger", label: "Toolchanger" },
                ]}
              />
            </Field>

            {kind === "single" && (
              <p className="rounded-lg border border-border bg-background/50 p-3 text-sm text-muted-foreground">
                A single-spool printer holds one spool right next to the printer.
              </p>
            )}

            {kind === "ams" && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">AMS units</span>
                  <button
                    type="button"
                    onClick={addAmsUnit}
                    disabled={ams.length >= MAX_AMS_UNITS}
                    className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add unit
                  </button>
                </div>
                {/* One row per AMS unit: rename it and set its own slot count, so a
                    4-slot AMS and a 1-slot AMS Lite can live on the same printer. */}
                {ams.map((unit, i) => (
                  <div key={unit.id} className="rounded-lg border border-border bg-background/40 p-3">
                    <div className="flex items-center gap-2">
                      <Input
                        aria-label={`AMS unit ${i + 1} name`}
                        value={unit.name}
                        onChange={(e) => updateAmsUnit(unit.id, { name: e.target.value })}
                        placeholder={`AMS ${i + 1}`}
                        className="h-9 flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => removeAmsUnit(unit.id)}
                        disabled={ams.length <= 1}
                        aria-label={`Remove ${unit.name || `AMS ${i + 1}`}`}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-destructive/50 hover:text-destructive disabled:opacity-30"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-2">
                      <span className="mb-1.5 block text-xs text-muted-foreground">Slots in this unit</span>
                      <NumberChips
                        min={1}
                        max={MAX_SLOTS_PER_UNIT}
                        value={unit.slots}
                        onChange={(v) => updateAmsUnit(unit.id, { slots: v })}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {kind === "toolchanger" && (
              <Field label="Number of toolheads">
                <NumberChips min={1} max={8} value={toolheads} onChange={setToolheads} />
              </Field>
            )}

            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
              <span className="text-muted-foreground">Total loadable slots: </span>
              <span className="font-mono font-semibold text-primary">{preview}</span>
            </div>

            <Field label="Controller firmware (optional)">
              <Segmented
                className="w-full [&>button]:flex-1"
                value={firmware}
                onChange={(v) => {
                  const next = v as PrinterFirmware
                  setFirmware(next)
                  // Keep the port sensible for the chosen firmware's default,
                  // unless the user already typed a custom one.
                  if (next === "prusalink" && (port === "7125" || port === "")) setPort("80")
                  if (next === "klipper" && (port === "80" || port === "")) setPort("7125")
                }}
                options={[
                  { value: "klipper", label: "Klipper" },
                  { value: "prusalink", label: "PrusaLink" },
                  { value: "marlin", label: "Marlin" },
                  { value: "bambu", label: "Bambu Lab" },
                ]}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {isBambu
                  ? "Bambu printers link over MQTT to read live AMS spools and RFID tags."
                  : isPrusa
                    ? "PrusaLink links to Prusa printers (MINI, MK4, XL…) for live nozzle temperatures and filament usage."
                    : "Klipper links over Moonraker for live nozzle temperatures. Leave the fields blank to skip linking."}
              </p>
            </Field>

            {isBambu ? (
              <div className="space-y-4 rounded-lg border border-border bg-background/40 p-3">
                <Field label="Connection">
                  <Segmented
                    className="w-full [&>button]:flex-1"
                    value={bambuMode}
                    onChange={(v) => {
                      const next = v as "lan" | "cloud"
                      setBambuMode(next)
                      // Drop a stale cloud sign-in when switching back to LAN.
                      if (next === "lan") setCloudLink(null)
                    }}
                    options={[
                      { value: "lan", label: "LAN (local)" },
                      { value: "cloud", label: "Cloud" },
                    ]}
                  />
                </Field>

                {bambuMode === "lan" ? (
                  <>
                    <Field label="Serial number">
                      <Input
                        value={serial}
                        onChange={(e) => setSerial(e.target.value)}
                        placeholder="e.g. 01P00A1234567890"
                        spellCheck={false}
                        className="font-mono"
                      />
                    </Field>
                    <Field label="Access code">
                      <Input
                        value={accessCode}
                        onChange={(e) => setAccessCode(e.target.value)}
                        placeholder="8-digit code from the printer screen"
                        spellCheck={false}
                        className="font-mono"
                      />
                    </Field>
                    <Field label="Printer IP address">
                      <Input
                        value={ip}
                        onChange={(e) => setIp(e.target.value)}
                        placeholder="e.g. 192.168.1.50"
                        inputMode="decimal"
                      />
                    </Field>
                    <p className="text-xs text-muted-foreground">
                      Find the access code and serial under Settings → WLAN / Device on the printer. Real AMS reads work
                      when the app is self-hosted on the printer&apos;s network; the preview shows simulated trays.
                    </p>
                  </>
                ) : (
                  <>
                    <BambuCloudSignIn
                      linkedEmail={cloudLink ? `${cloudLink.email} · ${cloudLink.deviceName}` : undefined}
                      onLinked={setCloudLink}
                      onSignOut={() => setCloudLink(null)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Sign in with your Bambu account to link a printer over the cloud — no LAN Mode required, and you
                      keep Bambu&apos;s cloud features. Only an access token is stored, never your password.
                    </p>
                  </>
                )}
              </div>
            ) : (
              <>
                <Field label="Printer IP address (optional)">
                  <Input
                    value={ip}
                    onChange={(e) => setIp(e.target.value)}
                    placeholder="e.g. 192.168.1.50"
                    inputMode="decimal"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Link the printer to read its live nozzle temperature. You can add or change this later. Leave blank
                    if your printer can&apos;t be linked.
                  </p>
                </Field>

                {ip.trim() && (
                  <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-background/40 p-3">
                    <Field label={isPrusa ? "PrusaLink port" : "Moonraker port"}>
                      <Input
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                        placeholder={isPrusa ? "80" : "7125"}
                        inputMode="numeric"
                      />
                    </Field>
                    <Field label={isPrusa ? "PrusaLink password" : "API key (optional)"}>
                      <Input
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={isPrusa ? "From printer's PrusaLink screen" : "Only if required"}
                      />
                    </Field>
                    <p className="col-span-2 text-xs text-muted-foreground">
                      {isPrusa
                        ? "Enter the PrusaLink password shown under Settings → Network → PrusaLink (older firmware uses an API key). Default port is 80."
                        : "For Klipper/Mainsail the default port is 7125 and no key is needed on a trusted LAN."}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {isEdit ? "Save changes" : "Add printer"}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
