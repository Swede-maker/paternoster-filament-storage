"use client"

import { useState } from "react"
import { ArrowDown, ArrowUp, Hand, Loader2, Lock, ShieldAlert, ShieldCheck, X } from "lucide-react"
import { useStore } from "@/lib/store"
import {
  MIN_SERVO_JOG_PULSES,
  MAX_SERVO_JOG_PULSES,
  MIN_DC_JOG_MS,
  MAX_DC_JOG_MS,
  dcJogMsFor,
  isServoNode,
  moveDutyFor,
  servoHoldTimeoutFor,
  servoJogPulsesFor,
  servoGearRatioFor,
  servoPulsesToSprocketDegrees,
  } from "@/lib/filament"
import type { JogCommand, ServoMotorId } from "@/lib/node-protocol"
import type { StorageNode } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Quick-pick jog sizes in pulses (servo). 40 @ 4000 ppr = 3.6°, 1000 = a quarter turn. */
const SERVO_PRESETS = [10, 40, 100, 400, 1000]
/** Quick-pick jog sizes in milliseconds (DC). */
const DC_PRESETS = [50, 100, 150, 300, 600, 1000]

/**
 * Per-motor alignment tools for the two chain motors (A on one side, B on the
 * other): nudge motor A, motor B or both, with an adjustable step size.
 *
 * The unit follows the drive. The iSV57T servos take an exact pulse count,
 * so a tap is "N pulses". A DC bridge has no step unit, so a tap is "run for
 * N milliseconds" at the unit's move duty. Both solve the same problem: the
 * shelves hang a few millimetres off level after assembly or a slipped
 * coupling, and nudging ONE motor fixes it without touching the other. The
 * servo drives' ALM lamps are shown only in servo mode.
 */
export function ServoJogPanel({ node }: { node: StorageNode }) {
  const { state, dispatch } = useStore()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Nothing selected by default so a stray tap on the big arrows does nothing.
  const [selected, setSelected] = useState<ServoMotorId | null>(null)

  const servo = isServoNode(node)
  const hardware = node.driver === "hardware"
  const online = !hardware || node.link === "online"
  const idle = node.machine.status === "idle" && !state.job
  const jogPulses = servoJogPulsesFor(node)
  const jogMs = dcJogMsFor(node)
  const geared = servoGearRatioFor(node) !== 1
  // Degrees at the sprocket are what move the shelves; with no gearbox this
  // is the same as the motor-shaft angle.
  const degrees = servoPulsesToSprocketDegrees(node, jogPulses)
  const alarmA = servo && node.servo?.alarmA === true
  const alarmB = servo && node.servo?.alarmB === true
  const jogging = node.servo?.jogging === true && node.machine.status === "moving"
  // The agent must have confirmed the SAME drive we are about to jog in, or
  // the amount would be in the wrong unit. An agent that has never sent a
  // drive frame is older than pax-agent-1.3 (DC) / 1.2 (servo).
  const agentReady = !hardware || node.servo?.mode === (servo ? "servo" : "dc")
  const canJog = idle && online && agentReady && !pending

  // Hold state from the agent (pax-agent-1.4+). Unknown until the first
  // servo frame that carries it; treat unknown as "holding" so the button
  // offers the safe action (release) rather than a no-op.
  const [mockHeld, setMockHeld] = useState(true)
  const held = !servo ? true : hardware ? node.servo?.held !== false : mockHeld
  const holdTimeout = servoHoldTimeoutFor(node)
  const canRelease = servo && idle && online && agentReady && !pending

  const setHold = async (release: boolean) => {
    setError(null)
    setPending(release ? "release" : "hold")
    if (!hardware) {
      // Simulated unit: flip the lamp locally so the control can be exercised.
      setMockHeld(!release)
      setTimeout(() => setPending(null), 250)
      return
    }
    try {
      const res = await fetch("/api/pi/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: node.ip, port: node.port, command: { type: release ? "release" : "hold" } }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `${release ? "Release" : "Hold"} failed (${res.status})`)
      }
    } catch {
      setError("Could not reach the app server.")
    } finally {
      setPending(null)
    }
  }

  const step = servo ? jogPulses : jogMs
  const stepMin = servo ? MIN_SERVO_JOG_PULSES : MIN_DC_JOG_MS
  const stepMax = servo ? MAX_SERVO_JOG_PULSES : MAX_DC_JOG_MS
  // Behind a gearbox the base presets barely move the sprocket, so scale them
  // by the ratio (1:50 → 500 … 20 000 pulses) and drop any over the agent cap.
  const presets = servo
    ? Array.from(
        new Set(SERVO_PRESETS.map((p) => Math.min(stepMax, Math.round(p * servoGearRatioFor(node))))),
      )
    : DC_PRESETS
  const unit = servo ? "pulses" : "ms"

  const jog = async (motor: ServoMotorId, direction: "up" | "down") => {
    setError(null)
    if (!hardware) {
      // Simulated unit: there is no chain to align, so just acknowledge.
      setPending(`${motor}:${direction}`)
      setTimeout(() => setPending(null), 250)
      return
    }
    setPending(`${motor}:${direction}`)
    const command: JogCommand = servo
      ? { type: "jog", motor, direction, pulses: jogPulses }
      : { type: "jog", motor, direction, ms: jogMs, speed: moveDutyFor(node) }
    try {
      const res = await fetch("/api/pi/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: node.ip, port: node.port, command }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setError(body?.error ?? `Jog failed (${res.status})`)
      }
    } catch {
      setError("Could not reach the app server.")
    } finally {
      setPending(null)
    }
  }

  const setStep = (value: number) => {
    const clamped = Math.max(stepMin, Math.min(stepMax, Math.round(value)))
    dispatch({
      type: "UPDATE_NODE",
      id: node.id,
      changes: servo ? { servoJogPulses: clamped } : { dcJogMs: clamped },
    })
  }

  const MOTORS: { id: ServoMotorId; label: string; alarm?: boolean }[] = [
    { id: "a", label: "Motor A", alarm: alarmA },
    { id: "b", label: "Motor B", alarm: alarmB },
    { id: "both", label: "Both" },
  ]
  const selectedLabel = MOTORS.find((m) => m.id === selected)?.label

  const MotorChip = ({ id, label, alarm }: { id: ServoMotorId; label: string; alarm?: boolean }) => {
    const active = selected === id
    return (
      <button
        type="button"
        role="radio"
        aria-checked={active}
        onClick={() => setSelected(active ? null : id)}
        className={cn(
          "flex flex-col items-center gap-0.5 rounded-xl border px-2 py-2 transition-colors",
          active
            ? "border-primary bg-primary text-primary-foreground"
            : alarm
              ? "border-destructive/60 bg-destructive/10 text-foreground hover:border-destructive"
              : "border-border bg-secondary/30 text-foreground hover:border-primary/50",
        )}
      >
        <span className="whitespace-nowrap text-xs font-semibold uppercase tracking-wider">{label}</span>
        {id === "both" ? (
          <span className={cn("text-[10px]", active ? "text-primary-foreground/80" : "text-muted-foreground")}>
            A + B
          </span>
        ) : servo ? (
          <span
            className={cn(
              "flex items-center gap-1 text-[10px] font-medium",
              active ? "text-primary-foreground/80" : alarm ? "text-destructive" : "text-success",
            )}
            title={alarm ? "Drive alarm (ALM) active" : "Drive healthy"}
          >
            {alarm ? <ShieldAlert className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            {alarm ? "ALM" : "OK"}
          </span>
        ) : (
          <span className={cn("text-[10px]", active ? "text-primary-foreground/80" : "text-muted-foreground")}>
            {id === "a" ? "left side" : "right side"}
          </span>
        )}
      </button>
    )
  }

  const JogArrow = ({ direction }: { direction: "up" | "down" }) => {
    const Icon = direction === "up" ? ArrowUp : ArrowDown
    const busy =
      (selected && pending === `${selected}:${direction}`) ||
      (jogging && node.servo?.motor === selected && node.servo?.direction === direction)
    return (
      <button
        type="button"
        disabled={!canJog || !selected}
        aria-label={
          selected
            ? `Jog ${selectedLabel} ${direction} by ${step} ${unit}`
            : `Jog ${direction} (select a motor first)`
        }
        onClick={() => selected && void jog(selected, direction)}
        className="flex h-20 items-center justify-center rounded-xl border border-border bg-background/60 text-foreground transition-colors hover:border-primary/50 hover:bg-secondary/70 disabled:opacity-30 disabled:hover:border-border disabled:hover:bg-background/60"
      >
        {busy ? <Loader2 className="h-9 w-9 animate-spin text-primary" /> : <Icon className="h-9 w-9 text-primary" />}
      </button>
    )
  }

  return (
    <div className="mt-4 rounded-xl border border-border bg-background/50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {servo ? "Servo micro-jog" : "Motor jog"}
        </p>
        <span className="font-mono text-xs text-foreground">
          {servo
            ? `${jogPulses} p · ${degrees < 10 ? degrees.toFixed(degrees < 1 ? 2 : 1) : Math.round(degrees)}°${geared ? " sprocket" : ""}`
            : `${jogMs} ms · ${Math.round(moveDutyFor(node) * 100)} % PWM`}
        </span>
      </div>

      {hardware && online && !agentReady && (
        <p className="mt-2 text-xs leading-relaxed text-warning text-pretty">
          The Pi agent has not confirmed the {servo ? "servo" : "DC"} drive yet. It switches as soon as it is idle and
          receives this unit&apos;s settings; if it never does, re-run{" "}
          <span className="font-mono">pi-agent/install.sh</span> (needs pax-agent-1.3+).
        </p>
      )}

      {/* With "Always on" there is no release relay to drive, so the card is
          noise — unless the servos are actually released right now, in which
          case the Re-engage button must stay reachable. */}
      {servo && (holdTimeout > 0 || !held) && (
        <div
          className={cn(
            "mt-3 flex items-center justify-between gap-3 rounded-xl border p-2.5",
            held ? "border-border bg-secondary/30" : "border-warning/60 bg-warning/10",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            {held ? (
              <Lock className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <Hand className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">
                {held ? "Servos holding position" : "Servos released — free to turn by hand"}
              </p>
              <p className="text-[10px] leading-relaxed text-muted-foreground text-pretty">
                {held
                  ? `Supply relay cuts power after ${holdTimeout} s idle. The next move powers them up again.`
                  : "Moving the carousel by hand clears the home position; the next move re-engages and re-homes."}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!canRelease}
            aria-label={held ? "Release the servos so the carousel can be moved by hand" : "Re-engage the servos"}
            onClick={() => void setHold(held)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40",
              held
                ? "border-border bg-background/60 text-foreground hover:border-warning hover:text-warning"
                : "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {pending === "release" || pending === "hold" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : held ? (
              <Hand className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {held ? "Release" : "Hold"}
          </button>
        </div>
      )}

      {/* Step size: how far one tap moves. Slider for feel, chips for exact values. */}
      <input
        type="range"
        aria-label={`Jog step size in ${unit}`}
        min={stepMin}
        max={stepMax}
        step={1}
        value={step}
        onChange={(e) => setStep(Number(e.target.value))}
        className="mt-2 w-full accent-[var(--color-primary)]"
      />
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setStep(p)}
            aria-pressed={step === p}
            className={cn(
              "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
              step === p
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {p}
          </button>
        ))}
        <input
          type="number"
          aria-label={`Jog step size (exact ${unit})`}
          min={stepMin}
          max={stepMax}
          value={step}
          onChange={(e) => {
            const v = Number.parseInt(e.target.value)
            if (Number.isFinite(v)) setStep(v)
          }}
          className="h-7 w-20 rounded-md border border-input bg-background/60 px-2 font-mono text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <span className="self-center text-[11px] text-muted-foreground">{unit}</span>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        {servo
          ? "One tap sends exactly this many pulses. Jog a single motor to level a shelf that hangs crooked; jog both to creep the whole carousel."
          : "One tap runs the motor for this long at the Motor speed PWM. Jog a single motor to level a shelf that hangs crooked; jog both to creep the whole carousel."}
      </p>

      <div className="mt-3 grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Motor to jog">
        {MOTORS.map((m) => (
          <MotorChip key={m.id} {...m} />
        ))}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] text-muted-foreground">
          {selected ? (
            <>
              Jogging <span className="font-semibold text-foreground">{selectedLabel}</span>
            </>
          ) : (
            "Select a motor to enable the arrows."
          )}
        </p>
        <button
          type="button"
          disabled={!selected}
          onClick={() => setSelected(null)}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <X className="h-3 w-3" />
          Deselect
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <JogArrow direction="up" />
        <JogArrow direction="down" />
      </div>

      {(alarmA || alarmB) && (
        <p className="mt-2 text-xs leading-relaxed text-destructive text-pretty">
          {alarmA && alarmB ? "Both drives" : alarmA ? "Motor A's drive" : "Motor B's drive"} reports an alarm
          (over-current, over-voltage or position-following error). The pulse train is stopped. Clear the jam, then
          power-cycle the servo — the ALM output only resets on re-power.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}
