"use client"

import { useEffect, useState } from "react"
import { Loader2, RotateCw, Video, VideoOff, X } from "lucide-react"
import { useStore } from "@/lib/store"
import { cameraHost, cameraSetting, cameraStreamUrl, isNodeMoving } from "@/lib/camera"
import type { StorageNode } from "@/lib/types"
import { cn } from "@/lib/utils"

/** How long an automatic popup stays up after the carousel stops. */
const LINGER_MS = 4000

/**
 * Small live webcam window pinned to the bottom-left of Home. Opens when the
 * user taps the Camera button, or by itself while a carousel moves (if the
 * setting is on). Closing it removes the <img>, which ends the stream and
 * lets the Pi switch the webcam off.
 */
export function CameraPip({ node, nodes }: { node: StorageNode; nodes: StorageNode[] }) {
  const { state } = useStore()
  const setting = cameraSetting(state)

  const movingNode = nodes.find(isNodeMoving)
  const moving = Boolean(movingNode)
  const target = movingNode ?? node
  const host = cameraHost(setting, target)

  const [manual, setManual] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [linger, setLinger] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<"loading" | "live" | "error">("loading")

  useEffect(() => {
    if (moving) {
      setLinger(true)
      return
    }
    const t = setTimeout(() => {
      setLinger(false)
      setDismissed(false)
    }, LINGER_MS)
    return () => clearTimeout(t)
  }, [moving])

  if (!setting.enabled) return null

  const auto = setting.popupOnMove && linger && !dismissed
  const open = manual || auto

  const close = () => {
    setManual(false)
    if (auto) setDismissed(true)
  }
  const show = () => {
    setPhase("loading")
    setAttempt((n) => n + 1)
    setManual(true)
  }
  const retry = () => {
    setPhase("loading")
    setAttempt((n) => n + 1)
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={show}
        className="fixed bottom-17 left-3 z-40 flex min-h-11 items-center gap-2 rounded-full border border-border bg-panel px-4 text-sm font-medium text-foreground shadow-lg transition-colors hover:bg-secondary"
      >
        <Video className="h-4 w-4 text-primary" aria-hidden="true" />
        Camera
      </button>
    )
  }

  return (
    <section
      aria-label="Live webcam"
      className="fixed bottom-17 left-3 z-40 flex w-72 flex-col overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl sm:w-80"
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            phase === "live" ? "bg-destructive animate-pulse" : "bg-muted-foreground",
          )}
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 truncate text-xs font-semibold">
          {phase === "live" ? "Live" : "Camera"} · {target.name}
          {moving && <span className="ml-1 font-normal text-primary">moving</span>}
        </p>
        <button
          type="button"
          onClick={close}
          aria-label="Turn camera off"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="relative aspect-[4/3] w-full bg-background">
        {host ? (
          <>
            {phase !== "error" && (
              // eslint-disable-next-line @next/next/no-img-element -- MJPEG streams need a plain <img>
              <img
                key={attempt}
                src={cameraStreamUrl(host, setting.port, attempt)}
                alt={`Live webcam view of ${target.name}`}
                className="h-full w-full object-cover"
                onLoad={() => setPhase("live")}
                onError={() => setPhase("error")}
              />
            )}
            {phase === "loading" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                Starting camera…
              </div>
            )}
            {phase === "error" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
                <VideoOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
                <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
                  No picture from {host}:{setting.port}. Check that the webcam is plugged in and the camera service
                  is running on the Pi.
                </p>
                <button
                  type="button"
                  onClick={retry}
                  className="flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium hover:bg-secondary"
                >
                  <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center">
            <VideoOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-muted-foreground text-pretty">
              {target.name} isn&apos;t linked to a Pi. Link it, or set a camera address in Settings → Webcam.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}
