"use client"

import { useState } from "react"
import { ArrowLeft, ArrowLeftRight, Printer as PrinterIcon } from "lucide-react"
import { useStore } from "@/lib/store"
import { printerSlotLabel } from "@/lib/selectors"
import { printerSlotCount } from "@/lib/filament"
import type { Spool } from "@/lib/types"
import { SpoolDisc } from "@/components/spool"
import { cn } from "@/lib/utils"

/**
 * Loads a spool that is in the user's hand straight onto a printer slot. No
 * carousel move is involved. Choosing an occupied slot swaps: the spool that
 * was loaded there goes into the user's hand instead.
 */
export function SendToPrinterPicker({
  spool,
  onBack,
  onDone,
}: {
  spool: Spool
  onBack: () => void
  onDone: (message: string) => void
}) {
  const { state, dispatch } = useStore()
  const printers = state.printers
  const [printerId, setPrinterId] = useState<string | null>(printers.length === 1 ? printers[0].id : null)
  const printer = printers.find((p) => p.id === printerId) ?? null

  function load(slot: number) {
    if (!printer) return
    const displacedId = printer.loaded[slot]
    dispatch({ type: "SET_PRINTER_SLOT", printerId: printer.id, slot, spoolId: spool.id })
    dispatch({ type: "UPDATE_SPOOL", id: spool.id, changes: { inHandSince: undefined } })
    const label = printerSlotLabel(printer, slot)
    if (displacedId && displacedId !== spool.id) {
      dispatch({ type: "UPDATE_SPOOL", id: displacedId, changes: { inHandSince: Date.now() } })
      const old = state.spools[displacedId]
      onDone(
        `Loaded ${spool.material} · ${spool.colorName} onto ${printer.name} · ${label}. ${
          old ? `${old.material} · ${old.colorName}` : "The old spool"
        } is now in your hand.`,
      )
    } else {
      onDone(`Loaded ${spool.material} · ${spool.colorName} onto ${printer.name} · ${label}.`)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3">
        <SpoolDisc color={spool.color} color2={spool.dualColor ? spool.color2 : undefined} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {spool.material} · {spool.colorName}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {[spool.brand, `${Math.round(spool.grams)} g`].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      {printers.length === 0 ? (
        <p className="py-6 text-center text-sm leading-relaxed text-muted-foreground">
          No printers yet. Add one under Printers first.
        </p>
      ) : !printer ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Which printer?</p>
          <ul className="flex flex-col gap-2">
            {printers.map((p) => {
              const count = printerSlotCount(p)
              const free = Array.from({ length: count }, (_, i) => i).filter((i) => !p.loaded[i]).length
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setPrinterId(p.id)}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
                  >
                    <PrinterIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{p.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {count} slot{count === 1 ? "" : "s"} · {free} free
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">
            Which slot on <span className="text-primary">{printer.name}</span>?
          </p>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Array.from({ length: printerSlotCount(printer) }, (_, slot) => {
              const occupant = printer.loaded[slot] ? state.spools[printer.loaded[slot] as string] : undefined
              return (
                <li key={slot}>
                  <button
                    type="button"
                    onClick={() => load(slot)}
                    aria-label={`${printerSlotLabel(printer, slot)}: ${
                      occupant ? `swap with ${occupant.material} ${occupant.colorName}` : "empty"
                    }`}
                    className={cn(
                      "flex min-h-16 w-full items-center gap-2 rounded-xl border p-3 text-left transition-colors",
                      occupant
                        ? "border-border bg-card hover:border-warning/60 hover:bg-warning/5"
                        : "border-primary/40 bg-primary/5 hover:bg-primary/15",
                    )}
                  >
                    {occupant ? (
                      <SpoolDisc
                        color={occupant.color}
                        color2={occupant.dualColor ? occupant.color2 : undefined}
                        size={28}
                      />
                    ) : (
                      <span className="h-7 w-7 shrink-0 rounded-full border-2 border-dashed border-primary/50" aria-hidden />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{printerSlotLabel(printer, slot)}</span>
                      <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                        {occupant ? (
                          <>
                            <ArrowLeftRight className="h-3 w-3 shrink-0" aria-hidden />
                            Swap {occupant.material}
                          </>
                        ) : (
                          "Empty"
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => (printer && printers.length > 1 ? setPrinterId(null) : onBack())}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {printer && printers.length > 1 ? "Other printer" : "Back"}
        </button>
      </div>
    </div>
  )
}
