"use client"

import { useEffect, useRef, useState } from "react"
import { ExternalLink, RefreshCw, MonitorSmartphone, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Printer } from "@/lib/types"

/** Resolve the address of a printer's own web UI: explicit `webUrl` wins,
 *  otherwise fall back to plain http on its IP. Returns null when neither
 *  exists (e.g. a Bambu printer linked only by serial). */
export function printerWebUrl(printer: Printer): string | null {
  const explicit = printer.webUrl?.trim()
  if (explicit) return /^https?:\/\//i.test(explicit) ? explicit : `http://${explicit}`
  const ip = printer.ip?.trim()
  if (ip) return `http://${ip}`
  return null
}

/**
 * Embeds a printer's own interface (Mainsail/Fluidd/vendor UI) inside PAX so
 * the operator doesn't leave the app. Many controllers block being framed
 * (X-Frame-Options / frame-ancestors) or refuse http-in-https, so we can't
 * reliably detect a blocked load from the parent — instead we always surface a
 * prominent "open in new tab" fallback and a short note about it.
 */
export function PrinterEmbed({ printer }: { printer: Printer }) {
  const url = printerWebUrl(printer)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  // Bumping this key forces the iframe to remount, which is the only reliable
  // cross-origin way to reload a framed UI we can't reach into.
  const [reloadKey, setReloadKey] = useState(0)

  // If PAX itself is served over https, an http iframe is mixed content and the
  // browser will silently block it. Warn up front in that case.
  const [mixedContent, setMixedContent] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined" || !url) return
    setMixedContent(window.location.protocol === "https:" && url.startsWith("http://"))
  }, [url])

  if (!url) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <MonitorSmartphone className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground text-pretty">
          This printer has no IP or Web UI address, so there&apos;s nothing to embed. Add one with Edit to view its
          interface here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-muted-foreground">{url}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setReloadKey((k) => k + 1)}>
            <RefreshCw className="h-4 w-4" /> Reload
          </Button>
          <Button size="sm" variant="secondary" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
            <ExternalLink className="h-4 w-4" /> Open in new tab
          </Button>
        </div>
      </div>

      {mixedContent && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="text-pretty">
            PAX is loaded over HTTPS but this printer serves plain HTTP, so the browser blocks the embed below. Use
            <span className="font-medium"> Open in new tab</span>, or run PAX over HTTP on your LAN to embed it.
          </p>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-background">
        <iframe
          key={reloadKey}
          ref={iframeRef}
          src={url}
          title={`${printer.name} web interface`}
          className="h-full w-full"
          // Allow the framed UI to run normally while keeping it sandboxed from
          // top-level navigation of the PAX tab.
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
        />
        {/* Fallback shown underneath the iframe: if the frame is blocked the
            iframe area is blank, and this note explains what to do. It sits
            behind the iframe (z-0) so a working embed fully covers it. */}
        <div className="pointer-events-none absolute inset-0 z-[-1] flex flex-col items-center justify-center gap-2 p-8 text-center">
          <MonitorSmartphone className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground text-pretty">
            If nothing appears, this printer&apos;s firmware refuses to be embedded. Use{" "}
            <span className="font-medium">Open in new tab</span> instead.
          </p>
        </div>
      </div>
    </div>
  )
}
