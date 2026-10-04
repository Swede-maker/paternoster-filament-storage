"use client"

import { useStore } from "@/lib/store"
import {
  DEFAULT_SERVO_PULSES_PER_REV,
  MAX_SERVO_HOLD_TIMEOUT_S,
  MIN_SERVO_MAX_PPS,
  MAX_SERVO_MAX_PPS,
  servoHoldTimeoutFor,
  servoMaxPpsFor,
  servoGearRatioFor,
  servoSprocketRpmFor,
  servoSecondsPerSprocketRev,
  formatRpm,
  formatSeconds,
  MIN_SERVO_GEAR_RATIO,
  MAX_SERVO_GEAR_RATIO,
  servoMirrorBFor,
  servoIgnoreAlarmFor,
  servoPulsesPerRevFor,
  servoRpmFor,
} from "@/lib/filament"
import type { StorageNode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Field, Input, Checkbox } from "./ui/field"
import { MotorDrivePicker } from "./motor-drive-picker"
import { ServoPositioning } from "./servo-positioning"

/** iSV57T DIP S1–S3 table (manual §4.1). "Pr0.08" = all OFF, software value. */
const DIP_PULSES = [1600, 2000, 3200, 4000, 5000, 6400, 8000]
/** Quick picks for the idle auto-release, in seconds. 0 = hold always. */
const HOLD_PRESETS: { value: number; label: string }[] = [
  { value: 10, label: "10 s" },
  { value: 30, label: "30 s" },
  { value: 60, label: "60 s" },
  { value: 300, label: "5 min" },
  { value: 1800, label: "30 min" },
  { value: 0, label: "Always on" },
]

/**
 * Settings → per-unit "Motor drive": switch an existing carousel between the
 * two DC bridges and the servo pair, and tune what the agent needs (servo
 * pulses per rev and top pulse rate; motor-B mirroring for both drives). Every
 * change goes to the agent in the next `config`, which hot-swaps its backend
 * while idle.
 */
export function MotorDriveEditor({ node }: { node: StorageNode }) {
  const { dispatch } = useStore()
  const mode = node.motorMode ?? "dc"
  const busy = node.machine.status === "homing" || node.machine.status === "moving"
  const ppr = servoPulsesPerRevFor(node)
  const maxPps = servoMaxPpsFor(node)
  const gearRatio = servoGearRatioFor(node)
  const mirrorB = servoMirrorBFor(node)
  const holdTimeout = servoHoldTimeoutFor(node)
  // Agent-confirmed mode, when it has told us (pax-agent-1.2+).
  const agentMode = node.servo?.mode
  const agentHoldTimeout = node.servo?.holdTimeoutS

  const update = (
    changes: Partial<
      Pick<
        StorageNode,
        | "motorMode"
        | "servoPulsesPerRev"
        | "servoMaxPps"
        | "servoGearRatio"
        | "servoMirrorB"
        | "servoIgnoreAlarm"
        | "servoHoldTimeoutS"
      >
    >,
  ) => dispatch({ type: "UPDATE_NODE", id: node.id, changes })

  const setHoldTimeout = (value: number) =>
    update({ servoHoldTimeoutS: Math.max(0, Math.min(MAX_SERVO_HOLD_TIMEOUT_S, Math.round(value))) })

  return (
    <div className="mt-3 rounded-xl border border-border bg-background/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Motor drive</p>
        {node.driver === "hardware" && node.link === "online" && (
          <span className="font-mono text-[11px] text-muted-foreground">
            agent: {agentMode === mode ? mode : agentMode ? "awaiting switch…" : mode === "servo" ? "awaiting switch…" : "dc (unconfirmed)"}
          </span>
        )}
      </div>
      <MotorDrivePicker value={mode} onChange={(m) => update({ motorMode: m })} disabled={busy} compact />
      {busy && (
        <p className="mt-2 text-xs text-warning">
          The drive can only be changed while the carousel is idle; the agent ignores a switch mid-move.
        </p>
      )}

      {mode === "servo" && (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Pulses per revolution" htmlFor={`ppr-${node.id}`}>
            <Input
              id={`ppr-${node.id}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={32767}
              list={`dip-${node.id}`}
              value={ppr}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value)
                update({ servoPulsesPerRev: Number.isFinite(v) && v > 0 ? Math.min(32767, v) : undefined })
              }}
            />
            <datalist id={`dip-${node.id}`}>
              {DIP_PULSES.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Must match DIP S1–S3 on both drives (factory {DEFAULT_SERVO_PULSES_PER_REV}). Set all three OFF to use
              Pr0.08 instead.
            </p>
          </Field>
          <Field label="Pulse rate at 100 % (pulses/s)" htmlFor={`pps-${node.id}`}>
            <Input
              id={`pps-${node.id}`}
              type="number"
              inputMode="numeric"
              min={MIN_SERVO_MAX_PPS}
              max={MAX_SERVO_MAX_PPS}
              step={500}
              value={maxPps}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value)
                update({
                  servoMaxPps: Number.isFinite(v)
                    ? Math.max(MIN_SERVO_MAX_PPS, Math.min(MAX_SERVO_MAX_PPS, v))
                    : undefined,
                })
              }}
            />
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Top speed the Motor speed slider maps to: {Math.round(servoRpmFor(node, 1))} rpm at the motor shaft. The
              drive accepts up to 300 kHz; keep G × N / 60 ≤ 300 k.
            </p>
          </Field>
          <Field label="Gear ratio (motor : sprocket)" htmlFor={`gear-${node.id}`}>
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">1 :</span>
              <Input
                id={`gear-${node.id}`}
                type="number"
                inputMode="decimal"
                min={MIN_SERVO_GEAR_RATIO}
                max={MAX_SERVO_GEAR_RATIO}
                step="any"
                value={gearRatio}
                onChange={(e) => {
                  const v = Number.parseFloat(e.target.value)
                  update({
                    servoGearRatio: Number.isFinite(v)
                      ? Math.max(MIN_SERVO_GEAR_RATIO, Math.min(MAX_SERVO_GEAR_RATIO, v))
                      : undefined,
                  })
                }}
              />
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Motor turns per one turn of the chain sprocket — a 1:50 gearbox is 50, a motor on the sprocket shaft is
              1. Only changes how speeds and jog steps are shown; the carousel still stops on the shelf sensor.
            </p>
          </Field>
          <div className="flex flex-col justify-end">
            <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">At the sprocket, 100 %</p>
              <p className="mt-0.5 font-mono text-sm text-foreground">
                {formatRpm(servoSprocketRpmFor(node, 1))} rpm
                <span className="text-muted-foreground">
                  {" · "}
                  {formatSeconds(servoSecondsPerSprocketRev(node, 1))} per full turn
                </span>
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                The Motor speed and Approach sliders in Manual control show their speeds in sprocket rpm using this
                ratio.
              </p>
            </div>
          </div>
        </div>
      )}

      {mode === "servo" && <ServoPositioning node={node} />}

      {mode === "servo" && (
        <div className="mt-3">
          <Field label="Release servos after idle" htmlFor={`hold-${node.id}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              {HOLD_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setHoldTimeout(p.value)}
                  aria-pressed={holdTimeout === p.value}
                  className={cn(
                    "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                    holdTimeout === p.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {p.label}
                </button>
              ))}
              <Input
                id={`hold-${node.id}`}
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_SERVO_HOLD_TIMEOUT_S}
                step={5}
                value={holdTimeout}
                onChange={(e) => {
                  const v = Number.parseInt(e.target.value)
                  if (Number.isFinite(v)) setHoldTimeout(v)
                }}
                className="w-24"
                aria-label="Release servos after this many idle seconds (0 = hold always)"
              />
              <span className="text-[11px] text-muted-foreground">seconds</span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
              {holdTimeout === 0
                  ? "Always on: the servos hold with full torque, so the carousel cannot be turned by hand — use the jog arrows in Manual control to move it. This is the normal setting; the iSV57T has no enable input."
                  : `Only works with the optional supply relay on GPIO 17/25. After ${holdTimeout} s with no movement the agent cuts the servo supply so the carousel can be turned by hand; any move or jog powers it up again first. Without the relay this setting has no effect.`}
              {node.driver === "hardware" && node.link === "online" && agentHoldTimeout !== undefined && agentHoldTimeout !== holdTimeout && (
                <span className="text-warning"> Agent still reports {agentHoldTimeout || "always on"}; it updates on the next config push.</span>
              )}
            </p>
          </Field>
        </div>
      )}

      <div className="mt-3">
        <Checkbox
          checked={mirrorB}
          onChange={(v) => update({ servoMirrorB: v })}
          label="Mirror motor B direction"
          description={
            mode === "servo"
              ? "On when the two servos face each other across the carousel so both chains pull the same way. If the carousel fights itself after switching to servos, flip this."
              : "On when the two motors face each other across the carousel so both chains pull the same way. If the two sides fight each other, flip this instead of rewiring M+/M− on bridge B."
          }
        />
      </div>

      {mode === "servo" && (
        <div className="mt-3">
          <Checkbox
            checked={servoIgnoreAlarmFor(node)}
            onChange={(v) => update({ servoIgnoreAlarm: v })}
            label="Ignore the drives' alarm outputs (ALM not wired)"
            description="The Pi's ALM inputs have a pull-up, so with ALM+/ALM− left unconnected both drives look permanently tripped and no move is allowed. Turn this on until you wire them; turn it off afterwards so a real fault stops the motor."
          />
        </div>
      )}
    </div>
  )
}
