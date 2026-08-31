"use client"

import { useState } from "react"
import { Plus, Minus, Trash2, ArrowDownToLine, Pencil, Check } from "lucide-react"
import { useStore } from "@/lib/store"
import { formatGrams } from "@/lib/filament"
import { partWeightGrams, isPartLow } from "@/lib/selectors"
import { storeMorePart } from "@/lib/hardware-flow"
import { Dialog, DialogFooter } from "../ui/dialog"
import { Button } from "../ui/button"
import { Input, Field } from "../ui/field"
import { PartBox } from "./part-box"
import type { HardwarePart } from "@/lib/types"

/**
 * Slot action hub for a stored hardware box: shows the part identity, then lets
 * the operator take pieces out or store more. Both actions rotate the carousel
 * to the box's slot (via the shared job engine) and apply the count change on
 * confirm. Also offers delete (frees the slot immediately, no motion).
 */
export function HardwareSlotDialog({
  part,
  onClose,
  onEdit,
}: {
  part: HardwarePart | null
  onClose: () => void
  /** Open the edit form for this part (optional; hidden when not provided). */
  onEdit?: (part: HardwarePart) => void
}) {
  const { state, dispatch } = useStore()
  const [mode, setMode] = useState<"menu" | "store">("menu")
  const [count, setCount] = useState("1")

  if (!part) return null

  // Whether this part is already sitting in the take-out queue.
  const queued = state.hwPickQueue.includes(part.id)

  const total = partWeightGrams(part)
  const low = isPartLow(part)
  const n = Math.max(0, Math.round(Number.parseFloat(count) || 0))

  function reset() {
    setMode("menu")
    setCount("1")
  }

  function close() {
    reset()
    onClose()
  }

  function doStore() {
    if (!part || n <= 0) return
    storeMorePart(state, dispatch, part.id, n)
    close()
  }

  return (
    <Dialog open={!!part} onClose={close} title={part.name} className="max-w-md">
      {/* When a photo exists, show it prominently up top; the tote below then
          only carries the slot color. With no photo the tote keeps the glyph. */}
      {part.imageUrl && (
        <img
          src={part.imageUrl || "/placeholder.svg"}
          alt={`Photo of ${part.name}`}
          className="mb-4 h-44 w-full rounded-xl border border-border object-cover"
        />
      )}
      <div className="mb-5 flex items-center gap-4">
        <PartBox color={part.color} size={64} name={part.name} />
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {part.category ? `${part.category} · ` : ""}
            <span className={low ? "font-semibold text-warning" : ""}>{part.count} pcs</span> · {formatGrams(total)}
          </p>
          {part.tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {part.tags.map((t) => (
                <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {mode === "menu" && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {queued ? (
              <Button
                variant="outline"
                className="h-auto flex-col gap-1 py-4 border-primary/50 text-primary"
                onClick={() => {
                  dispatch({ type: "HW_QUEUE_TAKE_REMOVE", partId: part.id })
                  close()
                }}
              >
                <Check className="h-5 w-5" />
                In take-out queue
              </Button>
            ) : (
              <Button
                variant="outline"
                className="h-auto flex-col gap-1 py-4"
                disabled={!!state.job}
                onClick={() => {
                  dispatch({ type: "HW_QUEUE_TAKE_ADD", partId: part.id })
                  close()
                }}
              >
                <Minus className="h-5 w-5" />
                Take out
              </Button>
            )}
            <Button variant="outline" className="h-auto flex-col gap-1 py-4" onClick={() => setMode("store")}>
              <Plus className="h-5 w-5" />
              Store more
            </Button>
          </div>
          {!queued && (
            <p className="px-1 text-center text-[11px] text-muted-foreground text-pretty">
              Adds this part to the take-out queue. Start the run when ready and enter how many to take at the box.
            </p>
          )}
          {onEdit && (
            <Button
              variant="outline"
              className="w-full"
              onClick={() => {
                const p = part
                close()
                onEdit(p)
              }}
            >
              <Pencil className="h-4 w-4" /> Edit details &amp; photo
            </Button>
          )}
        </div>
      )}

      {mode === "store" && (
        <Field label="How many more to add?">
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            value={count}
            autoFocus
            onChange={(e) => setCount(e.target.value)}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            New total <span className="font-mono text-foreground">{part.count + n}</span> pcs ·{" "}
            {formatGrams((part.count + n) * part.perPieceWeightGrams)}.
          </p>
        </Field>
      )}

      <DialogFooter>
        {mode === "menu" ? (
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => {
              if (part) dispatch({ type: "REMOVE_PART", id: part.id })
              close()
            }}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        ) : (
          <Button variant="outline" onClick={reset}>
            Back
          </Button>
        )}
        {mode === "store" && (
          <Button onClick={doStore} disabled={n <= 0 || !!state.job}>
            <ArrowDownToLine className="h-4 w-4" /> Add {n}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  )
}
