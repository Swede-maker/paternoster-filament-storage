"use client"

import { Printer as PrinterIcon } from "lucide-react"
import { Dialog, DialogHeader, DialogBody } from "./ui/dialog"
import type { Printer } from "@/lib/types"

const KIND_LABEL: Record<Printer["kind"], string> = {
  single: "Single",
  ams: "AMS",
  toolchanger: "Toolchanger",
}

/**
 * Choose which printer to load a spool onto, when more than one printer has a
 * free slot. `printers` should already be filtered to loadable printers.
 */
export function PrinterPickerDialog({
  printers,
  open,
  onClose,
  onPick,
  title = "Which printer?",
  description = "Choose the printer to load this spool onto.",
}: {
  printers: Printer[]
  open: boolean
  onClose: () => void
  onPick: (printer: Printer) => void
  title?: string
  description?: string
}) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader icon={<PrinterIcon className="h-5 w-5" />} title={title} description={description} />
      <DialogBody>
        <ul className="flex flex-col gap-2">
          {printers.map((p) => {
            const free = p.loaded.filter((s) => s == null).length
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPick(p)}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/60 hover:bg-primary/5"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                    <PrinterIcon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">{KIND_LABEL[p.kind]}</span>
                  </span>
                  <span className="shrink-0 rounded-md bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">
                    {free} free
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </DialogBody>
    </Dialog>
  )
}
