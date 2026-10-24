"use client"

import { useMemo } from "react"
import { ChevronRight, Scale, TriangleAlert } from "lucide-react"
import { useStore } from "@/lib/store"
import { activeNode, shelfLabel } from "@/lib/selectors"
import { cn } from "@/lib/utils"
import { formatGrams, spoolFill } from "@/lib/filament"
import { balanceWarningSetting, buildRebalanceJob, nodeShelfBalance } from "@/lib/rebalance"
import type { StorageNode } from "@/lib/types"
import { SpoolDisc, EmptySlot, discColor2 } from "./spool"
import { Button } from "./ui/button"

function signedGrams(g: number) {
  return `${g > 0 ? "+" : "−"}${formatGrams(Math.abs(g))}`
}

export function ShelfOverview({ node: nodeProp }: { node?: StorageNode } = {}) {
  const { state, dispatch } = useStore()
  const node = nodeProp ?? activeNode(state)
  const shelves = node.slots.length
  const { currentShelf, homed, status } = node.machine
  const canNavigate = homed && status === "idle" && !state.job
  const { weights, deviations } = nodeShelfBalance(state, node)
  const balance = balanceWarningSetting(state)
  const warnOn = balance.enabled && (node.type ?? "paternoster") === "paternoster" && shelves > 1
  const flagged = (shelf: number) => warnOn && Math.abs(deviations[shelf] ?? 0) > balance.thresholdGrams
  const flaggedCount = warnOn ? deviations.filter((d) => Math.abs(d) > balance.thresholdGrams).length : 0

  // Planned up front (and re-planned whenever spools change) so the button only
  // appears when pressing it would actually start a useful queue.
  const containers = state.settings.containers
  const rebalanceJob = useMemo(
    () => (flaggedCount > 0 ? buildRebalanceJob(state, node) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flaggedCount, node.slots, node.machine.currentShelf, state.spools, containers, balance.thresholdGrams],
  )
  const moveCount = rebalanceJob ? rebalanceJob.items.length / 2 : 0

  const startRebalance = () => {
    if (rebalanceJob) dispatch({ type: "START_JOB", job: rebalanceJob })
  }

  return (
    <section aria-label="Shelf overview" className="flex flex-col lg:min-h-0 lg:flex-1">
      <h2 className="px-4 pb-2 pt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Shelf Overview <span className="text-muted-foreground/70">({shelves} shelves)</span>
      </h2>

      {warnOn && (
        <div className="@container mx-4 mb-2">
        <div
          className={cn(
            "flex flex-col gap-2 rounded-lg border px-3 py-2 @[22rem]:flex-row @[22rem]:items-center @[22rem]:gap-3",
            flaggedCount > 0 ? "border-destructive/50 bg-destructive/10" : "border-border bg-secondary/30",
          )}
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
          {flaggedCount > 0 ? (
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          ) : (
            <Scale className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <p className="flex min-w-0 flex-1 flex-col text-xs leading-snug text-pretty">
            <span>
              {flaggedCount > 0 ? (
                <span className="font-medium text-destructive">
                  {flaggedCount === 1 ? "1 shelf" : `${flaggedCount} shelves`} out of balance
                </span>
              ) : (
                <span className="text-muted-foreground">Balanced</span>
              )}
              <span className="text-muted-foreground"> · limit ±{formatGrams(balance.thresholdGrams)}</span>
            </span>
            {flaggedCount > 0 && !rebalanceJob && (
              <span className="text-muted-foreground">
                No better arrangement possible with the current spools
              </span>
            )}
          </p>
          </div>
          {rebalanceJob && (
            <Button
              size="sm"
              variant="primary"
              className="min-h-11 w-full shrink-0 @[22rem]:w-auto"
              disabled={!canNavigate}
              onClick={startRebalance}
            >
              <Scale className="h-4 w-4" aria-hidden />
              Rebalance
              <span className="font-normal opacity-80">
                · {moveCount} {moveCount === 1 ? "move" : "moves"}
              </span>
            </Button>
          )}
        </div>
        </div>
      )}

      <div className="px-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:scrollbar-thin">
        <ul className="@container flex flex-col gap-1 pb-2">
          {Array.from({ length: shelves }).map((_, shelf) => {
            const row = node.slots[shelf] ?? []
            const isCurrent = shelf === currentShelf
            const isFlagged = flagged(shelf)
            const dev = deviations[shelf] ?? 0
            return (
              <li key={shelf}>
                <button
                  type="button"
                  disabled={!canNavigate}
                  onClick={() => dispatch({ type: "GOTO_SHELF", nodeId: node.id, shelf })}
                  aria-current={isCurrent ? "true" : undefined}
                  className={cn(
                    "group flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors",
                    isFlagged
                      ? "border-destructive/60 bg-destructive/10"
                      : isCurrent
                      ? "border-primary/60 bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-secondary/40",
                    !canNavigate && "cursor-default opacity-95",
                  )}
                >
                  <span className="flex w-6 shrink-0 items-center justify-center">
                    {isCurrent ? (
                      <ChevronRight className={cn("h-4 w-4", isFlagged ? "text-destructive" : "text-primary")} />
                    ) : (
                      <span className="h-4 w-4" />
                    )}
                  </span>
                  <span
                    className={cn(
                      "w-5 shrink-0 text-center font-mono text-sm font-semibold",
                      isFlagged ? "text-destructive" : isCurrent ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {shelf + 1}
                  </span>
                  {/* Container query, not viewport: the desktop sidebar is narrower than a
                      phone screen, so the weight stacks under the name there and gets its
                      own column only when the row itself is wide enough. */}
                  <span className="flex min-w-0 flex-1 flex-col @[20rem]:flex-row @[20rem]:items-center @[20rem]:gap-2">
                    <span
                      className={cn(
                        "truncate text-sm @[20rem]:w-14 @[20rem]:shrink-0",
                        isCurrent ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {shelfLabel(node, shelf)}
                    </span>
                    <span className="flex flex-wrap items-baseline gap-x-1.5 leading-tight @[20rem]:w-16 @[20rem]:shrink-0 @[20rem]:flex-col @[20rem]:items-end">
                      <span
                        className={cn(
                          "font-mono text-xs tabular-nums",
                          isFlagged ? "font-semibold text-destructive" : "text-muted-foreground",
                        )}
                      >
                        <span className="sr-only">Shelf weight </span>
                        {formatGrams(weights[shelf] ?? 0)}
                      </span>
                      {isFlagged && (
                        <span className="font-mono text-[11px] tabular-nums text-destructive">
                          <span className="sr-only">Out of balance by </span>
                          {signedGrams(dev)}
                        </span>
                      )}
                    </span>
                  </span>
                  {/* Keep every slot on one line: a tight gap and compact dots let
                      a full shelf fit the sidebar width without wrapping or clipping. */}
                  <span className="flex shrink-0 flex-nowrap items-center justify-end gap-0.5">
                    {row.map((id, slot) => {
                      const spool = id ? state.spools[id] : null
                      return (
                        <span key={slot} className="flex flex-col items-center gap-0.5">
                          {spool ? (
                            <SpoolDisc color={spool.color} color2={discColor2(spool)} size={14} fill={spoolFill(spool)} />
                          ) : (
                            <EmptySlot size={14} />
                          )}
                        </span>
                      )
                    })}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
