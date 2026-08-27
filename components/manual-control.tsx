"use client"

import { ArrowUp, ArrowDown, Home, Loader2, OctagonX, Play } from "lucide-react"
import { useStore } from "@/lib/store"
import { activeNode } from "@/lib/selectors"
import { DEFAULT_RAMP_PCT, HOMING_DUTY_RATIO, homingDutyFor, moveDutyFor, approachDutyFor } from "@/lib/filament"
import { Button } from "./ui/button"
import { cn } from "@/lib/utils"

export function ManualControl() {
  const { state, dispatch } = useStore()
  const node = activeNode(state)
  const { currentShelf, homed, status } = node.machine
  const idle = status === "idle" && !state.job
  // A hardware unit whose Pi agent isn't connected cannot be commanded at all:
  // the store refuses the action, so the controls must say so rather than look
  // live and do nothing.
  const offline = node.driver === "hardware" && node.link !== "online"
  // "checking" (handshake still hanging) and "offline" (socket rejected/closed)
  // have OPPOSITE causes — dropped packets or a wrong address vs. nothing
  // listening — so they must never look the same while diagnosing.
  const checking = node.driver === "hardware" && node.link === "checking"
  // Jogging is RELATIVE ("one shelf up/down"), so unlike absolute shelf
  // navigation it does not need a home reference. Requiring `homed` here left a
  // carousel with a failed home completely immobile from the UI — the operator
  // could not nudge the motor to diagnose the very sensor fault that blocked
  // homing. The agent allows relative moves un-homed; the UI must not veto them.
  const canJog = idle && !offline

  // Speed controls only apply to a motorized carousel, not manual shelf storage.
  const isCarousel = node.type !== "shelf"
  const rampPct = node.rampPct ?? DEFAULT_RAMP_PCT
  // Resolved through the same helper the Pi is configured from, so the slider
  // shows the duty homing will actually use — including while it is tracking the
  // move duty, rather than sitting at a placeholder.
  const homingDuty = homingDutyFor(node)
  // Same helper the Pi is configured from, so the slider shows the duty the
  // final approach will actually use — including the default crawl.
  const approachDuty = approachDutyFor(node)

  const statusLabel = (() => {
    switch (status) {
      case "homing":
        return "Homing…"
      case "moving":
        return "Moving…"
      case "awaiting-move-confirm":
        return "Waiting for confirm"
      case "awaiting-pick-confirm":
        return "Ready to pick"
      case "awaiting-store-confirm":
        return "Ready to store"
      case "stopped":
        return "Emergency stopped"
      default:
        return homed ? "Positioning OK" : "Not homed"
    }
  })()

  const busy = status === "homing" || status === "moving"
  // Emergency-stopped: frozen in place until the operator resumes or re-homes.
  const stopped = isCarousel && status === "stopped"
  // What "Continue task" will pick back up, so we can label it meaningfully.
  const resume = node.machine.resumeStatus
  const canResume =
    resume === "moving" ||
    resume === "homing" ||
    resume === "awaiting-move-confirm" ||
    resume === "awaiting-pick-confirm" ||
    resume === "awaiting-store-confirm"
  const resumeLabel =
    resume === "homing" ? "Resume homing" : resume === "moving" ? "Continue moving" : "Continue task"

  return (
    <section aria-label="Manual control" className="border-t border-border px-4 py-4">
      <h2 className="pb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Manual Control</h2>

      {/* Explain up front why the motion controls are dead, so a disconnected
          unit can't be mistaken for a broken one. */}
      {offline && (
        <div className="mb-3 rounded-xl border border-warning/40 bg-warning/10 p-3">
          <p className="text-sm font-semibold text-foreground">
            {checking ? "Connecting to Pi agent…" : "Pi agent not connected"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {checking
              ? "The handshake has not completed. If it stays here, the packets are being dropped (firewall) or the address is wrong — a Pi that is up but idle refuses instantly instead."
              : (node.linkError ??
                "This unit is offline, so the motor cannot be commanded. Check the agent in Settings.")}
          </p>
          {/* The address the server is actually dialling — the fastest way to
              spot a unit still pointing at the wrong host. */}
          <p className="mt-2 font-mono text-[11px] text-muted-foreground/80">
            {`ws://${node.ip}:${node.port}`}
          </p>
        </div>
      )}

      {/* Connected but faking it. This is the dangerous case: everything looks
          healthy and motion animates normally while the motor never turns. */}
      {node.driver === "hardware" && node.link === "online" && node.agentSimulated && (
        <div className="mb-3 rounded-xl border border-destructive/50 bg-destructive/10 p-3">
          <p className="text-sm font-semibold text-foreground">Agent is simulating — motor will not move</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The Pi agent is connected but reporting fake motion, so the app animates while the GPIO pins stay idle.
            {node.agentSimReason ? ` Reason: ${node.agentSimReason}` : ""}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Remove <span className="font-mono">--simulate</span> from the service, or install the Pi 5 pin factory with{" "}
            <span className="font-mono">sudo apt install -y python3-lgpio</span>, then restart the agent.
          </p>
        </div>
      )}

      {stopped ? (
        /* Frozen after an emergency stop: the carousel stays put until the
           operator explicitly resumes the task or re-homes. */
        <div className="rounded-xl border-2 border-destructive bg-destructive/10 p-3">
          <div className="flex items-center gap-2 text-destructive">
            <OctagonX className="h-5 w-5 shrink-0" />
            <div>
              <p className="text-sm font-bold uppercase tracking-wider">Emergency stopped</p>
              <p className="text-xs text-destructive/80">Carousel held at shelf {currentShelf + 1}. It won&apos;t move until you choose below.</p>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2">
            {canResume && (
              <Button size="md" className="w-full" onClick={() => dispatch({ type: "RESUME_MOVE", nodeId: node.id })}>
                <Play className="h-4 w-4" />
                {resumeLabel}
              </Button>
            )}
            <Button
              variant="outline"
              size="md"
              className="w-full"
              disabled={offline}
              onClick={() => {
                // Homing abandons any in-progress task, so clear the job too.
                if (state.job) dispatch({ type: "CANCEL_JOB" })
                dispatch({ type: "HOME_START", nodeId: node.id })
              }}
            >
              <Home className="h-4 w-4" />
              Home Carousel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Emergency stop — paternoster only. Always available so it can halt
              the carousel the instant something goes wrong; the carousel then
              freezes in place until resumed or re-homed. */}
          {isCarousel && (
            <button
              type="button"
              onClick={() => dispatch({ type: "EMERGENCY_STOP", nodeId: node.id })}
              aria-label="Emergency stop carousel"
              className={cn(
                "mb-3 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-destructive py-3 text-sm font-bold uppercase tracking-wider text-destructive transition-colors",
                "bg-destructive/10 hover:bg-destructive hover:text-destructive-foreground active:scale-[0.99]",
                busy && "animate-pulse",
              )}
            >
              <OctagonX className="h-5 w-5" />
              Emergency Stop
            </button>
          )}

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={!canJog}
              onClick={() => dispatch({ type: "MANUAL_MOVE", nodeId: node.id, direction: "up" })}
              className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-border bg-secondary/40 text-foreground transition-colors hover:border-primary/50 hover:bg-secondary/70 disabled:opacity-40"
            >
              <ArrowUp className="h-6 w-6 text-primary" />
              <span className="text-xs font-medium">Move Up</span>
            </button>
            <button
              type="button"
              disabled={!canJog}
              onClick={() => dispatch({ type: "MANUAL_MOVE", nodeId: node.id, direction: "down" })}
              className="flex h-20 flex-col items-center justify-center gap-1 rounded-xl border border-border bg-secondary/40 text-foreground transition-colors hover:border-primary/50 hover:bg-secondary/70 disabled:opacity-40"
            >
              <ArrowDown className="h-6 w-6 text-primary" />
              <span className="text-xs font-medium">Move Down</span>
            </button>
          </div>

          <Button
            variant="outline"
            size="md"
            className="mt-3 w-full"
            disabled={busy || offline}
            onClick={() => dispatch({ type: "HOME_START", nodeId: node.id })}
          >
            {status === "homing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Home className="h-4 w-4" />}
            Home Carousel
          </Button>
        </>
      )}

      {isCarousel && (
        <div className="mt-4 rounded-xl border border-border bg-background/50 p-3">
          {/* The "Carousel Speed" (seconds-per-shelf) slider used to sit here. It
              is gone: speed is set directly by the PWM duty slider, which is the
              single source of truth for how fast the motor turns. Two controls for
              one physical quantity meant the seconds-per-shelf value silently
              fought the duty the operator had actually dialled in. Position is
              known from homing plus shelf-sensor counting — never from elapsed
              time — so nothing here needs a seconds-per-shelf figure. */}

          {/* Acceleration ramp only — how gently the carousel gets moving, plus
              how gently it eases to the slower approach duty for the final shelf.
              It deliberately does NOT soften the stop: arrival cuts power the
              instant the shelf sensor triggers, because any ramp there keeps the
              motor driving after the flag is detected and carries it straight
              back out of the sensor window. */}
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Soft start</p>
            <span className="font-mono text-xs text-foreground">
              {rampPct === 0 ? "Off" : `${rampPct}%`}
            </span>
          </div>
          <input
            type="range"
            aria-label="Soft start ramp intensity (percent)"
            min={0}
            max={100}
            step={5}
            value={rampPct}
            disabled={busy}
            onChange={(e) => dispatch({ type: "SET_NODE_RAMP", nodeId: node.id, rampPct: Number(e.target.value) })}
            className="mt-2 w-full accent-[var(--color-primary)] disabled:opacity-40"
          />
          <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>Sharp</span>
            <span>Gentle</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            Affects starting only. Stopping is always immediate — the motor cuts
            the moment the shelf sensor triggers.
          </p>

          {/* Direct PWM duty. The speed slider above is in seconds-per-shelf and
              its duty curve is clamped to 25–100%, which cannot express the very
              low duties a heavy carousel needs to stop coasting past the sensor
              flag. This sends the duty to the motor as-is. */}
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Motor PWM</p>
            <span className="font-mono text-xs text-foreground">
              {node.pwmDuty === undefined ? "Auto" : `${Math.round(node.pwmDuty * 100)}%`}
            </span>
          </div>
          <input
            type="range"
            aria-label="Direct motor PWM duty (percent)"
            min={5}
            max={100}
            step={1}
            value={Math.round((node.pwmDuty ?? moveDutyFor(node)) * 100)}
            disabled={busy}
            onChange={(e) =>
              dispatch({ type: "SET_NODE_PWM", nodeId: node.id, pwmDuty: Number(e.target.value) / 100 })
            }
            className="mt-2 w-full accent-[var(--color-primary)] disabled:opacity-40"
          />
          <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>5%</span>
            <span>100%</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            Sets the motor speed directly. Lower it until the carousel stops overshooting the shelf
            sensor.
          </p>

          {/* Homing duty, separate from the move duty above. Homing hunts a
              single index flag from an unknown start, so it is the move most
              likely to sail past its target — and the costliest to get wrong,
              because every later shelf position is measured from where homing
              decided "zero" is. Left untouched it tracks the move duty. */}
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Homing PWM</p>
            <span className="font-mono text-xs text-foreground">
              {node.homingDuty === undefined
                ? `Auto · ${Math.round(homingDuty * 100)}%`
                : `${Math.round(homingDuty * 100)}%`}
            </span>
          </div>
          <input
            type="range"
            aria-label="Homing motor PWM duty (percent)"
            min={5}
            max={100}
            step={1}
            value={Math.round(homingDuty * 100)}
            disabled={busy}
            onChange={(e) =>
              dispatch({
                type: "SET_NODE_HOMING_PWM",
                nodeId: node.id,
                homingDuty: Number(e.target.value) / 100,
              })
            }
            className="mt-2 w-full accent-[var(--color-primary)] disabled:opacity-40"
          />
          <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>5%</span>
            <span>100%</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {node.homingDuty === undefined ? (
              <>Following Motor PWM at {Math.round(HOMING_DUTY_RATIO * 100)}%. Drag to set it yourself.</>
            ) : (
              <>
                Set manually.{" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    dispatch({ type: "SET_NODE_HOMING_PWM", nodeId: node.id, homingDuty: undefined })
                  }
                  className="underline underline-offset-2 transition-colors hover:text-foreground disabled:opacity-40"
                >
                  Follow Motor PWM
                </button>{" "}
                instead.
              </>
            )}
          </p>

          {/* Slow approach duty for the FINAL shelf. The carousel eases down to
              this speed just before the target so the shelf flag is caught gently
              instead of overshot. Separate from Motor PWM (the cruise between
              shelves): a heavy carousel wants a brisk cruise but a slow arrival. */}
          <div className="mt-4 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Approach speed</p>
            <span className="font-mono text-xs text-foreground">
              {node.approachDuty === undefined
                ? `Auto · ${Math.round(approachDuty * 100)}%`
                : `${Math.round(approachDuty * 100)}%`}
            </span>
          </div>
          <input
            type="range"
            aria-label="Slow approach PWM duty for the final shelf (percent)"
            min={5}
            max={100}
            step={1}
            value={Math.round(approachDuty * 100)}
            disabled={busy}
            onChange={(e) =>
              dispatch({
                type: "SET_NODE_APPROACH_PWM",
                nodeId: node.id,
                approachDuty: Number(e.target.value) / 100,
              })
            }
            className="mt-2 w-full accent-[var(--color-primary)] disabled:opacity-40"
          />
          <div className="flex justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
            <span>Gentle</span>
            <span>Fast</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            {node.approachDuty === undefined ? (
              <>Default gentle crawl. Drag to set the speed the carousel slows to before the target shelf.</>
            ) : (
              <>
                Set manually.{" "}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    dispatch({ type: "SET_NODE_APPROACH_PWM", nodeId: node.id, approachDuty: undefined })
                  }
                  className="underline underline-offset-2 transition-colors hover:text-foreground disabled:opacity-40"
                >
                  Reset to default
                </button>{" "}
                crawl.
              </>
            )}
          </p>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-border bg-background/50 p-3">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Current Position</p>
        <p className="mt-0.5 font-mono text-2xl font-bold text-primary">
          {homed ? `Shelf ${currentShelf + 1}` : "—"}
        </p>
        <p className="mt-1 flex items-center gap-2 text-xs">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              busy ? "bg-warning animate-pulse" : homed ? "bg-success" : "bg-muted-foreground",
            )}
          />
          <span className={cn(busy ? "text-warning" : homed ? "text-success" : "text-muted-foreground")}>
            {statusLabel}
          </span>
        </p>
      </div>
    </section>
  )
}
