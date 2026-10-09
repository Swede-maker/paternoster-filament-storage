"use client"

import { useState } from "react"
import { twinSiblingOf, useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { ManualControl } from "../manual-control"
import type { StorageNode } from "@/lib/types"

type TwinView = "left" | "right" | "both"

const OPTIONS: { id: TwinView; label: string }[] = [
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "both", label: "Both" },
]

/**
 * Manual control for a hardware unit. Twin carousels (two carousels on one Pi)
 * get a Left / Right / Both switch; "Both" shows one panel whose every command
 * is sent to both carousels, so they jog, home and stop together.
 */
export function TwinManualControl({ node }: { node: StorageNode }) {
  const { state } = useStore()
  const sibling = twinSiblingOf(state, node)
  const [view, setView] = useState<TwinView | null>(null)

  if (!node.twinSide || !sibling) return <ManualControl node={node} />

  const left = node.twinSide === "left" ? node : sibling
  const right = node.twinSide === "right" ? node : sibling
  const current: TwinView = view ?? node.twinSide

  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3">
        <div role="radiogroup" aria-label="Carousel to control" className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={current === o.id}
              onClick={() => setView(o.id)}
              className={cn(
                "h-11 rounded-md text-sm font-semibold transition-colors",
                current === o.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {current === "left" && <ManualControl node={left} />}
      {current === "right" && <ManualControl node={right} />}
      {current === "both" && (
        <>
          <p className="px-4 pt-4 text-xs text-muted-foreground">
            Every button and slider below acts on <span className="font-semibold text-foreground">both</span> carousels at
            once. Status shows the left one; switch to Left or Right to see each on its own.
          </p>
          <ManualControl node={left} twin={right} />
        </>
      )}
    </div>
  )
}
