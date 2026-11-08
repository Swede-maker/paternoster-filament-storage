"use client"

import useSWR from "swr"
import { Download, Loader2, RefreshCw, Trash2, CircleAlert } from "lucide-react"
import { useStore } from "@/lib/store"
import { printerSlotLabel } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import type { Printer } from "@/lib/types"
import type { PrusaLoadedBody } from "@/lib/server/printer-status"
import { Button } from "./ui/button"
import { SpoolDisc } from "./spool"

export function AddonsSection() {
  const { state, dispatch } = useStore()
  const prusaPrinters = state.printers.filter((p) => p.firmware === "prusalink")
  const available = prusaPrinters.length > 0
  const installed = state.settings.addons?.prusaFilament === true

  const setInstalled = (v: boolean) =>
    dispatch({
      type: "UPDATE_SETTINGS",
      settings: { addons: { ...state.settings.addons, prusaFilament: v } },
    })

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground text-pretty">
        Optional features. Nothing here is on until you install it, and removing an addon keeps all your data.
      </p>

      <article
        aria-disabled={!available}
        className={cn(
          "flex flex-col gap-3 rounded-xl border border-border bg-background p-4",
          !available && "opacity-60",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">Prusa filament view</h3>
              {installed && available && (
                <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                  Installed
                </span>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
              Shows the material and color each tool reports in PrusaLink next to the spool you loaded here, so you can
              spot a mismatch before printing. Read-only: Prusa doesn&apos;t let other apps set filament on the printer or
              in PrusaSlicer.
            </p>
          </div>
        </div>

        {!available ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
            Add a printer with PrusaLink firmware to install this addon.
          </p>
        ) : installed ? (
          <>
            <div className="flex flex-col gap-3">
              {prusaPrinters.map((p) => (
                <PrusaLoadedCard key={p.id} printer={p} />
              ))}
            </div>
            <Button variant="outline" className="h-11 self-start" onClick={() => setInstalled(false)}>
              <Trash2 className="h-4 w-4" /> Remove addon
            </Button>
          </>
        ) : (
          <Button className="h-11 self-start" onClick={() => setInstalled(true)}>
            <Download className="h-4 w-4" /> Install
          </Button>
        )}
      </article>
    </div>
  )
}

async function fetchLoaded(printer: Printer): Promise<PrusaLoadedBody> {
  const res = await fetch("/api/prusalink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "loaded", ip: printer.ip, port: printer.port, apiKey: printer.apiKey }),
  })
  const data = (await res.json().catch(() => null)) as PrusaLoadedBody | null
  if (!data) throw new Error("Unexpected response from the printer")
  if (!data.ok) throw new Error(data.error ?? "Could not read the printer")
  return data
}

function PrusaLoadedCard({ printer }: { printer: Printer }) {
  const { state } = useStore()
  const hasIp = !!printer.ip?.trim()
  const { data, error, isValidating, mutate } = useSWR(
    hasIp ? ["prusa-loaded", printer.id, printer.ip, printer.port, printer.apiKey] : null,
    () => fetchLoaded(printer),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )

  const slotCount = Math.max(printer.loaded.length, 1)
  const reported = new Map((data?.tools ?? []).map((t) => [t.index, t]))

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label={printer.name}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="min-w-0 truncate text-sm font-medium">{printer.name}</h4>
        <Button
          variant="ghost"
          size="sm"
          className="h-11 shrink-0"
          disabled={!hasIp || isValidating}
          onClick={() => mutate()}
        >
          {isValidating ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
          Read printer
        </Button>
      </div>

      {!hasIp ? (
        <p className="text-xs text-muted-foreground">Add the printer&apos;s IP address to read it.</p>
      ) : error ? (
        <p className="text-xs text-destructive" role="alert">
          {(error as Error).message}
        </p>
      ) : data && data.tools?.length === 0 ? (
        <p className="text-xs text-muted-foreground text-pretty">
          The printer answered but didn&apos;t report any loaded filament. Some PrusaLink firmware versions don&apos;t
          share it.
        </p>
      ) : null}

      <ul className="flex flex-col divide-y divide-border">
        {Array.from({ length: slotCount }, (_, i) => {
          const spoolId = printer.loaded[i]
          const spool = spoolId ? state.spools[spoolId] : undefined
          const r = reported.get(i)
          const mismatch =
            !!spool && !!r?.material && r.material.toUpperCase() !== String(spool.material).toUpperCase()
          return (
            <li key={i} className="flex items-center gap-3 py-2">
              <span className="w-10 shrink-0 text-xs font-semibold text-muted-foreground">
                {printerSlotLabel(printer, i)}
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {spool ? (
                  <>
                    <SpoolDisc color={spool.color} size={24} />
                    <span className="min-w-0 truncate text-sm">
                      {spool.material} · {spool.colorName}
                    </span>
                  </>
                ) : (
                  <span className="text-sm text-muted-foreground">Empty here</span>
                )}
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-md px-2 py-1 text-xs font-medium",
                  mismatch ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground",
                )}
                title="What the printer reports"
              >
                {data ? (r?.material ?? "None") : "…"}
                {mismatch && <span className="sr-only"> (does not match)</span>}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
