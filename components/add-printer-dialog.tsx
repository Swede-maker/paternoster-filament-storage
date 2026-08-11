"use client"

import { useState } from "react"
import { Printer as PrinterIcon } from "lucide-react"
import { useStore } from "@/lib/store"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"
import { Button } from "./ui/button"
import { Field, Input, Segmented, NumberChips } from "./ui/field"
import { newId, printerSlotCount, MAX_PRINTERS } from "@/lib/filament"
import type { Printer, PrinterKind, PrinterFirmware } from "@/lib/types"

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

  const atLimit = state.printers.length >= MAX_PRINTERS

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
  }

  function submit() {
    const draft = { kind, amsUnits, slotsPerAms, toolheads }
    const count = printerSlotCount(draft)
    const printer: Printer = {
      id: newId("printer"),
      name: name.trim() || `Printer ${state.printers.length + 1}`,
      kind,
      amsUnits,
      slotsPerAms,
      toolheads,
      // Firmware selects which live temps we read (Klipper heater names). Store
      // it for toolchangers and for any linked printer (so single/AMS printers
      // can read their nozzle temp too).
      firmware: kind === "toolchanger" || ip.trim() ? firmware : undefined,
      loaded: Array.from({ length: count }, () => null),
      ip: ip.trim() || undefined,
      port: ip.trim() ? Number.parseInt(port) || 7125 : undefined,
      apiKey: ip.trim() && apiKey.trim() ? apiKey.trim() : undefined,
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

            <Field label="Printer IP address (optional)">
              <Input
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="e.g. 192.168.1.50"
                inputMode="decimal"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Link the printer to read its live nozzle temperature. You can add or change this later. Leave blank if
                your printer can&apos;t be linked.
              </p>
            </Field>

            {ip.trim() && (
              <div className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-background/40 p-3">
                <Field label="Controller firmware" className="col-span-2">
                  <Segmented
                    className="w-full [&>button]:flex-1"
                    value={firmware}
                    onChange={(v) => setFirmware(v as PrinterFirmware)}
                    options={[
                      { value: "klipper", label: "Klipper" },
                      { value: "marlin", label: "Marlin" },
                    ]}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Live nozzle temperatures are read over Moonraker, so choose Klipper to see them.
                  </p>
                </Field>
                <Field label="Moonraker port">
                  <Input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="7125"
                    inputMode="numeric"
                  />
                </Field>
                <Field label="API key (optional)">
                  <Input
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Only if required"
                  />
                </Field>
                <p className="col-span-2 text-xs text-muted-foreground">
                  For Klipper/Mainsail the default port is 7125 and no key is needed on a trusted LAN.
                </p>
              </div>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={atLimit}>
          Add printer
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
