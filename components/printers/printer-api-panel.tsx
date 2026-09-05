"use client"

import { useEffect, useState } from "react"
import { Copy, Check, KeyRound, RefreshCw, Trash2, Plug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStore } from "@/lib/store"

/** One copyable code/URL row. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // Clipboard can be unavailable on insecure origins; the value is still
      // visible for manual copy, so we just no-op.
    }
  }
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{value}</code>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

/**
 * "API access" block for the Printers section. Shows the LAN base URL an
 * external printer UI should call, the two endpoints, and an optional shared
 * token. Generating a token immediately protects the endpoints; clearing it
 * reopens them on the trusted LAN.
 */
export function PrinterApiPanel() {
  const { state, dispatch } = useStore()
  const [origin, setOrigin] = useState("")

  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin)
  }, [])

  const token = state.apiToken
  const base = origin || "http://<pax-host>"

  const generate = () => {
    const t =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().replace(/-/g, "")
        : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    dispatch({ type: "SET_API_TOKEN", token: t })
  }

  return (
    <section className="rounded-xl border border-border bg-card/60 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Plug className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">API access for printers</h3>
      </div>
      <p className="mb-4 text-xs text-muted-foreground text-pretty">
        Point a printer&apos;s macros or plugins at these endpoints to read live spools and request a filament dispense.
        All calls stay on your local network.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <CopyRow label="List spools (GET)" value={`${base}/api/printers/spools`} />
        <CopyRow label="Dispense (POST)" value={`${base}/api/printers/dispense`} />
      </div>

      <div className="mt-4 rounded-lg border border-border bg-background/50 p-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">Shared token</p>
          <span
            className={
              token
                ? "ml-auto rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"
                : "ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            }
          >
            {token ? "Protected" : "Open on LAN"}
          </span>
        </div>
        <p className="mt-1 mb-3 text-xs text-muted-foreground text-pretty">
          {token
            ? "Requests must send this token in the x-pax-token header (or ?token= query)."
            : "Endpoints are open to any device on your LAN. Generate a token to require authentication."}
        </p>

        {token && (
          <div className="mb-3">
            <CopyRow label="x-pax-token" value={token} />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={token ? "outline" : "primary"} onClick={generate}>
            <RefreshCw className="h-4 w-4" /> {token ? "Regenerate" : "Generate token"}
          </Button>
          {token && (
            <Button size="sm" variant="ghost" onClick={() => dispatch({ type: "SET_API_TOKEN", token: undefined })}>
              <Trash2 className="h-4 w-4" /> Clear
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
