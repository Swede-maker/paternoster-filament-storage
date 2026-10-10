"use client"

import { useEffect, useRef, useState } from "react"
import { useStore } from "@/lib/store"
import type { StorageNode } from "@/lib/types"
import type { BalanceEvent } from "@/lib/node-protocol"
import { balanceTrimFromTimes, chainSyncShelfSideFor, dcTrimPctFor, formatDcTrimPct } from "@/lib/filament"
import { cn } from "@/lib/utils"
import { NumberInput } from "./ui/number-input"

const DEFAULT_TURNS = 3
const MAX_TURNS = 10

/**
 * Automatic Motor balance: both chains start on their trigger point, run N
 * full turns, each sensor's last trigger is timed, and the trim that makes
 * the two times equal is applied. The agent does the measuring; this panel
 * starts it, shows progress, and reports the result.
 */
export function MotorBalanceCalibrate({ node, busy }: { node: StorageNode; busy: boolean }) {
  const { dispatch } = useStore()
  const [turns, setTurns] = useState(DEFAULT_TURNS)
  const [error, setError] = useState<string | null>(null)
  const hardware = node.driver === "hardware"
  const online = !hardware || node.link === "online"
  const bal = node.balance ?? null
  const running = bal?.phase === "running"
  const shelfMotor = chainSyncShelfSideFor(node) === "a" ? "A" : "B"
  const homeMotor = shelfMotor === "A" ? "B" : "A"
  const shelves = node.storage.shelves
  const simTimers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => simTimers.current.forEach(clearTimeout), [])

  const emit = (balance: BalanceEvent) => dispatch({ type: "NODE_BALANCE", nodeId: node.id, balance })

  const simulate = () => {
    // The simulated carousel has one shared position, so its chains always
    // agree; a small fixed lead is invented so the result is visible.
    const prev = dcTrimPctFor(node)
    const lapMs = shelves * 400
    const aMs = turns * lapMs
    const bMs = Math.round(aMs * (1 - 0.0085 * (1 - (prev > 0 ? prev / 100 : 0))))
    simTimers.current.forEach(clearTimeout)
    simTimers.current = []
    emit({ type: "balance", phase: "running", message: `Both motors running ${turns} turns at Motor speed…`, turns, lapsA: 0, lapsB: 0 })
    for (let lap = 1; lap < turns; lap++) {
      simTimers.current.push(
        setTimeout(() => emit({ type: "balance", phase: "running", message: `Motor B: lap ${lap} of ${turns}`, turns, lapsA: lap, lapsB: lap }), 900 * lap),
      )
    }
    simTimers.current.push(
      setTimeout(() => {
        const trimPct = balanceTrimFromTimes(aMs, bMs, prev)
        emit({
          type: "balance",
          phase: "done",
          turns,
          aMs,
          bMs,
          previousTrimPct: prev,
          trimPct,
          clamped: false,
          message: `Motor A ${(aMs / 1000).toFixed(3)} s, motor B ${(bMs / 1000).toFixed(3)} s over ${turns} turns (motor A slower by ${aMs - bMs} ms): balance set to ${trimPct < 0 ? "A" : "B"} −${formatDcTrimPct(trimPct)} %. Home before the next move.`,
        })
      }, 900 * turns + 600),
    )
  }

  const post = async (command: { type: "balance_calibrate"; turns: number } | { type: "stop" }) => {
    setError(null)
    if (!hardware) {
      if (command.type === "balance_calibrate") simulate()
      else {
        simTimers.current.forEach(clearTimeout)
        emit({ type: "balance", phase: "failed", message: "Balance calibration stopped.", turns })
      }
      return
    }
    if (command.type === "balance_calibrate") {
      emit({ type: "balance", phase: "running", message: "Starting…", turns: command.turns, lapsA: 0, lapsB: 0 })
    }
    try {
      const res = await fetch("/api/pi/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: node.ip, port: node.port, command }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `Command failed (${res.status})`)
        if (command.type === "balance_calibrate") emit({ type: "balance", phase: "failed", message: "Could not start.", turns })
      }
    } catch {
      setError("Could not reach the app server.")
      if (command.type === "balance_calibrate") emit({ type: "balance", phase: "failed", message: "Could not start.", turns })
    }
  }

  const canStart = online && !busy && !running

  return (
    <div className="mt-3 rounded-lg border border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Calibrate automatically</p>
        <div className="flex items-center gap-2">
          <label htmlFor={`bal-turns-${node.id}`} className="font-mono text-[11px] text-muted-foreground">
            Turns
          </label>
          <div className="w-20">
            <NumberInput
              id={`bal-turns-${node.id}`}
              min={1}
              max={MAX_TURNS}
              value={turns}
              disabled={running}
              onCommit={(v) => setTurns(Math.max(1, Math.min(MAX_TURNS, Math.round(v))))}
              aria-label="Full carousel turns to time the two chains over"
            />
          </div>
          {running ? (
            <button
              type="button"
              onClick={() => void post({ type: "stop" })}
              className="rounded-md border border-destructive/60 bg-destructive/10 px-3 py-1.5 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/20"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void post({ type: "balance_calibrate", turns })}
              disabled={!canStart}
              className="rounded-md border border-primary/60 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Calibrate balance
            </button>
          )}
        </div>
      </div>

      <ol className="mt-2 list-decimal pl-4 text-xs leading-relaxed text-muted-foreground text-pretty">
        <li>
          Jog motor {shelfMotor} until shelf 1&apos;s flag lights the shelf sensor, and motor {homeMotor} until the home
          flag lights the home sensor. The two chains are now level and both on a trigger point.
        </li>
        <li>
          Press Calibrate. Both motors run {turns} full turn{turns === 1 ? "" : "s"} at Motor speed. The shelf sensor
          must fire {turns} × {shelves} = {turns * shelves} times and the home sensor {turns} time{turns === 1 ? "" : "s"};
          a clock on each counts the milliseconds to its last trigger.
        </li>
        <li>
          The chain that finishes first is held while the other catches up, so both end where they started. The two
          times set the balance exactly, to 0.001 %. Run it again from the new setting to confirm it reads 0 ms.
        </li>
      </ol>

      {bal && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "mt-2 rounded-md border px-3 py-2 text-xs leading-relaxed",
            bal.phase === "failed"
              ? "border-warning/50 bg-warning/10 text-warning"
              : bal.phase === "done"
                ? "border-primary/40 bg-primary/5 text-foreground"
                : "border-border bg-secondary/40 text-foreground",
          )}
        >
          {running && (
            <p className="font-mono text-[11px] text-muted-foreground">
              A lap {bal.lapsA ?? 0}/{bal.turns ?? turns} · B lap {bal.lapsB ?? 0}/{bal.turns ?? turns}
            </p>
          )}
          <p className="text-pretty">{bal.message}</p>
          {bal.phase === "done" && typeof bal.aMs === "number" && typeof bal.bMs === "number" && (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              A {(bal.aMs / 1000).toFixed(3)} s · B {(bal.bMs / 1000).toFixed(3)} s · was{" "}
              {bal.previousTrimPct === 0 || bal.previousTrimPct == null
                ? "equal"
                : `${bal.previousTrimPct < 0 ? "A" : "B"} −${formatDcTrimPct(bal.previousTrimPct)} %`}{" "}
              → now{" "}
              {bal.trimPct === 0 || bal.trimPct == null
                ? "equal"
                : `${bal.trimPct < 0 ? "A" : "B"} −${formatDcTrimPct(bal.trimPct)} %`}
            </p>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {!online && <p className="mt-2 text-xs text-muted-foreground">The agent is offline; connect it to calibrate.</p>}
    </div>
  )
}
