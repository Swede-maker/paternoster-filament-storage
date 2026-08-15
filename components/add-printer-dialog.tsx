"use client"

import { useState } from "react"
import { Printer as PrinterIcon } from "lucide-react"
import { useStore } from "@/lib/store"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { Field, Input, Segmented, NumberChips } from "./ui/field"
import { newId, printerSlotCount, MAX_PRINTERS } from "@/lib/filament"
import type { Printer, PrinterKind, PrinterFirmware } from "@/lib/types"
import { BambuCloudSignIn, type BambuCloudLink } from "./bambu-cloud-sign-in"

export function AddPrinterDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const [name, setName] = useState("")
  const [kind, setKind] = useState<PrinterKind>("single")
  const [amsUnits, setAmsUnits] = useState(1)
  const [slotsPerAms, setSlotsPerAms] = useState(4)
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

  const atLimit = state.printers.length >= MAX_PRINTERS
  const isBambu = firmware === "bambu"
  const isPrusa = firmware === "prusalink"

  function reset() {
    setName("")
    setKind("single")
    setAmsUnits(1)
    setSlotsPerAms(4)
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

  // Cloud Bambu printers are only ready once the user has signed in and picked
  // a device; LAN printers just need their fields filled as before.
  const isBambuCloud = isBambu && bambuMode === "cloud"
  const canSubmit = !atLimit && (!isBambuCloud || !!cloudLink)

  function submit() {
    const draft = { kind, amsUnits, slotsPerAms, toolheads }
    const count = printerSlotCount(draft)
    // For a cloud Bambu printer the serial comes from the chosen cloud device.
    const bambuSerial = isBambuCloud ? cloudLink?.serial : serial.trim() || undefined
    const printer: Printer = {
      id: newId("printer"),
      name: name.trim() || `Printer ${state.printers.length + 1}`,
      kind,
      amsUnits,
      slotsPerAms,
      toolheads,
      // Firmware selects the live-read transport (Klipper heater names over
      // Moonraker, or Bambu AMS/RFID over MQTT). Store it for toolchangers, any
      // linked Klipper/Marlin printer, and any Bambu printer.
      firmware: kind === "toolchanger" || ip.trim() || isBambu ? firmware : undefined,
      loaded: Array.from({ length: count }, () => null),
      // Bambu LAN also uses the IP; cloud mode doesn't require it.
      ip: isBambuCloud ? undefined : ip.trim() || undefined,
      port: !isBambu && ip.trim() ? Number.parseInt(port) || (isPrusa ? 80 : 7125) : undefined,
      apiKey: !isBambu && ip.trim() && apiKey.trim() ? apiKey.trim() : undefined,
      serial: isBambu ? bambuSerial : undefined,
      accessCode: isBambu && !isBambuCloud && accessCode.trim() ? accessCode.trim() : undefined,
      bambuMode: isBambu ? bambuMode : undefined,
      // Cloud account link (tokens only — never the password).
      bambuRegion: isBambuCloud ? cloudLink?.region : undefined,
      bambuToken: isBambuCloud ? cloudLink?.token : undefined,
      bambuUid: isBambuCloud ? cloudLink?.uid : undefined,
      bambuAccountEmail: isBambuCloud ? cloudLink?.email : undefined,
      bambuRefreshToken: isBambuCloud ? cloudLink?.refreshToken : undefined,
      bambuTokenExpiresAt: isBambuCloud ? cloudLink?.expiresAt : undefined,
      link: "offline",
    }
    dispatch({ type: "ADD_PRINTER", printer })
    reset()
    onClose()
  }

  const preview = printerSlotCount({ kind, amsUnits, slotsPerAms, toolheads })

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader
        icon={<PrinterIcon className="h-5 w-5" />}
        title="Add a printer"
        description="Tell the system what kind of machine this is."
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
              <div className="grid grid-cols-2 gap-4">
                <Field label="Spools per AMS unit">
                  <NumberChips min={1} max={8} value={slotsPerAms} onChange={setSlotsPerAms} />
                </Field>
                <Field label="AMS units connected">
                  <NumberChips min={1} max={4} value={amsUnits} onChange={setAmsUnits} />
                </Field>
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
          Add printer
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
