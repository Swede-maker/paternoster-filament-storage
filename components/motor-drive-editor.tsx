"use client"

import { useStore } from "@/lib/store"
import {
  DEFAULT_SERVO_PULSES_PER_REV,
  MAX_SERVO_HOLD_TIMEOUT_S,
  MAX_SENSOR_ARM_S,
  sensorArmFor,
  homeTimeoutFor,
  defaultHomeTimeoutFor,
  DEFAULT_HOME_TIMEOUT_DC_S,
  DEFAULT_HOME_TIMEOUT_SERVO_S,
  MIN_HOME_TIMEOUT_S,
  MAX_HOME_TIMEOUT_S,
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
  servoSingleMotorFor,
  servoIgnoreAlarmFor,
  servoPulsesPerRevFor,
  servoRpmFor,
  dcTrimPctFor,
  dcTrimScalesFor,
  MAX_DC_TRIM_PCT,
} from "@/lib/filament"
import type { StorageNode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Field, Checkbox } from "./ui/field"
import { NumberInput } from "./ui/number-input"
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
  const singleMotor = servoSingleMotorFor(node)
  const holdTimeout = servoHoldTimeoutFor(node)
  const sensorArm = sensorArmFor(node)
  const homeTimeout = homeTimeoutFor(node)
  const defaultHomeTimeout = defaultHomeTimeoutFor(node)
  const homeTimeoutIsCustom = node.homeTimeoutS !== undefined && homeTimeout !== defaultHomeTimeout
  // Agent-confirmed mode, when it has told us (pax-agent-1.2+).
  const agentMode = node.servo?.mode
  const agentHoldTimeout = node.servo?.holdTimeoutS
  const agentHomeTimeout = node.servo?.homeTimeoutS

  const update = (
    changes: Partial<
      Pick<
        StorageNode,
        | "motorMode"
        | "servoPulsesPerRev"
        | "servoMaxPps"
        | "servoGearRatio"
        | "servoMirrorB"
        | "servoSingleMotor"
        | "servoIgnoreAlarm"
        | "servoHoldTimeoutS"
        | "sensorArmS"
        | "homeTimeoutS"
        | "dcTrimPct"
        | "twinReverse"
      >
    >,
  ) => dispatch({ type: "UPDATE_NODE", id: node.id, changes })

  const trimPct = dcTrimPctFor(node)
  const trimScales = dcTrimScalesFor(node)
  const setTrim = (value: number) =>
    update({ dcTrimPct: Math.max(-MAX_DC_TRIM_PCT, Math.min(MAX_DC_TRIM_PCT, Math.round(value))) })

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
            <NumberInput
              id={`ppr-${node.id}`}
              min={1}
              max={32767}
              list={`dip-${node.id}`}
              value={ppr}
              onCommit={(v) => update({ servoPulsesPerRev: v })}
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
            <NumberInput
              id={`pps-${node.id}`}
              min={MIN_SERVO_MAX_PPS}
              max={MAX_SERVO_MAX_PPS}
              unit="pulses/s"
              value={maxPps}
              onCommit={(v) => update({ servoMaxPps: v })}
            />
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Top speed the Motor speed slider maps to: {Math.round(servoRpmFor(node, 1))} rpm at the motor shaft. The
              drive accepts up to 300 kHz; keep G × N / 60 ≤ 300 k.
            </p>
          </Field>
          <Field label="Gear ratio (motor : sprocket)" htmlFor={`gear-${node.id}`}>
            <div className="flex items-start gap-2">
              <span className="flex h-11 shrink-0 items-center font-mono text-sm text-muted-foreground">1&nbsp;:</span>
              <NumberInput
                id={`gear-${node.id}`}
                integer={false}
                min={MIN_SERVO_GEAR_RATIO}
                max={MAX_SERVO_GEAR_RATIO}
                value={gearRatio}
                onCommit={(v) => update({ servoGearRatio: v })}
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

      {mode === "dc" && (
        <div className="mt-3 rounded-lg border border-border bg-secondary/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`trim-${node.id}`} className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Motor balance
            </label>
            <span className="font-mono text-xs text-foreground">
              {trimPct === 0
                ? "equal"
                : trimPct < 0
                  ? `A −${Math.abs(trimPct)} %`
                  : `B −${trimPct} %`}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <span className="w-14 shrink-0 text-right font-mono text-[11px] text-muted-foreground">Slow A</span>
            <input
              id={`trim-${node.id}`}
              type="range"
              aria-label="PWM balance between motor A and motor B, percent"
              aria-valuetext={
                trimPct === 0
                  ? "Equal duty on both motors"
                  : trimPct < 0
                    ? `Motor A runs at ${Math.round(trimScales.a * 100)} percent of the PWM duty`
                    : `Motor B runs at ${Math.round(trimScales.b * 100)} percent of the PWM duty`
              }
              min={-MAX_DC_TRIM_PCT}
              max={MAX_DC_TRIM_PCT}
              step={1}
              list={`trim-ticks-${node.id}`}
              value={trimPct}
              disabled={busy}
              onChange={(e) => setTrim(Number(e.target.value))}
              className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-secondary accent-primary disabled:cursor-not-allowed disabled:opacity-50"
            />
            <datalist id={`trim-ticks-${node.id}`}>
              <option value={0} label="equal" />
            </datalist>
            <span className="w-14 shrink-0 font-mono text-[11px] text-muted-foreground">Slow B</span>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="font-mono text-[11px] text-muted-foreground">
              A × {trimScales.a.toFixed(2)} · B × {trimScales.b.toFixed(2)}
            </p>
            <button
              type="button"
              onClick={() => setTrim(0)}
              disabled={busy || trimPct === 0}
              className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reset
            </button>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground text-pretty">
            Two brushed motors never run at exactly the same speed for the same PWM, so one chain creeps ahead and
            the shelves tilt. Watch which side leads during a move and drag the slider towards that motor to trim its
            duty down; the other keeps the full Motor speed setting. The trim rides on top of every move, homing
            and jog, and goes to the Pi with the next config.
          </p>
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
              <div className="flex w-full items-start gap-2">
                <div className="w-32">
                  <NumberInput
                    id={`hold-${node.id}`}
                    min={0}
                    max={MAX_SERVO_HOLD_TIMEOUT_S}
                    unit="s"
                    value={holdTimeout}
                    onCommit={setHoldTimeout}
                    aria-label="Release servos after this many idle seconds (0 = hold always)"
                  />
                </div>
                <span className="flex h-11 items-center text-xs text-muted-foreground">seconds</span>
              </div>
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
        <Field label="Safe move time" htmlFor={`arm-${node.id}`}>
          <div className="flex items-start gap-2">
            <div className="w-32">
              <NumberInput
                id={`arm-${node.id}`}
                min={0}
                max={MAX_SENSOR_ARM_S}
                integer={false}
                step={0.1}
                inputMode="decimal"
                unit="s"
                value={sensorArm}
                onCommit={(v) => update({ sensorArmS: Math.round(v * 100) / 100 })}
                aria-label="Seconds after starting before the shelf and home sensors count (0 = off)"
              />
            </div>
            <span className="flex h-11 items-center text-xs text-muted-foreground">seconds</span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
            {sensorArm === 0
              ? "Off: the sensors count from the moment the carousel starts."
              : `For the first ${sensorArm} s of every move and homing run, the shelf and home sensors are ignored, so a flag that passes in that time cannot stop the carousel. Raise it for big carousels whose flags bounce at start; keep it shorter than the time between two shelves.`}
          </p>
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Homing time" htmlFor={`home-timeout-${node.id}`}>
          <div className="flex flex-wrap items-start gap-2">
            <div className="w-32">
              <NumberInput
                id={`home-timeout-${node.id}`}
                min={MIN_HOME_TIMEOUT_S}
                max={MAX_HOME_TIMEOUT_S}
                integer
                step={5}
                unit="s"
                value={homeTimeout}
                onCommit={(v) => update({ homeTimeoutS: Math.max(MIN_HOME_TIMEOUT_S, Math.min(MAX_HOME_TIMEOUT_S, Math.round(v))) })}
                aria-label="Seconds a homing run may look for the index sensor before faulting"
              />
            </div>
            <span className="flex h-11 items-center text-xs text-muted-foreground">seconds</span>
            {homeTimeoutIsCustom ? (
              <button
                type="button"
                onClick={() => update({ homeTimeoutS: undefined })}
                className="flex h-11 items-center rounded-lg border border-border px-3 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Reset to {defaultHomeTimeout} s ({mode === "servo" ? "servo" : "DC"} default)
              </button>
            ) : (
              <span className="flex h-11 items-center rounded-lg bg-primary/10 px-3 font-mono text-xs text-primary">
                {mode === "servo" ? "Servo" : "DC"} default
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
            How long a homing run may rotate looking for the index flag before the agent stops and reports a fault.
            {" "}Default is {DEFAULT_HOME_TIMEOUT_DC_S} s on DC and {DEFAULT_HOME_TIMEOUT_SERVO_S} s on servo (the gearbox makes
            it slower between flags). Raise it if a slow or heavily loaded carousel faults before completing a full turn;
            lower it so a missing or unwired sensor is caught sooner. A full turn at homing speed must fit inside it.
            {node.driver === "hardware" && node.link === "online" && agentHomeTimeout !== undefined && agentHomeTimeout !== homeTimeout && (
              <span className="text-warning"> Agent still reports {agentHomeTimeout} s; it updates on the next config push.</span>
            )}
          </p>
        </Field>
      </div>

      {mode === "servo" && node.system === "hardware" && !node.twinSide && (
        <div className="mt-3">
          <Checkbox
            checked={singleMotor}
            onChange={(v) => update({ servoSingleMotor: v })}
            label="Use only one servo (motor A)"
            description={
              singleMotor
                ? "One servo drives the carousel. Wire it to the motor A pins (PUL A, DIR A, ALM A); motor B is never pulsed and its alarm is ignored. Jog still works on the one motor."
                : "Turn on if this hardware carousel has a single servo instead of one per chain. Wire it to the motor A pins."
            }
          />
        </div>
      )}

      {node.twinSide && (
        <div className="mt-3">
          <Checkbox
            checked={node.twinReverse ?? false}
            onChange={(v) => update({ twinReverse: v })}
            label={`Reverse motor ${node.twinSide === "left" ? "A" : "B"} direction`}
            description={`Flips only the ${node.twinSide} carousel. Turn on if "up" moves this carousel the wrong way; the other carousel is not affected. Change it while the carousel is stopped, then home it.`}
          />
        </div>
      )}

      {!singleMotor && !node.twinSide && (
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
      )}

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
