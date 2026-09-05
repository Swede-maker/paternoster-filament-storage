"use client"

import { Loader2, CheckCircle2, XCircle, Clock, Trash2, Inbox } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStore } from "@/lib/store"
import { getNode, shelfLabel } from "@/lib/selectors"
import type { DispenseRequest, DispenseStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

const STATUS_META: Record<DispenseStatus, { label: string; Icon: typeof Clock; color: string }> = {
  pending: { label: "Queued", Icon: Clock, color: "text-warning" },
  running: { label: "Running", Icon: Loader2, color: "text-primary" },
  done: { label: "Done", Icon: CheckCircle2, color: "text-success" },
  error: { label: "Failed", Icon: XCircle, color: "text-destructive" },
  canceled: { label: "Canceled", Icon: XCircle, color: "text-muted-foreground" },
}

function Row({ req }: { req: DispenseRequest }) {
  const { state, dispatch } = useStore()
  const node = getNode(state, req.nodeId)
  const location = node ? `${node.name} · ${shelfLabel(node, req.shelf)} · Slot ${req.slot + 1}` : `${req.nodeId} · shelf ${req.shelf} · slot ${req.slot}`
  const spool = req.spoolId ? state.spools[req.spoolId] : null
  const meta = STATUS_META[req.status]
  const finished = req.status === "done" || req.status === "error" || req.status === "canceled"

  return (
    <li className="flex items-center gap-3 rounded-lg border border-border bg-background/50 p-3">
      <meta.Icon className={cn("h-4 w-4 shrink-0", meta.color, req.status === "running" && "animate-spin")} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {spool ? `${spool.material} · ${spool.colorName}` : "Dispense request"}
        </p>
        <p className="truncate text-xs text-muted-foreground">{location}</p>
        {req.status === "error" && req.error && (
          <p className="mt-0.5 truncate text-xs text-destructive">{req.error}</p>
        )}
      </div>
      <span className={cn("shrink-0 text-xs font-medium", meta.color)}>{meta.label}</span>
      {finished && (
        <button
          type="button"
          onClick={() => dispatch({ type: "REMOVE_DISPENSE", id: req.id })}
          aria-label="Remove request"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </li>
  )
}

/**
 * Live view of the dispense queue fed by the printer API. Newest first. An open
 * PAX screen runs each pending request via the normal guided pick (see
 * flow-controller), so statuses advance here in real time.
 */
export function DispenseQueue() {
  const { state, dispatch } = useStore()
  const requests = [...state.dispenseRequests].sort((a, b) => b.createdAt - a.createdAt)
  const hasFinished = requests.some((r) => r.status === "done" || r.status === "error" || r.status === "canceled")

  return (
    <section className="rounded-xl border border-border bg-card/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Dispense queue</h3>
        {hasFinished && (
          <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "CLEAR_DISPENSE_DONE" })}>
            <Trash2 className="h-4 w-4" /> Clear finished
          </Button>
        )}
      </div>

      {requests.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background/40 py-8 text-center">
          <Inbox className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground text-pretty">
            No dispense requests yet. When a printer calls the dispense endpoint, it appears here and PAX runs the pick.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {requests.map((r) => (
            <Row key={r.id} req={r} />
          ))}
        </ul>
      )}
    </section>
  )
}
