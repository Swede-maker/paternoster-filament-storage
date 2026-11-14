import "server-only"
import net from "node:net"
import tls from "node:tls"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { db } from "@/lib/db"
import type { PersistedState, Printer } from "@/lib/types"
import { isAllowedTarget } from "./pi-relay"

/**
 * Bambu Lab LAN camera bridge.
 *
 * Browsers can't play either Bambu camera transport, so the app server reads
 * the printer's stream and re-serves it as plain MJPEG:
 *  - "jpeg"  (P1 / A1 series): a TLS socket on port 6000 that sends one JPEG
 *            per frame after an 80-byte auth packet. Pure Node, no tools needed.
 *  - "rtsps" (X1 / H2 / H3 series): RTSP over TLS on port 322, converted to
 *            MJPEG by ffmpeg.
 *
 * Bambu printers only allow a couple of concurrent viewers (Bambu Handy counts
 * as one), so every browser watching the same printer shares a single upstream
 * connection, which closes when the last viewer leaves.
 */

export type CameraKind = "rtsps" | "jpeg"

export type CameraTarget = { ip: string; code: string; kind: "auto" | CameraKind }

export type CameraProbe =
  | { ok: true; kind: CameraKind; ffmpeg: boolean }
  | { ok: false; reason: "not-configured" | "not-allowed" | "unreachable" | "ffmpeg-missing"; error: string; kind?: CameraKind }

const RTSPS_PORT = 322
const JPEG_PORT = 6000

/** Read a printer's camera settings from the server's own copy of the state. */
export function cameraTargetFor(printerId: string): CameraTarget | null {
  const row = db.prepare("SELECT data FROM system_state WHERE id = 1").get() as { data: string } | undefined
  if (!row) return null
  let printer: Printer | undefined
  try {
    const s = JSON.parse(row.data) as PersistedState
    printer = (s.printers ?? []).find((p) => p.id === printerId)
  } catch {
    return null
  }
  if (!printer || printer.firmware !== "bambu") return null
  const ip = (printer.cameraIp || printer.ip || "").trim()
  const code = (printer.cameraAccessCode || printer.accessCode || "").trim()
  if (!ip || !code) return null
  return { ip, code, kind: printer.bambuCamera ?? "auto" }
}

function portOpen(ip: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
  })
}

let ffmpegAvailable: Promise<boolean> | null = null
/** Whether ffmpeg is installed (checked once per process, retried if it was missing). */
export function hasFfmpeg(): Promise<boolean> {
  if (!ffmpegAvailable) {
    ffmpegAvailable = new Promise<boolean>((resolve) => {
      const p = spawn("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" })
      p.once("error", () => resolve(false))
      p.once("exit", (code) => resolve(code === 0))
    }).then((ok) => {
      // Let a fresh `apt install ffmpeg` take effect without restarting the app.
      if (!ok) setTimeout(() => (ffmpegAvailable = null), 10_000)
      return ok
    })
  }
  return ffmpegAvailable
}

const kindCache = new Map<string, CameraKind>()

async function resolveKind(target: CameraTarget): Promise<CameraKind | null> {
  if (target.kind !== "auto") return target.kind
  const cached = kindCache.get(target.ip)
  if (cached) return cached
  const [rtsps, jpeg] = await Promise.all([portOpen(target.ip, RTSPS_PORT), portOpen(target.ip, JPEG_PORT)])
  const kind: CameraKind | null = rtsps ? "rtsps" : jpeg ? "jpeg" : null
  if (kind) kindCache.set(target.ip, kind)
  return kind
}

export async function probeCamera(target: CameraTarget | null): Promise<CameraProbe> {
  if (!target) {
    return { ok: false, reason: "not-configured", error: "Add the printer's IP and LAN access code under Edit → Camera." }
  }
  if (!isAllowedTarget(target.ip)) {
    return { ok: false, reason: "not-allowed", error: "The camera IP must be a local network address." }
  }
  const kind = await resolveKind(target)
  if (!kind) {
    return {
      ok: false,
      reason: "unreachable",
      error:
        "Couldn't reach the printer's camera. Check the IP, that this server is on the same network, and that LAN Mode Liveview is on in the printer's network settings.",
    }
  }
  if (kind === "rtsps" && !(await hasFfmpeg())) {
    return {
      ok: false,
      kind,
      reason: "ffmpeg-missing",
      error: "This printer streams RTSPS video, which needs ffmpeg on the server.",
    }
  }
  const hub = hubs.get(hubKey(target, kind))
  if (hub?.lastError && !hub.last) return { ok: false, kind, reason: "unreachable", error: hub.lastError }
  return { ok: true, kind, ffmpeg: kind === "rtsps" }
}

// --- Shared upstream per printer -------------------------------------------

type Listener = (jpeg: Buffer) => void

type Hub = {
  listeners: Set<Listener>
  last: Buffer | null
  lastError: string | null
  stop: (() => void) | null
  retry: ReturnType<typeof setTimeout> | null
  closeTimer: ReturnType<typeof setTimeout> | null
}

const hubs = new Map<string, Hub>()

function hubKey(t: CameraTarget, kind: CameraKind) {
  return `${kind}|${t.ip}|${t.code}`
}

/**
 * Subscribe to JPEG frames from a printer's camera. Returns an unsubscribe
 * function. The upstream connection is opened on first subscriber and closed
 * shortly after the last one leaves.
 */
export function subscribeCamera(target: CameraTarget, kind: CameraKind, onFrame: Listener): () => void {
  const key = hubKey(target, kind)
  let hub = hubs.get(key)
  if (!hub) {
    hub = { listeners: new Set(), last: null, lastError: null, stop: null, retry: null, closeTimer: null }
    hubs.set(key, hub)
  }
  const h = hub
  if (h.closeTimer) {
    clearTimeout(h.closeTimer)
    h.closeTimer = null
  }
  h.listeners.add(onFrame)
  if (h.last) onFrame(h.last)
  if (!h.stop && !h.retry) start(h, target, kind)

  return () => {
    h.listeners.delete(onFrame)
    if (h.listeners.size > 0) return
    // Small grace period so a page reload doesn't drop and redial the printer.
    h.closeTimer = setTimeout(() => {
      if (h.listeners.size > 0) return
      h.stop?.()
      h.stop = null
      if (h.retry) clearTimeout(h.retry)
      h.retry = null
      hubs.delete(key)
    }, 5000)
  }
}

function start(h: Hub, target: CameraTarget, kind: CameraKind) {
  const emit = (jpeg: Buffer) => {
    h.last = jpeg
    h.lastError = null
    for (const l of h.listeners) l(jpeg)
  }
  const onEnd = (error: string | null) => {
    h.stop = null
    if (error) h.lastError = error
    if (h.listeners.size === 0) return
    h.retry = setTimeout(() => {
      h.retry = null
      if (h.listeners.size > 0) start(h, target, kind)
    }, 3000)
  }
  h.stop = kind === "jpeg" ? startJpeg(target, emit, onEnd) : startRtsps(target, emit, onEnd)
}

/** P1 / A1: TLS on port 6000, an auth packet, then [16-byte header][JPEG] frames. */
function startJpeg(t: CameraTarget, emit: (b: Buffer) => void, onEnd: (e: string | null) => void): () => void {
  const auth = Buffer.alloc(80)
  auth.writeUInt32LE(0x40, 0)
  auth.writeUInt32LE(0x3000, 4)
  auth.write("bblp", 16, 32, "ascii")
  auth.write(t.code, 48, 32, "ascii")

  // The printer presents a self-signed Bambu certificate; this only ever talks
  // to a private LAN address (checked by isAllowedTarget).
  const sock = tls.connect({ host: t.ip, port: JPEG_PORT, rejectUnauthorized: false })
  let buf: Buffer = Buffer.alloc(0)
  let ended = false
  let gotFrame = false
  const finish = (err: string | null) => {
    if (ended) return
    ended = true
    sock.destroy()
    onEnd(err)
  }
  sock.setTimeout(15_000, () => finish("Camera stopped sending frames."))
  sock.once("secureConnect", () => sock.write(auth))
  sock.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= 16) {
      const size = buf.readUInt32LE(0)
      if (size <= 0 || size > 8 * 1024 * 1024) {
        buf = Buffer.alloc(0)
        break
      }
      if (buf.length < 16 + size) break
      const frame = buf.subarray(16, 16 + size)
      buf = buf.subarray(16 + size)
      if (frame[0] === 0xff && frame[1] === 0xd8) {
        gotFrame = true
        emit(Buffer.from(frame))
      }
    }
  })
  sock.once("error", (e) => finish(`Camera connection failed: ${e.message}`))
  sock.once("close", () =>
    finish(gotFrame ? null : "The printer closed the camera connection. Check the access code and that LAN Mode Liveview is on."),
  )
  return () => finish(null)
}

/** X1 / H2 / H3: RTSPS on port 322, converted to an MJPEG pipe by ffmpeg. */
function startRtsps(t: CameraTarget, emit: (b: Buffer) => void, onEnd: (e: string | null) => void): () => void {
  const url = `rtsps://bblp:${encodeURIComponent(t.code)}@${t.ip}:${RTSPS_PORT}/streaming/live/1`
  let proc: ChildProcessWithoutNullStreams
  try {
    proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-rtsp_transport", "tcp",
      "-i", url,
      "-an",
      "-vf", "scale='min(1280,iw)':-2",
      "-r", "12",
      "-q:v", "6",
      "-f", "mjpeg",
      "pipe:1",
    ])
  } catch {
    onEnd("Could not start ffmpeg.")
    return () => {}
  }

  let buf: Buffer = Buffer.alloc(0)
  let stderr = ""
  let ended = false
  let gotFrame = false
  const finish = (err: string | null) => {
    if (ended) return
    ended = true
    proc.kill("SIGKILL")
    onEnd(err)
  }

  proc.stdout.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    // ffmpeg's mjpeg muxer writes back-to-back JPEGs: split on SOI…EOI markers.
    for (;;) {
      const soi = buf.indexOf(Buffer.from([0xff, 0xd8]))
      if (soi < 0) {
        buf = Buffer.alloc(0)
        break
      }
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2)
      if (eoi < 0) {
        if (soi > 0) buf = buf.subarray(soi)
        break
      }
      gotFrame = true
      emit(Buffer.from(buf.subarray(soi, eoi + 2)))
      buf = buf.subarray(eoi + 2)
    }
    if (buf.length > 8 * 1024 * 1024) buf = Buffer.alloc(0)
  })
  proc.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-500)
  })
  proc.once("error", (e) => finish(`ffmpeg failed: ${e.message}`))
  proc.once("exit", () => {
    // Never surface the URL: it contains the access code.
    const detail = stderr.replaceAll(url, "rtsps://<printer>").trim().split("\n").pop() ?? ""
    finish(gotFrame ? null : `Camera stream failed${detail ? `: ${detail}` : ""}. Check the access code and that LAN Mode Liveview is on.`)
  })
  return () => finish(null)
}
