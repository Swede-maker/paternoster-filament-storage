"use client"

import { useMemo, useState } from "react"
import { Radio, Plus, Trash2, Copy, Check, Wifi, WifiOff, Cpu, ChevronDown } from "lucide-react"
import { useStore } from "@/lib/store"
import { useReader } from "@/lib/use-reader"
import { newReaderToken } from "@/lib/reader-protocol"
import { newId } from "@/lib/filament"
import type { RfidReader } from "@/lib/types"
import { Button } from "./ui/button"
import { Field, Input, Select } from "./ui/field"

/**
 * Pair and manage wireless RFID/NFC readers (ESP32 / Raspberry Pi).
 *
 * A reader is just a friendly name + a pairing token the physical device is
 * flashed with. Once paired, any browser — including iPhones that can't read NFC
 * on the web — receives scans from the hardware reader through the app server.
 */
export function ReaderManager() {
  const { state, dispatch } = useStore()
  const readers = state.settings.readers ?? []
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [kind, setKind] = useState<RfidReader["kind"]>("esp32")

  function add() {
    const reader: RfidReader = {
      id: newId("reader"),
      name: name.trim() || "Wireless reader",
      token: newReaderToken(),
      kind,
      createdAt: Date.now(),
    }
    dispatch({ type: "ADD_READER", reader })
    setName("")
    setKind("esp32")
    setAdding(false)
  }

  return (
    <div className="rounded-xl border border-border bg-background/50 p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Radio className="h-4 w-4 text-muted-foreground" /> Wireless readers
        {readers.length > 0 && (
          <span className="ml-auto text-xs font-normal text-muted-foreground">{readers.length}</span>
        )}
      </h3>
      <p className="mt-1.5 text-xs text-muted-foreground text-pretty">
        Pair an ESP32 or Raspberry Pi reader so any device — including iPhones — can scan tags. The reader sends each
        scan to the app; press &quot;Wireless reader&quot; on the Scan tab and it appears instantly.
      </p>

      {readers.length > 0 && (
        <ul className="mt-3 space-y-2">
          {readers.map((r) => (
            <ReaderRow key={r.id} reader={r} onRemove={() => dispatch({ type: "REMOVE_READER", id: r.id })} />
          ))}
        </ul>
      )}

      {adding ? (
        <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Reader name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Workbench reader"
                autoFocus
              />
            </Field>
            <Field label="Device">
              <Select value={kind} onChange={(e) => setKind(e.target.value as RfidReader["kind"])}>
                <option value="esp32">ESP32</option>
                <option value="pi">Raspberry Pi</option>
                <option value="other">Other</option>
              </Select>
            </Field>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={add}>
              <Plus className="h-4 w-4" /> Pair reader
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="mt-3" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" /> Pair a reader
        </Button>
      )}
    </div>
  )
}

function ReaderRow({ reader, onRemove }: { reader: RfidReader; onRemove: () => void }) {
  const { dispatch } = useStore()
  // Listen so the row shows whether the physical reader is currently reachable.
  const { online } = useReader(reader.token, () => {})
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editingName, setEditingName] = useState(reader.name)

  function copyToken() {
    void navigator.clipboard?.writeText(reader.token).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  // The endpoint the device posts to (shown in setup instructions).
  const endpoint = useMemo(() => {
    if (typeof window === "undefined") return "/api/reader/scan"
    return `${window.location.origin}/api/reader/scan`
  }, [])

  return (
    <li className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 px-3 py-2">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
            online ? "bg-primary/15 text-primary" : "bg-secondary text-muted-foreground"
          }`}
          title={online ? "Reader online" : "Reader offline"}
        >
          {online ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{reader.name}</p>
          <p className="text-xs text-muted-foreground">
            {reader.kind === "esp32" ? "ESP32" : reader.kind === "pi" ? "Raspberry Pi" : "Reader"} ·{" "}
            {online ? "online" : "offline"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Setup details"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove reader"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {open && (
        <div className="border-t border-border px-3 py-3">
          <Field label="Reader name">
            <div className="flex gap-2">
              <Input value={editingName} onChange={(e) => setEditingName(e.target.value)} />
              <Button
                size="sm"
                variant="secondary"
                className="shrink-0"
                onClick={() => dispatch({ type: "UPDATE_READER", id: reader.id, changes: { name: editingName } })}
              >
                Save
              </Button>
            </div>
          </Field>

          <div className="mt-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Cpu className="h-3.5 w-3.5" /> Flash your device with these
            </p>
            <dl className="mt-2 space-y-2 text-xs">
              <div className="rounded-md bg-secondary/60 p-2">
                <dt className="text-muted-foreground">POST endpoint</dt>
                <dd className="mt-0.5 break-all font-mono text-foreground">{endpoint}</dd>
              </div>
              <div className="rounded-md bg-secondary/60 p-2">
                <dt className="mb-0.5 flex items-center justify-between text-muted-foreground">
                  <span>Pairing token (secret)</span>
                  <button
                    type="button"
                    onClick={copyToken}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-primary transition-colors hover:bg-primary/10"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </dt>
                <dd className="break-all font-mono text-foreground">{reader.token}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground text-pretty">
              The device POSTs {"{"}
              <span className="font-mono">&quot;token&quot;,&quot;uid&quot;</span>
              {"}"} to the endpoint on each scan. Firmware for ESP32 and Raspberry Pi is in the project&apos;s{" "}
              <span className="font-mono">pi-agent/rfid-reader/</span> folder.
            </p>
          </div>
        </div>
      )}
    </li>
  )
}
