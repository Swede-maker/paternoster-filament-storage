"use client"

import { useState } from "react"
import { QrCode as QrIcon, Link2, Link2Off, Nfc } from "lucide-react"
import { useStore } from "@/lib/store"
import { qrPayload, newQrTagId } from "@/lib/tags"
import { nfcSupported, scanNfcOnce } from "@/lib/nfc"
import { cn } from "@/lib/utils"
import { Button } from "./ui/button"
import { QrCode } from "./qr-code"
import { QrPrintButton } from "./qr-print-button"
import type { Spool } from "@/lib/types"

/**
 * Tag / QR management for a single spool, shown inside its Edit dialog. Lets the
 * user see the spool's printable QR, print it, bind a physical NFC tag (where
 * supported), or unbind. All bindings write to the synced `tagBindings` registry
 * so every device — including the wall display — stays in sync.
 */
export function SpoolTagSection({ spool }: { spool: Spool }) {
  const { state, dispatch } = useStore()
  // The spool may already carry a tag id (from a prior QR/NFC bind). If not, we
  // mint a stable QR id on demand the first time the user reveals the code, so
  // an unscanned spool still gets a consistent, printable QR.
  const [revealed, setRevealed] = useState<string | null>(spool.tagId ?? null)
  const [nfcBusy, setNfcBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const caption = `${spool.brand} ${spool.material}`.trim()
  const sub = spool.colorName

  function ensureId(): string {
    if (revealed) return revealed
    const id = newQrTagId()
    setRevealed(id)
    dispatch({ type: "BIND_TAG", binding: { id, target: { kind: "spool", spoolId: spool.id }, boundAt: Date.now(), via: "qr" } })
    return id
  }

  async function bindNfc() {
    setError(null)
    setNfcBusy(true)
    try {
      const scan = await scanNfcOnce()
      dispatch({
        type: "BIND_TAG",
        binding: { id: scan.serialNumber, target: { kind: "spool", spoolId: spool.id }, boundAt: Date.now(), via: "nfc" },
      })
      setRevealed(scan.serialNumber)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read tag")
    } finally {
      setNfcBusy(false)
    }
  }

  function unbind() {
    if (spool.tagId) dispatch({ type: "UNBIND_TAG", id: spool.tagId })
    setRevealed(null)
  }

  return (
    <div className="rounded-xl border border-border bg-background/50 p-3">
      <div className="flex items-center gap-2">
        <QrIcon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">RFID / QR tag</h3>
        {spool.tagId ? (
          <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">Bound</span>
        ) : (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">No tag</span>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-muted-foreground text-pretty">
        Print a QR label to stick on the spool, or bind a physical NFC tag. Scanning it from the Scan tab jumps straight
        to this spool.
      </p>

      {revealed ? (
        <div className="mt-3 flex flex-col items-center gap-3">
          <QrCode id={revealed} size={168} />
          <p className="font-mono text-[11px] text-muted-foreground break-all">{qrPayload(revealed)}</p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <QrPrintButton labels={[{ contents: qrPayload(revealed), caption, sub }]} />
            <Button size="sm" variant="ghost" onClick={unbind}>
              <Link2Off className="h-4 w-4" /> Unbind
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={ensureId}>
            <QrIcon className="h-4 w-4" /> Show QR code
          </Button>
          {nfcSupported() && (
            <Button size="sm" variant="outline" onClick={bindNfc} disabled={nfcBusy}>
              <Nfc className="h-4 w-4" /> {nfcBusy ? "Tap a tag…" : "Bind NFC tag"}
            </Button>
          )}
        </div>
      )}

      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
          <Link2 className="h-3.5 w-3.5" /> {error}
        </p>
      )}
    </div>
  )
}
