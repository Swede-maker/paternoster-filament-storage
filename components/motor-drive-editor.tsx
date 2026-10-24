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
  pulseDriveFor,
  pulseDriveProfile,
  pulseDriveProfileFor,
  pulseDriveMaxPpsFor,
  pulseAlarmActiveLowFor,
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
  shelfTimeoutFor,
  defaultShelfTimeoutFor,
  DEFAULT_SHELF_TIMEOUT_DC_S,
  DEFAULT_SHELF_TIMEOUT_SERVO_S,
  MIN_SHELF_TIMEOUT_S,
  MAX_SHELF_TIMEOUT_S,
} from "@/lib/filament"
import type { StorageNode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Field, Checkbox } from "./ui/field"
import { NumberInput } from "./ui/number-input"
import { MotorDrivePicker } from "./motor-drive-picker"
import { ServoPositioning } from "./servo-positioning"
import { ServoControllerEditor } from "./servo-controller-editor"

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
 * single DC motor and the servo pair, and tune what the agent needs (servo
 * pulses per rev, top pulse rate and motor-B mirroring). Every change goes to
 * the agent in the next `config`, which hot-swaps its backend while idle.
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
  const shelfTimeout = shelfTimeoutFor(node)
  const defaultShelfTimeout = defaultShelfTimeoutFor(node)
  const shelfTimeoutIsCustom = node.shelfTimeoutS !== undefined && shelfTimeout !== defaultShelfTimeout
  const agentShelfTimeout = node.servo?.shelfTimeoutS
  const learnedPitchS = node.servo?.shelfPitchS
  // Agent-confirmed mode, when it has told us (pax-agent-1.2+).
  const agentMode = node.servo?.mode
  const agentHoldTimeout = node.servo?.holdTimeoutS
  const agentHomeTimeout = node.servo?.homeTimeoutS
  const pulseDrive = pulseDriveFor(node)
  const profile = pulseDriveProfileFor(node)
  const driveMaxPps = pulseDriveMaxPpsFor(node)
  const isStepper = pulseDrive === "closed-loop-stepper"

  const update = (
    changes: Partial<
      Pick<
        StorageNode,
        | "motorMode"
        | "pulseDrive"
        | "servoDriver"
        | "pulseEnableActiveLow"
        | "pulseAlarmActiveLow"
        | "servoPulsesPerRev"
        | "servoMaxPps"
        | "servoGearRatio"
        | "servoMirrorB"
        | "servoSingleMotor"
        | "servoIgnoreAlarm"
        | "servoHoldTimeoutS"
        | "sensorArmS"
        | "homeTimeoutS"
        | "shelfTimeoutS"
        | "twinReverse"
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
      <MotorDrivePicker
        value={mode}
        onChange={(m) => update({ motorMode: m })}
        pulseDrive={pulseDrive}
        onPulseDriveChange={(d) => {
          // A new drive kind resets the polarity overrides (they described the
          // old drive) and, unless this is a twin Pi, moves the pulses to the
          // controller that kind is normally wired to.
          const next = pulseDriveProfile(d)
          update({
            pulseDrive: d,
            pulseEnableActiveLow: undefined,
            pulseAlarmActiveLow: undefined,
            ...(node.twinSide ? {} : { servoDriver: next.defaultDriver }),
          })
          if (maxPps > next.maxPps) update({ servoMaxPps: next.maxPps })
        }}
        disabled={busy}
        compact
      />
      {busy && (
        <p className="mt-2 text-xs text-warning">
          The drive can only be changed while the carousel is idle; the agent ignores a switch mid-move.
        </p>
      )}

      {mode === "servo" && node.driver === "hardware" && <ServoControllerEditor node={node} disabled={busy} />}

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
              Must match {profile.pprHint} on both drives
              {pulseDrive === "integrated-servo" ? ` (factory ${DEFAULT_SERVO_PULSES_PER_REV})` : ""}.
              {isStepper && " A 1.8° stepper at 1600 pulses/rev is 1/8 microstepping; the encoder keeps the position whatever you pick."}
            </p>
          </Field>
          <Field label="Pulse rate at 100 % (pulses/s)" htmlFor={`pps-${node.id}`}>
            <NumberInput
              id={`pps-${node.id}`}
              min={MIN_SERVO_MAX_PPS}
              max={driveMaxPps}
              unit="pulses/s"
              value={Math.min(maxPps, driveMaxPps)}
              onCommit={(v) => update({ servoMaxPps: Math.min(v, driveMaxPps) })}
            />
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Top speed the Motor speed slider maps to: {Math.round(servoRpmFor(node, 1))} rpm at the motor shaft. The{" "}
              {profile.label.toLowerCase()} drive accepts up to {Math.round(driveMaxPps / 1000)} kHz; keep G × N / 60 ≤{" "}
              {Math.round(driveMaxPps / 1000)} k.
              {isStepper && " Steppers lose torque fast above ~600 rpm at the shaft, so stay well under the ceiling."}
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

      {mode === "servo" && <ServoPositioning node={node} />}

      {mode === "servo" && (
        <div className="mt-3">
          <Field label={isStepper ? "Release steppers after idle" : "Release servos after idle"} htmlFor={`hold-${node.id}`}>
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
                    aria-label="Release the motors after this many idle seconds (0 = hold always)"
                  />
                </div>
                <span className="flex h-11 items-center text-xs text-muted-foreground">seconds</span>
              </div>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
              {holdTimeout === 0
                ? isStepper
                  ? "Always on: the steppers hold with full current, so the carousel cannot be turned by hand and the coils stay warm — use the jog arrows in Manual control to move it."
                  : "Always on: the servos hold with full torque, so the carousel cannot be turned by hand — use the jog arrows in Manual control to move it. This is the normal setting; the iSV57T has no enable input."
                : isStepper
                  ? `After ${holdTimeout} s with no movement the controller asserts the drives' MF (motor-free) input, which cuts the coil current so the carousel can be turned by hand and the motors cool down. Any move or jog re-energises them first and waits for the drive to settle. The closed-loop encoder keeps the position, but the agent re-homes on the next index flag anyway.`
                  : profile.hasEnableInput
                    ? `After ${holdTimeout} s with no movement the controller drops ${profile.enableInputName} so the carousel can be turned by hand; any move or jog enables the drives again first.`
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
          {mode === "dc" && sensorArm > 3 && (
            <p
              role="status"
              className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200 text-pretty"
            >
              {sensorArm} s is long for direct-drive DC motors. A shelf usually passes the sensor in a few seconds, and
              every flag that goes by while the sensor is blind is a shelf the carousel will not count — a one-shelf move
              then overshoots by that many shelves. Start around 1–2 s and raise it only if the flag bounces at
              start-up. The agent also caps this at half the shelf-to-shelf time once it has measured one.
            </p>
          )}
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Shelf timeout" htmlFor={`shelf-timeout-${node.id}`}>
          <div className="flex flex-wrap items-start gap-2">
            <div className="w-32">
              <NumberInput
                id={`shelf-timeout-${node.id}`}
                min={MIN_SHELF_TIMEOUT_S}
                max={MAX_SHELF_TIMEOUT_S}
                integer
                step={1}
                unit="s"
                value={shelfTimeout}
                onCommit={(v) =>
                  update({ shelfTimeoutS: Math.max(MIN_SHELF_TIMEOUT_S, Math.min(MAX_SHELF_TIMEOUT_S, Math.round(v))) })
                }
                aria-label="Seconds a move may run without the shelf sensor counting a flag before the agent stops"
              />
            </div>
            <span className="flex h-11 items-center text-xs text-muted-foreground">seconds</span>
            {shelfTimeoutIsCustom ? (
              <button
                type="button"
                onClick={() => update({ shelfTimeoutS: undefined })}
                className="flex h-11 items-center rounded-lg border border-border px-3 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Reset to {defaultShelfTimeout} s ({mode === "servo" ? "servo" : "DC"} default)
              </button>
            ) : (
              <span className="flex h-11 items-center rounded-lg bg-primary/10 px-3 font-mono text-xs text-primary">
                {mode === "servo" ? "Servo" : "DC"} default
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
            How long a move may run without the shelf sensor counting a flag before the agent stops and reports
            {" "}&quot;Jam? No shelf pulse&quot;. Default is {DEFAULT_SHELF_TIMEOUT_DC_S} s on DC and {DEFAULT_SHELF_TIMEOUT_SERVO_S} s on
            servo. This is the value at 100 % Motor speed; a slower Motor speed stretches it in proportion, and the ramp
            and the Safe move time are added on top, so Safe move time never shortens it. It must be longer than the
            time between two shelves.
            {typeof learnedPitchS === "number" && learnedPitchS > 0 && (
              <span> The agent last measured {learnedPitchS.toFixed(1)} s between shelves.</span>
            )}
            {node.driver === "hardware" && node.link === "online" && agentShelfTimeout !== undefined && agentShelfTimeout !== shelfTimeout && (
              <span className="text-warning"> Agent still reports {agentShelfTimeout} s; it updates on the next config push.</span>
            )}
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

      {mode === "servo" && !singleMotor && !node.twinSide && (
      <div className="mt-3">
        <Checkbox
          checked={mirrorB}
          onChange={(v) => update({ servoMirrorB: v })}
          label="Mirror motor B direction"
          description="On when the two servos face each other across the carousel so both chains pull the same way. If the carousel fights itself after switching to servos, flip this."
        />
      </div>
      )}

      {mode === "servo" && (
        <div className="mt-3">
          <Checkbox
            checked={servoIgnoreAlarmFor(node)}
            onChange={(v) => update({ servoIgnoreAlarm: v })}
            label="Ignore the drives' alarm outputs (ALM not wired)"
            description={
              pulseAlarmActiveLowFor(node)
                ? `This drive's ALM output conducts on a fault, so an unwired ALM reads as healthy and this is rarely needed. Turn it on only if a ${profile.label.toLowerCase()} drive reports a fault you have checked is false.`
                : `${node.servoDriver === "esp32" ? "The ESP32's" : "The Pi's"} ALM inputs have a pull-up, so with ALM+/ALM− left unconnected both drives look permanently tripped and no move is allowed. Turn this on until you wire them; turn it off afterwards so a real fault stops the motor.`
            }
          />
        </div>
      )}
    </div>
  )
}
