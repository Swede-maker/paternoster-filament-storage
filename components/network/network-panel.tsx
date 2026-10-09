"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  Router,
  Send,
  Smartphone,
  Terminal,
  TriangleAlert,
  Wifi,
  WifiOff,
} from "lucide-react"
import { useStore } from "@/lib/store"
import type { StorageNode } from "@/lib/types"
import type { NetPin, NetSlave, WifiNetwork } from "@/lib/node-protocol"
import { NET_MODE_LABEL, NET_PIN_LABEL, signalBars, validatePsk, wifiQrPayload } from "@/lib/net"
import { qrSvgMarkup } from "@/lib/qr"
import { cn } from "@/lib/utils"
import { Button } from "../ui/button"
import { Dialog, DialogFooter } from "../ui/dialog"
import { Segmented } from "../ui/field"
import { SignalBars, WifiList } from "./wifi-list"
import { AddSlaveCarouselDialog } from "./add-slave-carousel-dialog"

/**
 * Network management for the master Raspberry Pi: mode pin, live status,
 * Wi-Fi scanner + credential entry, hotspot details, and the slaves that
 * follow it. Everything here talks to /api/net/* which proxies to the Pi over
 * the existing relay; results stream back over the SSE link as `net.*` frames
 * and land on `node.net` / `node.netSlaves` / `node.netResult`.
 */
export function NetworkPanel({ node }: { node: StorageNode }) {
  const { state, dispatch } = useStore()
  const [addingSlave, setAddingSlave] = useState<NetSlave | null>(null)
  const net = node.net ?? null
  const result = node.netResult ?? null
  const slaves = node.netSlaves ?? []
  const online = node.link === "online"

  const target = useMemo(() => ({ host: node.ip, port: node.port }), [node.ip, node.port])

  const [networks, setNetworks] = useState<WifiNetwork[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [joining, setJoining] = useState<string | null>(null)
  const [pendingPin, setPendingPin] = useState<NetPin | null>(null)
  const [confirmAp, setConfirmAp] = useState(false)
  const [showApPsk, setShowApPsk] = useState(false)
  const [apPsk, setApPsk] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [newPsk, setNewPsk] = useState("")
  const [newPskError, setNewPskError] = useState<string | null>(null)

  // Ask for a fresh picture whenever the link comes up.
  useEffect(() => {
    if (!online) return
    void fetch(`/api/net/status?host=${encodeURIComponent(target.host)}&port=${target.port}&fresh=1`).catch(() => {})
  }, [online, target])

  // A join/mode result closes the pending spinners.
  useEffect(() => {
    if (!result) return
    if (result.op === "join") setJoining(null)
    if (result.op === "mode") setPendingPin(null)
    if (result.op === "provision-slaves" || result.op === "forget") setBusy(null)
    if (result.op === "set-ap-psk") {
      setBusy(null)
      if (result.ok) setNewPsk("")
    }
  }, [result])

  // Once the Pi is genuinely on the new network, clear the join spinner even
  // if the `join` result got lost in the reconnect.
  useEffect(() => {
    if (joining && net?.mode === "router" && net.ssid === joining) setJoining(null)
  }, [joining, net])

  const scan = async () => {
    setScanning(true)
    setScanError(null)
    try {
      const r = await fetch("/api/net/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
      })
      const data = (await r.json()) as { ok: boolean; networks?: WifiNetwork[]; error?: string }
      if (!data.ok) throw new Error(data.error ?? "Scan failed")
      setNetworks(data.networks ?? [])
    } catch (err) {
      setScanError(err instanceof Error ? err.message : "Scan failed")
    } finally {
      setScanning(false)
    }
  }

  const join = async (ssid: string, psk: string) => {
    setJoining(ssid)
    dispatch({ type: "NODE_NET_RESULT", nodeId: node.id, result: null })
    try {
      const r = await fetch("/api/net/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, ssid, psk }),
      })
      const data = (await r.json()) as { ok: boolean; error?: string }
      if (!data.ok) throw new Error(data.error ?? "Could not send")
    } catch (err) {
      setJoining(null)
      dispatch({
        type: "NODE_NET_RESULT",
        nodeId: node.id,
        result: { type: "net.result", op: "join", ok: false, error: err instanceof Error ? err.message : "Failed" },
      })
    }
  }

  const postMode = async (body: Record<string, unknown>, opLabel: string) => {
    dispatch({ type: "NODE_NET_RESULT", nodeId: node.id, result: null })
    try {
      const r = await fetch("/api/net/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, ...body }),
      })
      const data = (await r.json()) as { ok: boolean; error?: string }
      if (!data.ok) throw new Error(data.error ?? "Could not send")
    } catch (err) {
      setPendingPin(null)
      setBusy(null)
      dispatch({
        type: "NODE_NET_RESULT",
        nodeId: node.id,
        result: { type: "net.result", op: opLabel, ok: false, error: err instanceof Error ? err.message : "Failed" },
      })
    }
  }

  const submitNewPsk = async () => {
    const err = validatePsk(newPsk) ?? (newPsk === "" ? "A hotspot password is required" : null)
    if (err) {
      setNewPskError(err)
      return
    }
    setNewPskError(null)
    setBusy("set-ap-psk")
    dispatch({ type: "NODE_NET_RESULT", nodeId: node.id, result: null })
    try {
      const r = await fetch("/api/net/hotspot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...target, psk: newPsk }),
      })
      const data = (await r.json()) as { ok: boolean; error?: string }
      if (!data.ok) throw new Error(data.error ?? "Could not send")
      // Optimistically show the new key in the QR field; the result banner
      // will say if the Pi rejected it.
      setApPsk(newPsk)
    } catch (err) {
      setBusy(null)
      dispatch({
        type: "NODE_NET_RESULT",
        nodeId: node.id,
        result: { type: "net.result", op: "set-ap-psk", ok: false, error: err instanceof Error ? err.message : "Failed" },
      })
    }
  }

  const requestPin = (pin: NetPin) => {
    if (pin === (net?.pin ?? "auto")) return
    if (pin === "ap" && net?.mode !== "ap") {
      setConfirmAp(true)
      return
    }
    setPendingPin(pin)
    void postMode({ mode: pin }, "mode")
  }

  const apSsid = net?.apSsid ?? "PAX-Setup"
  const appUrl = `http://${net?.hostname ?? "pax-master"}.local`

  // The hotspot password is only known to the Pi; we never receive it over the
  // wire in `net.status`. The installer prints it and it lives in
  // /etc/paxnet.conf — the panel lets the operator paste it once to render a
  // join-QR for phones. Kept in component state only.
  const qr = useMemo(() => (apPsk ? qrSvgMarkup(wifiQrPayload(apSsid, apPsk), 168) : null), [apSsid, apPsk])

  return (
    <div className="space-y-5">
      <MasterIdentityCard hostname={net?.hostname ?? null} apSsid={net?.apSsid ?? null} online={online} />

      {/* Live status */}
      <StatusStrip node={node} />

      {!online && (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-background/40 px-3 py-2 text-sm text-muted-foreground">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The app can&apos;t reach the master right now. If it fell back to its hotspot, join{" "}
            <span className="font-medium text-foreground">{apSsid}</span> on your phone and open{" "}
            <span className="font-mono text-foreground">{appUrl}</span>.
          </span>
        </p>
      )}

      {isLoopback(node.ip) && !net && (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground text-pretty">
          This unit points at <span className="font-mono">{node.ip}</span>, i.e. the machine serving this app. That
          is correct when the app runs on the master Pi itself. If you are viewing a preview or running the app on a
          PC, set the master&apos;s address to <span className="font-mono">pax-master.local</span> under Storage units.
        </p>
      )}

      {net?.error && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{net.error}</span>
        </p>
      )}

      {/* Mode */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">Connection mode</h3>
          <Segmented<NetPin>
            options={[
              { value: "auto", label: NET_PIN_LABEL.auto },
              { value: "router", label: NET_PIN_LABEL.router },
              { value: "ap", label: NET_PIN_LABEL.ap },
            ]}
            value={pendingPin ?? net?.pin ?? "auto"}
            onChange={requestPin}
          />
        </div>
        <p className="text-xs text-muted-foreground text-pretty">
          <span className="font-medium text-foreground">Auto</span> joins the saved router and, if it can&apos;t within 45 s of
          booting, starts the <span className="font-medium text-foreground">{apSsid}</span> hotspot so a phone can still
          reach it — then keeps checking for the router every minute.{" "}
          <span className="font-medium text-foreground">Local router</span> never falls back.{" "}
          <span className="font-medium text-foreground">Standalone AP</span> forces the hotspot on.
        </p>
        {pendingPin && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Switching to {NET_PIN_LABEL[pendingPin]}…
          </p>
        )}
      </div>

      {/* Result banner */}
      {result && result.op !== "ap-starting" && result.op !== "join-starting" && (
        <ResultBanner result={result} onDismiss={() => dispatch({ type: "NODE_NET_RESULT", nodeId: node.id, result: null })} />
      )}
      {result?.op === "join-starting" && (
        <p className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Joining <span className="font-medium">{result.ssid}</span>. If you&apos;re on the hotspot, reconnect your phone to the
          same router and reload.
        </p>
      )}
      {result?.op === "ap-starting" && (
        <p className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Starting hotspot <span className="font-medium">{result.apSsid ?? apSsid}</span>. Join it on your phone and open{" "}
          <span className="font-mono">{appUrl}</span>.
        </p>
      )}

      {/* Wi-Fi scanner */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">Wi-Fi networks</h3>
          {net?.routerSaved && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!online || busy === "forget"}
              onClick={() => {
                if (!confirm("Forget the saved router on the master? It will fall back to its hotspot on next boot.")) return
                setBusy("forget")
                void postMode({ op: "forget" }, "forget")
              }}
            >
              {busy === "forget" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Forget saved router
            </Button>
          )}
        </div>
        <WifiList
          networks={networks}
          scanning={scanning}
          scanError={online ? scanError : "Master is offline — connect to it first."}
          currentSsid={net?.mode === "router" ? net.ssid : null}
          joining={joining}
          onScan={scan}
          onJoin={join}
        />
      </div>

      {/* Hotspot */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Standalone hotspot</h3>
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-background/40 p-3 sm:flex-row">
          <dl className="flex-1 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Network</dt>
              <dd className="font-mono font-medium text-foreground">{apSsid}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">App address</dt>
              <dd className="font-mono text-foreground">{appUrl}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Fallback IP</dt>
              <dd className="font-mono text-foreground">10.42.0.1</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">Password</dt>
              <dd className="flex items-center gap-1">
                <input
                  type={showApPsk ? "text" : "password"}
                  value={apPsk ?? ""}
                  onChange={(e) => setApPsk(e.target.value || null)}
                  placeholder="from install.sh"
                  aria-label="Hotspot password (for the QR code)"
                  autoComplete="off"
                  className="h-8 w-36 rounded-md border border-input bg-background/60 px-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => setShowApPsk((v) => !v)}
                  aria-label={showApPsk ? "Hide hotspot password" : "Show hotspot password"}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                >
                  {showApPsk ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </dd>
            </div>
            <p className="pt-1 text-xs text-muted-foreground text-pretty">
              Type the current password here to show a QR code phones can scan to join.
            </p>
          </dl>
          <div className="flex shrink-0 items-center justify-center">
            {qr ? (
              <div
                className="rounded-xl bg-white p-2"
                style={{ width: 168, height: 168 }}
                aria-label={`Wi-Fi QR code for ${apSsid}`}
                role="img"
                // Generated locally from our own SSID + the operator's input.
                dangerouslySetInnerHTML={{ __html: qr }}
              />
            ) : (
              <div className="flex h-[168px] w-[168px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-center text-xs text-muted-foreground">
                <Smartphone className="h-5 w-5" />
                Enter the password to show a join QR
              </div>
            )}
          </div>
        </div>
        <HotspotPasswordForm
          apSsid={apSsid}
          online={online}
          hotspotLive={net?.mode === "ap"}
          saving={busy === "set-ap-psk"}
          value={newPsk}
          error={newPskError}
          onChange={(v) => {
            setNewPsk(v)
            if (newPskError) setNewPskError(null)
          }}
          onSubmit={() => void submitNewPsk()}
        />
      </div>

      {/* Slaves */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">Slave units following this master</h3>
          <Button
            variant="secondary"
            size="sm"
            disabled={!online || !net?.routerSaved || slaves.length === 0 || busy === "provision-slaves"}
            onClick={() => {
              setBusy("provision-slaves")
              void postMode({ op: "provision-slaves" }, "provision-slaves")
            }}
          >
            {busy === "provision-slaves" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Re-push credentials
          </Button>
        </div>
        {slaves.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground text-pretty">
            No slaves have registered yet. Run the same <span className="font-mono text-foreground">setup.sh</span>{" "}
            command on a slave Pi and answer <span className="font-medium text-foreground">2</span> while it is on the
            same network (router or this hotspot) — it will find the master by name and show up here.
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {slaves.map((s) => (
              <li key={s.hostname} className="flex items-center gap-3 bg-background/40 px-3 py-2.5 text-sm">
                <span
                  className={cn("h-2 w-2 shrink-0 rounded-full", s.online ? "bg-primary" : "bg-muted-foreground/40")}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono font-medium text-foreground">{s.hostname}.local</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {s.online ? "Online" : "Last seen offline"}
                    {s.mode ? ` · ${NET_MODE_LABEL[s.mode]}` : ""}
                    {s.ssid ? ` · ${s.ssid}` : ""}
                    {s.ip ? ` · ${s.ip}` : ""}
                  </span>
                </span>
                {(() => {
                  const linked = state.nodes.find(
                    (n) => n.ip.toLowerCase() === `${s.hostname}.local`.toLowerCase() || (!!s.ip && n.ip === s.ip),
                  )
                  return linked ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                      <span className="max-w-24 truncate">{linked.name}</span>
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="min-h-11 shrink-0"
                      onClick={() => setAddingSlave(s)}
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      Add as carousel
                    </Button>
                  )
                })()}
              </li>
            ))}
          </ul>
        )}
        {addingSlave && (
          <AddSlaveCarouselDialog
            key={addingSlave.hostname}
            slave={addingSlave}
            open
            onClose={() => setAddingSlave(null)}
          />
        )}
        <p className="text-xs text-muted-foreground text-pretty">
          Slaves keep this hotspot as a fallback. When you save a new router above, the master pushes it to every online
          slave before switching itself, so the whole chain moves together.
        </p>
      </div>

      {/* Confirm AP */}
      <Dialog
        open={confirmAp}
        onClose={() => setConfirmAp(false)}
        title="Switch to standalone hotspot?"
        description="The master will leave the router and start its own Wi-Fi."
        className="max-w-md"
      >
        <div className="space-y-3 text-sm text-foreground">
          <p className="text-pretty">
            This tab will lose its connection. To keep using the app, join{" "}
            <span className="font-mono font-medium">{apSsid}</span> on your phone or laptop and open{" "}
            <span className="font-mono font-medium">{appUrl}</span> (or <span className="font-mono">http://10.42.0.1</span>).
          </p>
          <p className="text-muted-foreground text-pretty">
            Slaves will follow onto the hotspot within about a minute. Switch back to Auto or Local router from the same
            panel later.
          </p>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setConfirmAp(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setConfirmAp(false)
              setPendingPin("ap")
              void postMode({ mode: "ap" }, "mode")
            }}
          >
            <Radio className="h-4 w-4" /> Start hotspot
          </Button>
        </DialogFooter>
      </Dialog>

    </div>
  )
}

const SHOW_HOTSPOT_PASSWORD_COMMAND =
  "echo \"Master name:      $(hostname).local\"; sudo awk -F' *= *' '$1==\"ap_ssid\"{print \"Hotspot name:     \" $2} $1==\"ap_psk\"{print \"Hotspot password: \" $2}' /etc/paxnet.conf"

function MasterIdentityCard({
  hostname,
  apSsid,
  online,
}: {
  hostname: string | null
  apSsid: string | null
  online: boolean
}) {
  const pending = online ? "Waiting for the Pi…" : "Unknown while offline"
  return (
    <section
      aria-label="Master identity"
      className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3"
    >
      <IdentityRow
        label="Master name"
        hint="Open this in a browser, and type it as the master address when installing a slave."
        value={hostname ? `${hostname}.local` : null}
        pending={pending}
      />
      <div className="h-px bg-border" aria-hidden="true" />
      <IdentityRow
        label="Hotspot name"
        hint="The Wi-Fi network the master opens when no router is around."
        value={apSsid}
        pending={pending}
      />
    </section>
  )
}

function IdentityRow({
  label,
  hint,
  value,
  pending,
}: {
  label: string
  hint: string
  value: string | null
  pending: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard can be blocked over plain http; the value is still selectable.
    }
  }
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {value ? (
          <p className="select-all break-all font-mono text-lg font-semibold leading-snug text-foreground">{value}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{pending}</p>
        )}
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground text-pretty">{hint}</p>
      </div>
      {value && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-11 w-11 shrink-0"
          onClick={() => void copy()}
          aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
      )}
    </div>
  )
}

function HotspotPasswordForm({
  apSsid,
  online,
  hotspotLive,
  saving,
  value,
  error,
  onChange,
  onSubmit,
}: {
  apSsid: string
  online: boolean
  hotspotLive: boolean
  saving: boolean
  value: string
  error: string | null
  onChange: (v: string) => void
  onSubmit: () => void
}) {
  const [showForgot, setShowForgot] = useState(false)
  const [copied, setCopied] = useState(false)

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(SHOW_HOTSPOT_PASSWORD_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-background/40 p-3">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <label htmlFor="new-hotspot-psk" className="text-sm font-medium text-foreground">
          Change hotspot password
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="new-hotspot-psk"
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="New password, 8–63 characters"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={!online || saving}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "new-hotspot-psk-error" : "new-hotspot-psk-help"}
            className={cn(
              "h-11 min-w-0 flex-1 rounded-md border bg-background px-3 font-mono text-base text-foreground placeholder:font-sans placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
              error ? "border-destructive" : "border-input",
            )}
          />
          <Button type="submit" className="h-11" disabled={!online || saving || value === ""}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            Save password
          </Button>
        </div>
        {error ? (
          <p id="new-hotspot-psk-error" className="text-xs text-destructive">
            {error}
          </p>
        ) : (
          <p id="new-hotspot-psk-help" className="text-xs text-muted-foreground text-pretty">
            {online
              ? `This is the Wi-Fi password for ${apSsid}, the network the master opens when no router is around. Online slaves get the new password too.`
              : "Connect to the master to change the password."}
          </p>
        )}
        {hotspotLive && (
          <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground text-pretty">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            The hotspot is on right now. It restarts when you save, and this phone has to rejoin with the new password.
          </p>
        )}
      </form>

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setShowForgot((v) => !v)}
          aria-expanded={showForgot}
          aria-controls="forgot-hotspot-psk"
          className="flex min-h-11 items-center gap-2 self-start rounded-md text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Terminal className="h-4 w-4" />
          {showForgot ? "Hide" : "Forgot the password?"}
        </button>
        {showForgot && (
          <div id="forgot-hotspot-psk" className="flex flex-col gap-2">
            <p className="text-xs text-muted-foreground text-pretty">
              Log in to the master Pi over SSH, paste this line and press Enter. It prints the hotspot name and the
              current password. Nothing is changed.
            </p>
            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-2">
              <code className="block overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed text-foreground">
                {SHOW_HOTSPOT_PASSWORD_COMMAND}
              </code>
              <Button type="button" variant="outline" className="h-11 self-stretch sm:self-end" onClick={() => void copyCommand()}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy line"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function isLoopback(host: string | undefined): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  return h === "localhost" || h === "::1" || h.startsWith("127.")
}

function StatusStrip({ node }: { node: StorageNode }) {
  const net = node.net
  const online = node.link === "online"
  const mode = net?.mode ?? (online ? "unknown" : "offline")
  const Icon = mode === "ap" ? Radio : mode === "router" ? Router : mode === "master-ap" ? Wifi : WifiOff
  const tone =
    mode === "router"
      ? "border-primary/40 bg-primary/5"
      : mode === "ap"
        ? "border-accent/60 bg-accent/10"
        : "border-border bg-background/40"

  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2.5", tone)}>
      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon className="h-4 w-4 text-primary" />
        {online ? (net?.error && mode === "unknown" ? "No network support" : NET_MODE_LABEL[mode]) : "Master unreachable"}
      </span>
      {net?.ssid && (
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {mode !== "ap" && <SignalBars level={signalBars(net.signal)} />}
          <span className="font-mono text-foreground">{net.ssid}</span>
        </span>
      )}
      {net?.ip && <span className="font-mono text-sm text-muted-foreground">{net.ip}</span>}
      {net?.hostname && <span className="font-mono text-sm text-muted-foreground">{net.hostname}.local</span>}
      {online && !net && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" /> Waiting for the Pi&apos;s network report
        </span>
      )}
    </div>
  )
}

function ResultBanner({
  result,
  onDismiss,
}: {
  result: NonNullable<StorageNode["netResult"]>
  onDismiss: () => void
}) {
  let text: string
  switch (result.op) {
    case "join":
      text = result.ok ? `Connected to ${result.ssid ?? "the router"}.` : `Could not join: ${result.error ?? "unknown error"}`
      break
    case "mode":
      text = result.ok ? `Mode set to ${result.mode ? NET_PIN_LABEL[result.mode] : "the new value"}.` : `Mode change failed: ${result.error}`
      break
    case "provision-slaves": {
      const a = result.acked?.length ?? 0
      const f = result.failed ?? []
      text = result.ok
        ? `Pushed router credentials to ${a} slave${a === 1 ? "" : "s"}${f.length ? ` — ${f.length} did not answer (${f.join(", ")})` : ""}.`
        : `Provisioning failed: ${result.error}`
      break
    }
    case "forget":
      text = result.ok ? "Saved router removed." : `Could not forget router: ${result.error}`
      break
    case "set-ap-psk": {
      const a = result.acked?.length ?? 0
      const f = result.failed ?? []
      text = result.ok
        ? `Hotspot password changed${a ? ` and sent to ${a} slave${a === 1 ? "" : "s"}` : ""}${f.length ? ` — ${f.length} slave${f.length === 1 ? "" : "s"} did not answer (${f.join(", ")}) and still has the old key` : ""}.`
        : `Could not change hotspot password: ${result.error ?? "unknown error"}`
      break
    }
    default:
      text = result.ok ? `${result.op} done.` : `${result.op} failed: ${result.error ?? "unknown error"}`
  }
  return (
    <div
      role="status"
      className={cn(
        "flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
        result.ok ? "border-primary/40 bg-primary/5 text-foreground" : "border-destructive/40 bg-destructive/5 text-destructive",
      )}
    >
      <span className="text-pretty">{text}</span>
      <button type="button" onClick={onDismiss} className="shrink-0 text-xs underline-offset-2 hover:underline">
        Dismiss
      </button>
    </div>
  )
}
