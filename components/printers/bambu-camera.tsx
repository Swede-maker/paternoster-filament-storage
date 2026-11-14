"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import useSWR from "swr"
import { Camera, Check, Copy, Expand, Loader2, Pause, Play, RefreshCw, TerminalSquare, VideoOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Printer } from "@/lib/types"

type Probe =
  | { ok: true; kind: "rtsps" | "jpeg"; ffmpeg: boolean }
  | { ok: false; reason: "not-configured" | "not-allowed" | "unreachable" | "ffmpeg-missing"; error: string; kind?: "rtsps" | "jpeg" }

const INSTALL_CMD = "sudo apt install -y ffmpeg"

async function fetchProbe(printerId: string): Promise<Probe> {
  const res = await fetch(`/api/bambu/camera?printerId=${encodeURIComponent(printerId)}&probe=1`, { cache: "no-store" })
  if (!res.ok) throw new Error(`Camera check failed (${res.status})`)
  return res.json()
}

/**
 * Live Bambu Lab camera, bridged to MJPEG by the app server. Works for every
 * Bambu model: X1 / H2 / H3 over RTSPS (via ffmpeg), P1 / A1 over the port-6000
 * JPEG stream. Read locally, so the cloud link and Bambu Handy keep working.
 */
export function BambuCamera({ printer }: { printer: Printer }) {
  const configKey = [
    "bambu-camera",
    printer.id,
    printer.cameraIp || printer.ip || "",
    printer.cameraAccessCode || printer.accessCode || "",
    printer.bambuCamera ?? "auto",
  ]
  const { data, error, isLoading, mutate } = useSWR(configKey, () => fetchProbe(printer.id), {
    revalidateOnFocus: false,
    // Keep re-checking while it isn't working, so a freshly synced setting or
    // a just-installed ffmpeg is picked up without a manual reload.
    refreshInterval: (latest) => (latest?.ok ? 0 : 8000),
  })
  const [streamKey, setStreamKey] = useState(0)
  const [streamFailed, setStreamFailed] = useState(false)
  const [paused, setPaused] = useState(false)
  // Stop the feed while the tablet screen is off or the browser is in the
  // background; it resumes on its own when the page is visible again.
  const pageHidden = usePageHidden()

  const retry = () => {
    setStreamFailed(false)
    setStreamKey((k) => k + 1)
    void mutate()
  }

  if (isLoading && !data) {
    return (
      <CameraFrame>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Connecting to the camera…</p>
      </CameraFrame>
    )
  }

  if (error || !data) {
    return (
      <CameraFrame>
        <VideoOff className="h-7 w-7 text-muted-foreground" />
        <p className="text-sm text-muted-foreground text-pretty">
          {error instanceof Error ? error.message : "Couldn't check the camera."}
        </p>
        <Button size="sm" variant="outline" onClick={retry}>
          <RefreshCw className="h-4 w-4" /> Try again
        </Button>
      </CameraFrame>
    )
  }

  if (!data.ok) {
    if (data.reason === "ffmpeg-missing") return <FfmpegMissing onRecheck={retry} />
    return (
      <CameraFrame>
        <VideoOff className="h-7 w-7 text-muted-foreground" />
        <p className="max-w-md text-sm text-muted-foreground text-pretty">{data.error}</p>
        {data.reason === "not-configured" ? (
          <p className="max-w-md text-xs text-muted-foreground text-pretty">
            On the printer, turn on <span className="font-medium text-foreground">LAN Mode Liveview</span> (not LAN
            Only Mode) so the cloud and Bambu Handy keep working.
          </p>
        ) : (
          <Button size="sm" variant="outline" onClick={retry}>
            <RefreshCw className="h-4 w-4" /> Try again
          </Button>
        )}
      </CameraFrame>
    )
  }

  const src = `/api/bambu/camera?printerId=${encodeURIComponent(printer.id)}&s=${streamKey}`
  const live = !paused && !pageHidden

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn("h-2 w-2 rounded-full", live ? "bg-success" : "bg-muted-foreground/50")}
            aria-hidden="true"
          />
          {live ? "Live camera" : "Camera paused"} ·{" "}
          {data.kind === "rtsps" ? "RTSPS (X1 / H2 / H3)" : "JPEG stream (P1 / A1)"}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant={paused ? "secondary" : "outline"}
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="outline" onClick={retry} disabled={paused}>
            <RefreshCw className="h-4 w-4" /> Reload
          </Button>
          <Button size="sm" variant="secondary" onClick={() => window.open(src, "_blank", "noopener,noreferrer")}>
            <Expand className="h-4 w-4" /> Open full size
          </Button>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-background">
        {!live ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <VideoOff className="h-7 w-7 text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground text-pretty">
              The video feed is stopped, so nothing is downloaded or decoded on this device.
            </p>
            {paused && (
              <Button size="sm" onClick={() => setPaused(false)}>
                <Play className="h-4 w-4" /> Resume live view
              </Button>
            )}
          </div>
        ) : streamFailed ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <VideoOff className="h-7 w-7 text-muted-foreground" />
            <p className="max-w-md text-sm text-muted-foreground text-pretty">
              The stream dropped. The printer allows only a couple of viewers at once, so close the live view in Bambu
              Handy or Studio if it&apos;s open, then try again.
            </p>
            <Button size="sm" variant="outline" onClick={retry}>
              <RefreshCw className="h-4 w-4" /> Try again
            </Button>
          </div>
        ) : (
          <MjpegStream
            key={streamKey}
            src={src}
            alt={`Live camera view of ${printer.name}`}
            onError={() => {
              setStreamFailed(true)
              void mutate()
            }}
          />
        )}
      </div>
    </div>
  )
}

// A 1x1 transparent GIF: swapping to it ends the MJPEG request without firing onError.
const BLANK_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="

/**
 * Browsers can keep downloading and decoding an MJPEG stream after its <img> is
 * removed from the page, so on unmount the src is swapped out to close the
 * connection (which also lets the server stop its ffmpeg bridge).
 */
function MjpegStream({ src, alt, onError }: { src: string; alt: string; onError: () => void }) {
  const ref = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const el = ref.current
    return () => {
      if (el) el.src = BLANK_IMAGE
    }
  }, [])
  return (
    // eslint-disable-next-line @next/next/no-img-element -- MJPEG stream, not a static image
    <img ref={ref} src={src} alt={alt} className="h-full w-full object-contain" onError={onError} />
  )
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange)
  return () => document.removeEventListener("visibilitychange", onChange)
}

/** True while the browser tab is in the background or the screen is off. */
function usePageHidden() {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "hidden",
    () => false,
  )
}

function CameraFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
      {children}
    </div>
  )
}

function FfmpegMissing({ onRecheck }: { onRecheck: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked: the command is still selectable */
    }
  }
  return (
    <CameraFrame>
      <Camera className="h-7 w-7 text-primary" />
      <div className="flex max-w-md flex-col gap-1">
        <p className="text-sm font-medium text-foreground">One step left: install ffmpeg on the Pi</p>
        <p className="text-sm text-muted-foreground text-pretty">
          This printer streams RTSPS video, which the Pi converts with ffmpeg. Run this once on the Pi, then check
          again. No restart needed.
        </p>
      </div>
      <div className="flex w-full max-w-md items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left">
        <TerminalSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
        <code className="flex-1 select-all truncate font-mono text-sm text-foreground">{INSTALL_CMD}</code>
        <Button size="sm" variant="ghost" onClick={copy} aria-label="Copy install command">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
      <Button size="sm" variant="outline" onClick={onRecheck}>
        <RefreshCw className="h-4 w-4" /> Check again
      </Button>
    </CameraFrame>
  )
}
