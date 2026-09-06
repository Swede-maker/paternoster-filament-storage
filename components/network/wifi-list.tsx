"use client"

import { useEffect, useState } from "react"
import { Check, Eye, EyeOff, Loader2, Lock, RefreshCw, Wifi } from "lucide-react"
import type { WifiNetwork } from "@/lib/node-protocol"
import { signalBars, validatePsk } from "@/lib/net"
import { cn } from "@/lib/utils"
import { Button } from "../ui/button"
import { Input } from "../ui/field"

/**
 * Scanner + picker. Tapping a row expands an inline password field; "Save &
 * connect" hands the credentials up. The parent owns the scan (so it can show
 * scanning state next to its own status pill) and the join.
 */
export function WifiList({
  networks,
  scanning,
  scanError,
  currentSsid,
  joining,
  onScan,
  onJoin,
}: {
  networks: WifiNetwork[] | null
  scanning: boolean
  scanError: string | null
  currentSsid?: string | null
  /** SSID currently being joined, if any. */
  joining: string | null
  onScan: () => void
  onJoin: (ssid: string, psk: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [psk, setPsk] = useState("")
  const [showPsk, setShowPsk] = useState(false)

  // Once the Pi reports it is on the network we picked, fold the row back up
  // and drop the typed password from memory.
  useEffect(() => {
    if (selected && currentSsid === selected && !joining) {
      setSelected(null)
      setPsk("")
    }
  }, [currentSsid, selected, joining])

  // Live status beats the scan's snapshot: `inUse` describes the moment of the
  // scan, which is stale the instant a join succeeds.
  const isConnected = (n: WifiNetwork) => (currentSsid != null ? n.ssid === currentSsid : n.inUse)

  const pick = (ssid: string) => {
    setSelected((cur) => (cur === ssid ? null : ssid))
    setPsk("")
    setShowPsk(false)
  }

  const selectedNet = networks?.find((n) => n.ssid === selected) ?? null
  const isOpen = selectedNet ? /open|^--$|^$/i.test(selectedNet.security) : false
  const pskErr = isOpen ? null : validatePsk(psk) ?? (psk ? null : "Enter the Wi-Fi password")

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Pick the workshop router. The master saves it and hands the same credentials to every slave.
        </p>
        <Button variant="secondary" size="sm" onClick={onScan} disabled={scanning} aria-label="Scan for Wi-Fi networks">
          {scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {scanning ? "Scanning" : "Scan"}
        </Button>
      </div>

      {scanError && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {scanError}
        </p>
      )}

      {networks === null && !scanning && !scanError && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-8 text-center">
          <Wifi className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Tap Scan to list the networks the master Pi can see.</p>
        </div>
      )}

      {networks && networks.length === 0 && !scanning && (
        <p className="rounded-lg border border-dashed border-border py-6 text-center text-sm text-muted-foreground">
          No networks found. Move the Pi closer to the router and scan again.
        </p>
      )}

      {networks && networks.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border" aria-label="Wi-Fi networks">
          {networks.map((n) => {
            const active = n.ssid === selected
            const connected = isConnected(n)
            const secured = !/open|^--$|^$/i.test(n.security)
            const busy = joining === n.ssid
            return (
              <li key={n.ssid} className="bg-background/40">
                <button
                  type="button"
                  onClick={() => pick(n.ssid)}
                  aria-expanded={active}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/60",
                    active && "bg-secondary/60",
                  )}
                >
                  <SignalBars level={signalBars(n.signal)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{n.ssid}</span>
                    <span className="block text-xs text-muted-foreground">
                      {secured ? n.security : "Open network"} · {n.signal}%
                    </span>
                  </span>
                  {busy ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-label="Connecting" />
                  ) : connected ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                      <Check className="h-3 w-3" /> Connected
                    </span>
                  ) : secured ? (
                    <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Secured" />
                  ) : null}
                </button>

                {active && (
                  <form
                    className="flex flex-col gap-2 border-t border-border bg-card px-3 py-3 sm:flex-row sm:items-start"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (pskErr) return
                      onJoin(n.ssid, isOpen ? "" : psk)
                    }}
                  >
                    {!isOpen && (
                      <div className="relative flex-1">
                        <Input
                          type={showPsk ? "text" : "password"}
                          value={psk}
                          onChange={(e) => setPsk(e.target.value)}
                          placeholder="Wi-Fi password"
                          autoComplete="off"
                          autoFocus
                          aria-label={`Password for ${n.ssid}`}
                          aria-invalid={psk.length > 0 && !!pskErr}
                          className="pr-11"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPsk((v) => !v)}
                          aria-label={showPsk ? "Hide password" : "Show password"}
                          className="absolute right-1 top-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                        >
                          {showPsk ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                        {psk.length > 0 && pskErr && (
                          <p className="mt-1 text-xs text-destructive">{pskErr}</p>
                        )}
                      </div>
                    )}
                    <Button type="submit" disabled={!!pskErr || busy} className="sm:shrink-0">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
                      Save &amp; connect
                    </Button>
                  </form>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function SignalBars({ level, className }: { level: 0 | 1 | 2 | 3 | 4; className?: string }) {
  return (
    <span className={cn("flex h-4 shrink-0 items-end gap-0.5", className)} aria-hidden="true">
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cn("w-1 rounded-sm", i <= level ? "bg-primary" : "bg-muted-foreground/30")}
          style={{ height: `${i * 25}%` }}
        />
      ))}
    </span>
  )
}
