"use client"

import { useRef, useState } from "react"
import { BrowserMultiFormatReader } from "@zxing/browser"
import { Camera, Loader2 } from "lucide-react"
import { Button } from "./ui/button"

/**
 * Live camera streams (getUserMedia) only exist on https:// or localhost, so on
 * http://192.168.x.x they're blocked. A file input with `capture` is not
 * restricted that way: iPhone, Android and Windows tablets open the native
 * camera app, and we decode the QR/barcode from the photo instead.
 */
export function PhotoScanButton({
  onDetected,
  label = "Take a photo of the code",
}: {
  onDetected: (text: string) => void
  label?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError(null)
    const url = URL.createObjectURL(file)
    try {
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url)
      onDetected(result.getText())
    } catch {
      setError("No code found in that photo. Hold the camera closer, keep it steady and try again.")
    } finally {
      URL.revokeObjectURL(url)
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <Button className="w-full" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
        {busy ? "Reading photo…" : label}
      </Button>
      {error && <p className="text-sm text-muted-foreground text-pretty">{error}</p>}
    </div>
  )
}
