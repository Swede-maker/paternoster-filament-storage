"use client"

import { useEffect, useRef, useState } from "react"
import { BrowserMultiFormatReader } from "@zxing/browser"
import { Nfc, QrCode as QrCodeIcon, X, Loader2, Keyboard, CornerDownLeft, Radio, Wifi, WifiOff } from "lucide-react"
import { Dialog, DialogHeader, DialogBody } from "./ui/dialog"
import { Button } from "./ui/button"
import { Input } from "./ui/field"
import { nfcSupported, scanNfcOnce } from "@/lib/nfc"
import { parseScan } from "@/lib/tags"
import { useStore } from "@/lib/store"
import { useReaders } from "@/lib/use-reader"

function cameraSupported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false
  return !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function"
}

/**
 * Unified RFID/QR tag reader. Scans through whatever the device supports:
 *   - Web NFC (Android Chrome/Edge) — tap a physical RFID tag.
 *   - Camera QR (works on iPhone Safari + Android) — point at a printed code.
 *   - Manual entry — type/paste an id, so any device (incl. desktop) can test.
 * Fires `onScan` with the normalised tag id from whichever path resolves first.
 */
export function TagScanner({
  open,
  title = "Scan a tag",
  description = "Tap an RFID tag, or point the camera at a QR code.",
  onScan,
  onClose,
}: {
  open: boolean
  title?: string
  description?: string
  onScan: (id: string) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const manualRef = useRef<HTMLInputElement>(null)
  const [manual, setManual] = useState("")
  const [camAvailable, setCamAvailable] = useState(true)
  const [camStarting, setCamStarting] = useState(true)
  const [camError, setCamError] = useState<string | null>(null)
  const [nfcOn, setNfcOn] = useState(false)
  const [nfcError, setNfcError] = useState<string | null>(null)

  const onScanRef = useRef(onScan)
  onScanRef.current = onScan
  const firedRef = useRef(false)

  // Fire once, guarding against both camera and NFC resolving together.
  function fire(raw: string) {
    if (firedRef.current) return
    const id = parseScan(raw)
    if (!id) return
    firedRef.current = true
    onScanRef.current(id)
  }

  // --- Wireless reader path ---
  // Any paired ESP32/Pi reader can inject a scan here, so an iPhone (or any
  // device that can't read NFC on the web) just waits for the hardware reader.
  // We subscribe only while the dialog is open.
  const { state } = useStore()
  const readerTokens = (state.settings.readers ?? []).map((r) => r.token)
  const { anyOnline: readerOnline } = useReaders(readerTokens, (uid) => fire(uid), open)

  // --- NFC path ---
  useEffect(() => {
    if (!open) return
    if (!nfcSupported()) return
    const controller = new AbortController()
    setNfcOn(true)
    setNfcError(null)
    scanNfcOnce(controller.signal)
      .then(({ serialNumber }) => fire(serialNumber))
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") return
        const name = (e as { name?: string })?.name
        setNfcError(
          name === "NotAllowedError"
            ? "NFC permission denied. Allow it, then reopen the scanner."
            : "Couldn't start NFC. Use the QR camera or type the id below.",
        )
        setNfcOn(false)
      })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // --- Camera QR path ---
  useEffect(() => {
    if (!open) return
    firedRef.current = false
    setManual("")
    const ok = cameraSupported()
    setCamAvailable(ok)
    if (!ok) {
      setCamStarting(false)
      setCamError(
        typeof window !== "undefined" && !window.isSecureContext
          ? "The camera needs a secure (https://) connection. Type the id below instead."
          : "No camera on this device. Type the id below instead.",
      )
      setTimeout(() => manualRef.current?.focus(), 50)
      return
    }

    let cancelled = false
    let controls: { stop: () => void } | null = null
    const reader = new BrowserMultiFormatReader()
    setCamError(null)
    setCamStarting(true)

    reader
      .decodeFromConstraints({ video: { facingMode: { ideal: "environment" } } }, videoRef.current!, (result, _err, ctrl) => {
        if (cancelled) return
        setCamStarting(false)
        if (!controls) controls = ctrl
        const text = result?.getText()
        if (text) {
          ctrl.stop()
          fire(text)
        }
      })
      .catch((e) => {
        if (cancelled) return
        setCamStarting(false)
        const name = (e as { name?: string })?.name
        setCamError(
          name === "NotAllowedError"
            ? "Camera permission denied. Allow access, or type the id below."
            : "Couldn't start the camera. Type the id below instead.",
        )
      })

    return () => {
      cancelled = true
      try {
        controls?.stop()
      } catch {
        // ignore teardown errors
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function submitManual() {
    const code = manual.trim()
    if (code) fire(code)
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader icon={<QrCodeIcon className="h-5 w-5" />} title={title} description={description} />
      <DialogBody>
        {/* Wireless reader banner — shown whenever a reader is paired. This is
            the path that lets iPhones scan RFID: the hardware reader sends the
            tag here and the app fires on it. */}
        {readerTokens.length > 0 && (
          <div
            className={`mb-3 flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${
              readerOnline
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-secondary/50 text-muted-foreground"
            }`}
          >
            {readerOnline ? (
              <Wifi className="h-4 w-4 shrink-0 animate-pulse text-primary" />
            ) : (
              <WifiOff className="h-4 w-4 shrink-0" />
            )}
            <span className="text-pretty">
              {readerOnline
                ? "Wireless reader ready — scan a tag on the reader."
                : "Waiting for a wireless reader to come online…"}
            </span>
          </div>
        )}

        {/* NFC status banner — only where Web NFC exists. */}
        {nfcSupported() && (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm text-foreground">
            {nfcOn ? <Radio className="h-4 w-4 shrink-0 animate-pulse text-primary" /> : <Nfc className="h-4 w-4 shrink-0 text-primary" />}
            <span className="text-pretty">
              {nfcError ?? (nfcOn ? "NFC ready — hold your phone against the tag." : "NFC idle.")}
            </span>
          </div>
        )}

        {camAvailable && (
          <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-border bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video ref={videoRef} className="h-full w-full object-cover" playsInline muted autoPlay />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-2/3 w-2/3 rounded-lg border-2 border-primary/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
            </div>
            {camStarting && !camError && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/80">
                <Loader2 className="h-4 w-4 animate-spin" /> Starting camera…
              </div>
            )}
          </div>
        )}
        {camError && <p className="mt-3 text-sm text-muted-foreground text-pretty">{camError}</p>}

        <div className="mt-4 space-y-2">
          <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Keyboard className="h-3.5 w-3.5" /> Enter tag id manually
          </label>
          <div className="flex gap-2">
            <Input
              ref={manualRef}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="Type or paste a tag id"
              spellCheck={false}
              autoCapitalize="off"
              aria-label="Tag id"
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
