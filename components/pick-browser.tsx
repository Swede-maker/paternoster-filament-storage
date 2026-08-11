"use client"

import { useMemo, useState } from "react"
import { Search, X, PackagePlus } from "lucide-react"
import { useStore } from "@/lib/store"
import { Dialog, DialogHeader, DialogBody } from "./ui/dialog"
import { Input } from "./ui/field"
import { SpoolDisc } from "./spool"
import { storedSpools, searchSpools } from "@/lib/selectors"
import { formatGrams, isLightColor, spoolFill } from "@/lib/filament"
import type { Spool } from "@/lib/types"

/** Storage location qualified by node, matching flow-controller's NodeLocation. */
export interface BrowserLocation {
  nodeId: string
  shelf: number
  slot: number
}

/**
 * Browse / search all stored filament. Tapping a spool calls onPick with its
 * spool + storage location. `excludeIds` hides spools already queued.
 */
export function PickBrowser({
  open,
  onClose,
  onPick,
  onInspect,
  onNew,
  excludeIds = [],
  title = "Pick filament from storage",
  readOnly = false,
}: {
  open: boolean
  onClose: () => void
  /** When omitted (or readOnly), tapping a spool does nothing — pure search. */
  onPick?: (spool: Spool, loc: BrowserLocation) => void
  /** When provided (and no onPick), tapping a spool opens an action menu
   *  (load onto a printer / take out / cancel). */
  onInspect?: (spool: Spool, loc: BrowserLocation) => void
  /** When provided, shows a "Create new spool" option that loads a fresh spool
   *  straight onto the printer (no storage step). */
  onNew?: () => void
  excludeIds?: string[]
  title?: string
  readOnly?: boolean
}) {
  const { state } = useStore()
  const [q, setQ] = useState("")

  const entries = useMemo(() => {
    const all = storedSpools(state).filter((e) => !excludeIds.includes(e.spool.id))
    return searchSpools(all, q)
  }, [state, q, excludeIds])

  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl">
      <DialogHeader
        icon={<Search className="h-5 w-5" />}
        title={title}
        description={
          onInspect && !onPick
            ? "Tap a spool to load it onto a printer or take it out."
            : readOnly
              ? "Browse all filament in storage."
              : onNew
                ? "Pick a stored spool, or create a brand-new one."
                : "Tap a spool to add it to the queue."
        }
      />
      <DialogBody className="space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search color, type, brand, slot…"
            className="pl-10"
            autoFocus
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {onNew && !readOnly && (
          <button
            type="button"
            onClick={onNew}
            className="flex w-full items-center gap-3 rounded-xl border border-dashed border-primary/50 bg-primary/5 p-3 text-left transition-colors hover:border-primary hover:bg-primary/10"
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <PackagePlus className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-primary">Create new spool</span>
              <span className="block text-xs text-muted-foreground">
                A fresh spool you have in hand — loads straight onto the printer.
              </span>
            </span>
          </button>
        )}

        {entries.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {q
              ? "No filament matches your search."
              : onNew
                ? "No stored filament yet — create a new spool above."
                : "No filament in storage yet."}
          </p>
        ) : (
          <ul className="grid max-h-[50vh] grid-cols-2 gap-2 overflow-y-auto scrollbar-thin sm:grid-cols-3">
            {entries.map(({ spool, loc, nodeId, nodeName, shelfName }) => (
              <li key={spool.id}>
                <button
                  type="button"
                  disabled={!onPick && !onInspect}
                  onClick={() => {
                    const nodeLoc = { nodeId, shelf: loc.shelf, slot: loc.slot }
                    if (onPick) onPick(spool, nodeLoc)
                    else onInspect?.(spool, nodeLoc)
                  }}
                  className={
                    "flex w-full flex-col items-center gap-2 rounded-xl border border-border bg-background/50 p-3 text-center transition-colors " +
                    (!onPick && !onInspect ? "cursor-default" : "hover:border-primary/60 hover:bg-primary/5")
                  }
                >
                  <SpoolDisc color={spool.color} size={56} fill={spoolFill(spool)} boxed={!!spool.containerId} />
                  <span
                    className="text-sm font-semibold"
                    style={{ color: isLightColor(spool.color) ? "#d4d4d8" : spool.color }}
                  >
                    {spool.material}
                  </span>
                  <span className="text-xs text-muted-foreground">{spool.colorName}</span>
                  <span className="text-[11px] text-muted-foreground/80">
                    {spool.brand} · {formatGrams(spool.grams)}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground/70">
                    {state.nodes.length > 1 ? `${nodeName} · ` : ""}
                    {shelfName} · Slot {loc.slot + 1}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
    </Dialog>
  )
}
