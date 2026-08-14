"use client"

import { useEffect, useRef, useState } from "react"
import { BrowserMultiFormatReader } from "@zxing/browser"
import { Camera, X, Loader2, Keyboard, CornerDownLeft } from "lucide-react"
import { Dialog, DialogHeader, DialogBody } from "./ui/dialog"
import { Button } from "./ui/button"
import { Input } from "./ui/field"

/** True only where the browser will actually hand us a camera stream. */
function cameraSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false
  // getUserMedia is exposed only in a secure context (HTTPS or localhost).
  // Serving the app over plain http:// on a LAN IP (e.g. http://192.168.0.52)
  // is the usual reason a phone camera "doesn't work" — the API is missing.
  return !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function"
}

/**
 * Camera barcode scanner backed by @zxing/browser. Requests the rear camera via
 * a facingMode constraint (reliable on iOS Safari and Android Chrome, unlike the
 * native BarcodeDetector API), continuously decodes, and fires `onDetected` with
 * the first result. When the camera isn't available — no permission, no device,
 * or an insecure (http://) origin where browsers block camera access — it falls
 * back to a manual code entry so scanning-by-typing always works.
 */
export function BarcodeScanner({
  open,
  title = "Scan barcode",
  description = "Point the camera at a spool or box barcode.",
  onDetected,
  onClose,
}: {
  open: boolean
  title?: string
  description?: string
  onDetected: (code: string) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const manualRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(true)
  const [manual, setManual] = useState("")
  // Whether this device/origin can open a camera at all. Decided on open.
  const [supported, setSupported] = useState(true)
  // Keep the latest onDetected without restarting the camera when the parent
  // re-renders (the callback is usually an inline function).
  const onDetectedRef = useRef(onDetected)
  onDetectedRef.current = onDetected

  useEffect(() => {
    if (!open) return
    const ok = cameraSupported()
    setSupported(ok)
    setManual("")
    if (!ok) {
      setStarting(false)
      setError(
        typeof window !== "undefined" && !window.isSecureContext
          ? "Your phone's camera only works over a secure (https://) connection. This app is open over http://, so the camera can't start — reach it via https, or just type the barcode below."
          : "No camera available on this device. Type the code below instead.",
      )
      // Nothing to scan with — put the cursor straight in the manual field.
      setTimeout(() => manualRef.current?.focus(), 50)
      return
    }

    let cancelled = false
    // Controls returned by the decode call; used to stop the stream.
    let controls: { stop: () => void } | null = null
    const reader = new BrowserMultiFormatReader()
    setError(null)
    setStarting(true)

    reader
      // Prefer the rear/environment camera on phones; fall back to any camera.
      .decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } } },
        videoRef.current!,
        (result, _err, ctrl) => {
          if (cancelled) return
          // First callback means the camera is live.
          setStarting(false)
          if (!controls) controls = ctrl
          const text = result?.getText()
          if (text) {
            ctrl.stop()
            onDetectedRef.current(text)
          }
        },
      )
      .catch((e) => {
        if (cancelled) return
        setStarting(false)
        const name = (e as { name?: string })?.name
        setError(
          name === "NotAllowedError"
            ? "Camera permission denied. Allow camera access in your browser settings, then try again."
            : name === "NotFoundError"
              ? "No camera found on this device. Type the code below instead."
              : "Couldn't start the camera. Type the code below instead.",
        )
        // Camera unusable — move focus to manual entry so typing just works.
        setTimeout(() => manualRef.current?.focus(), 50)
      })

    return () => {
      cancelled = true
      try {
        controls?.stop()
      } catch {
        // ignore teardown errors
      }
    }
  }, [open])

  function submitManual() {
    const code = manual.trim()
    if (code) onDetectedRef.current(code)
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader icon={<Camera className="h-5 w-5" />} title={title} description={description} />
      <DialogBody>
        {supported && (
          <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-border bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} className="h-full w-full object-cover" playsInline muted autoPlay />
            {/* Reticle overlay */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-2/3 w-2/3 rounded-lg border-2 border-primary/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
            {starting && !error && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
                <Loader2 className="h-4 w-4 animate-spin" /> Starting camera…
              </div>
            )}
          </div>
        )}
        {error && <p className="mt-3 text-sm text-muted-foreground">{error}</p>}

        {/* Manual entry — always available so scanning works even without a
            usable camera (e.g. on an insecure http:// LAN address). */}
        <div className="mt-4 space-y-2">
          <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Keyboard className="h-3.5 w-3.5" /> Enter code manually
          </label>
          <div className="flex gap-2">
            <Input
              ref={manualRef}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Type or paste a barcode"
              spellCheck={false}
              autoCapitalize="off"
              aria-label="Barcode"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) submitManual()
              }}
            />
            <Button className="shrink-0" onClick={submitManual} disabled={!manual.trim()}>
              <CornerDownLeft className="h-4 w-4" /> Use
            </Button>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            <X className="h-4 w-4" /> Cancel
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  )
}
