import type { NextRequest } from "next/server"
import { sendCommand, isAllowedTarget } from "@/lib/server/pi-relay"
import type { NodeCommand } from "@/lib/node-protocol"
import { MAX_SENSOR_ARM_S, MIN_HOME_TIMEOUT_S, MAX_HOME_TIMEOUT_S } from "@/lib/filament"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Validate an untrusted body into a known NodeCommand (or null), keeping the
 * twin-mode `side` on motion commands and the `twin` flag on config.
 */
function parseCommand(body: unknown): NodeCommand | null {
  const cmd = parseBaseCommand(body)
  if (!cmd || cmd.type === "hello" || cmd.type.startsWith("net_")) return cmd
  const b = body as { side?: unknown; twin?: unknown }
  const sided = cmd as NodeCommand & { side?: "left" | "right"; twin?: boolean }
  if (b.side === "left" || b.side === "right") sided.side = b.side
  if (cmd.type === "config" && typeof b.twin === "boolean") sided.twin = b.twin
  return sided
}

function parseBaseCommand(body: unknown): NodeCommand | null {
  if (!body || typeof body !== "object") return null
  const type = (body as { type?: unknown }).type
  switch (type) {
    case "hello":
    case "home":
    case "stop":
    case "release":
    case "hold":
    case "calibrate":
      return { type }
    case "goto": {
      const shelf = (body as { shelf?: unknown }).shelf
      if (typeof shelf !== "number" || !Number.isInteger(shelf) || shelf < 0) return null
      return { type: "goto", shelf }
    }
    case "jog": {
      const b = body as { motor?: unknown; direction?: unknown; pulses?: unknown; ms?: unknown; speed?: unknown }
      if (b.motor !== "a" && b.motor !== "b" && b.motor !== "both") return null
      if (b.direction !== "up" && b.direction !== "down") return null
      // Exactly one amount: pulses (servo) or ms (DC). Both or neither is a bug.
      const amountInt = (v: unknown, max: number) =>
        typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max ? v : undefined
      const pulses = amountInt(b.pulses, 20_000)
      const ms = amountInt(b.ms, 5_000)
      if ((pulses === undefined) === (ms === undefined)) return null
      const cmd: NodeCommand = { type: "jog", motor: b.motor, direction: b.direction }
      if (pulses !== undefined) cmd.pulses = pulses
      if (ms !== undefined) {
        cmd.ms = ms
        if (typeof b.speed === "number" && Number.isFinite(b.speed) && b.speed > 0 && b.speed <= 1) {
          cmd.speed = b.speed
        }
      }
      return cmd
    }
    case "config": {
      const b = body as {
        shelves?: unknown
        moveSpeed?: unknown
        homingSpeed?: unknown
        rampPct?: unknown
        approachSpeed?: unknown
        motorMode?: unknown
        servoPulsesPerRev?: unknown
        servoMaxPps?: unknown
        servoMirrorB?: unknown
        servoSingleMotor?: unknown
        reverseDir?: unknown
        servoIgnoreAlarm?: unknown
        servoHoldTimeoutS?: unknown
        sensorArmS?: unknown
        homeTimeoutS?: unknown
        positionMode?: unknown
        servoCarouselPulses?: unknown
        servoIndexWindowPulses?: unknown
      }
      if (typeof b.shelves !== "number" || !Number.isInteger(b.shelves) || b.shelves <= 0) return null
      // Rebuilding the command field-by-field is what dropped the slider values:
      // anything not copied here never reaches the Pi. Motion fields are
      // optional, but each one present must be finite and in range.
      const cmd: NodeCommand = { type: "config", shelves: b.shelves }
      const duty = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined)
      const moveSpeed = duty(b.moveSpeed)
      const homingSpeed = duty(b.homingSpeed)
      const approachSpeed = duty(b.approachSpeed)
      if (moveSpeed !== undefined) cmd.moveSpeed = moveSpeed
      if (homingSpeed !== undefined) cmd.homingSpeed = homingSpeed
      if (approachSpeed !== undefined) cmd.approachSpeed = approachSpeed
      if (typeof b.rampPct === "number" && Number.isFinite(b.rampPct) && b.rampPct >= 0 && b.rampPct <= 100) {
        cmd.rampPct = Math.round(b.rampPct)
      }
      if (b.motorMode === "dc" || b.motorMode === "servo") cmd.motorMode = b.motorMode
      const posInt = (v: unknown, max: number) =>
        typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max ? v : undefined
      const ppr = posInt(b.servoPulsesPerRev, 32767)
      const pps = posInt(b.servoMaxPps, 300_000)
      if (ppr !== undefined) cmd.servoPulsesPerRev = ppr
      if (pps !== undefined) cmd.servoMaxPps = pps
      if (typeof b.servoMirrorB === "boolean") cmd.servoMirrorB = b.servoMirrorB
      if (typeof b.servoSingleMotor === "boolean") cmd.servoSingleMotor = b.servoSingleMotor
      if (typeof b.reverseDir === "boolean") cmd.reverseDir = b.reverseDir
      if (typeof b.servoIgnoreAlarm === "boolean") cmd.servoIgnoreAlarm = b.servoIgnoreAlarm
      // 0 is meaningful here (= hold for ever), so it is not a "positive int".
      const hold = b.servoHoldTimeoutS
      if (typeof hold === "number" && Number.isInteger(hold) && hold >= 0 && hold <= 86_400) {
        cmd.servoHoldTimeoutS = hold
      }
      const arm = b.sensorArmS
      if (typeof arm === "number" && Number.isFinite(arm) && arm >= 0 && arm <= MAX_SENSOR_ARM_S) {
        cmd.sensorArmS = arm
      }
      const homeT = b.homeTimeoutS
      if (
        typeof homeT === "number" &&
        Number.isFinite(homeT) &&
        homeT >= MIN_HOME_TIMEOUT_S &&
        homeT <= MAX_HOME_TIMEOUT_S
      ) {
        cmd.homeTimeoutS = homeT
      }
      if (b.positionMode === "sensor" || b.positionMode === "pulses" || b.positionMode === "index")
        cmd.positionMode = b.positionMode
      const carouselPulses = posInt(b.servoCarouselPulses, 100_000_000)
      const windowPulses = posInt(b.servoIndexWindowPulses, 100_000_000)
      if (carouselPulses !== undefined) cmd.servoCarouselPulses = carouselPulses
      if (windowPulses !== undefined) cmd.servoIndexWindowPulses = windowPulses
      return cmd
    }
    default:
      return null
  }
}

/**
 * POST /api/pi/command
 * Body: { ip: string, port: number, command: NodeCommand }
 *
 * Forwards a validated command to the Pi via the shared server relay. Any
 * device can call this — the server owns the single socket to the Pi — so a
 * phone that can't reach the Pi's LAN IP directly can still drive the carousel.
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 })
  }

  const ip = typeof (body as { ip?: unknown }).ip === "string" ? ((body as { ip: string }).ip).trim() : ""
  const port = Number((body as { port?: unknown }).port)
  const command = parseCommand((body as { command?: unknown }).command)

  if (!ip || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return Response.json({ ok: false, error: "Bad ip/port" }, { status: 400 })
  }
  if (!isAllowedTarget(ip)) {
    return Response.json({ ok: false, error: "Target not allowed" }, { status: 403 })
  }
  if (!command) {
    return Response.json({ ok: false, error: "Unknown command" }, { status: 400 })
  }

  const delivered = sendCommand(ip, port, command)
  if (!delivered) {
    // 503: the relay isn't currently connected to the Pi.
    return Response.json({ ok: false, error: "Pi not connected" }, { status: 503 })
  }
  return Response.json({ ok: true })
}
