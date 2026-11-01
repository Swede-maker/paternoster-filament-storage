"use client"

import { useMemo } from "react"
import { ChevronDown, Scale, TriangleAlert } from "lucide-react"
import { useStore } from "@/lib/store"
import { activeNode } from "@/lib/selectors"
import { sectionLabel } from "@/lib/orientation"
import { cn } from "@/lib/utils"
import { formatGrams, spoolFill } from "@/lib/filament"
import { balanceWarningSetting, buildRebalanceJob, nodeShelfBalance } from "@/lib/rebalance"
import type { StorageNode } from "@/lib/types"
import { SpoolDisc, EmptySlot, discColor2 } from "@/components/spool"
import { Button } from "@/components/ui/button"

/**
 * Section overview for a vertical carousel: one compact column per section in
 * a horizontally scrolling strip, mirroring the side-by-side carousel below.
 * Tap a section to rotate it into the access window.
 */
export function SectionOverviewStrip({
  node: nodeProp,
  className,
}: { node?: StorageNode; className?: string } = {}) {
  const { state, dispatch } = useStore()
  const node = nodeProp ?? activeNode(state)
  const sections = node.slots.length
  const { currentShelf, homed, status } = node.machine
  const canNavigate = homed && status === "idle" && !state.job
  const { weights, deviations } = nodeShelfBalance(state, node)
  const balance = balanceWarningSetting(state)
  const warnOn = balance.enabled && sections > 1
  const flagged = (i: number) => warnOn && Math.abs(deviations[i] ?? 0) > balance.thresholdGrams
  const flaggedCount = warnOn ? deviations.filter((d) => Math.abs(d) > balance.thresholdGrams).length : 0

  const containers = state.settings.containers
  const rebalanceJob = useMemo(
    () => (flaggedCount > 0 ? buildRebalanceJob(state, node) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flaggedCount, node.slots, node.machine.currentShelf, state.spools, containers, balance.thresholdGrams],
  )
  const moveCount = rebalanceJob ? rebalanceJob.items.length / 2 : 0

  return (
    <section aria-label="Section overview" className={cn("flex min-w-0 shrink-0 flex-col rounded-2xl border border-border bg-panel", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Section Overview <span className="text-muted-foreground/70">({sections} sections)</span>
        </h2>
        {warnOn && (
          <div className="flex items-center gap-2 text-xs">
            {flaggedCount > 0 ? (
              <TriangleAlert className="h-4 w-4 text-destructive" aria-hidden />
            ) : (
              <Scale className="h-4 w-4 text-muted-foreground" aria-hidden />
            )}
            <span className={flaggedCount > 0 ? "font-medium text-destructive" : "text-muted-foreground"}>
              {flaggedCount > 0
                ? `${flaggedCount === 1 ? "1 section" : `${flaggedCount} sections`} out of balance`
                : "Balanced"}
            </span>
            <span className="text-muted-foreground">· limit ±{formatGrams(balance.thresholdGrams)}</span>
            {rebalanceJob && (
              <Button
                size="sm"
                variant="primary"
                disabled={!canNavigate}
                onClick={() => dispatch({ type: "START_JOB", job: rebalanceJob })}
              >
                <Scale className="h-4 w-4" aria-hidden />
                Rebalance · {moveCount} {moveCount === 1 ? "move" : "moves"}
              </Button>
            )}
          </div>
        )}
      </div>

      <ul className="flex gap-2 overflow-x-auto px-3 pb-3 scrollbar-thin">
        {Array.from({ length: sections }).map((_, i) => {
          const col = node.slots[i] ?? []
          const isCurrent = i === currentShelf
          const isFlagged = flagged(i)
          return (
            <li key={i} className="shrink-0">
              <button
                type="button"
                disabled={!canNavigate}
                onClick={() => dispatch({ type: "GOTO_SHELF", nodeId: node.id, shelf: i })}
                aria-current={isCurrent ? "true" : undefined}
                aria-label={`${sectionLabel(node, i)}, ${formatGrams(weights[i] ?? 0)}`}
                className={cn(
                  "flex w-20 flex-col items-center gap-1.5 rounded-xl border px-2 pb-2 pt-1.5 transition-colors",
                  isFlagged
                    ? "border-destructive/60 bg-destructive/10"
                    : isCurrent
                      ? "border-primary/60 bg-primary/10"
                      : "border-border/60 hover:border-border hover:bg-secondary/40",
                  !canNavigate && "cursor-default opacity-95",
                )}
              >
                <span className="flex h-4 items-center">
                  {isCurrent && (
                    <ChevronDown className={cn("h-4 w-4", isFlagged ? "text-destructive" : "text-primary")} />
                  )}
                </span>
                <span
                  className={cn(
                    "max-w-full truncate text-xs font-semibold",
                    isFlagged ? "text-destructive" : isCurrent ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {sectionLabel(node, i)}
                </span>
                <span
                  className={cn(
                    "font-mono text-[11px] tabular-nums",
                    isFlagged ? "font-semibold text-destructive" : "text-muted-foreground",
                  )}
                >
                  {formatGrams(weights[i] ?? 0)}
                </span>
                <span className="flex flex-col items-center gap-0.5">
                  {col.map((id, slot) => {
                    const spool = id ? state.spools[id] : null
                    return spool ? (
                      <SpoolDisc
                        key={slot}
                        color={spool.color}
                        color2={discColor2(spool)}
                        size={14}
                        fill={spoolFill(spool)}
                      />
                    ) : (
                      <EmptySlot key={slot} size={14} />
                    )
                  })}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
