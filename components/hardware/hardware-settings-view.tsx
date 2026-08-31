"use client"

import { useState, useEffect } from "react"
import {
  Network,
  Server,
  Package,
  Library,
  Plus,
  Cpu,
  Radio,
  Pencil,
  X,
  Save,
  Tags,
  Palette,
  TriangleAlert,
  ShieldCheck,
  Sun,
  Moon,
  Link as LinkIcon,
  Unlink,
  Loader2,
  Check,
  RotateCcw,
} from "lucide-react"
import { Dialog } from "../ui/dialog"
import { useStore } from "@/lib/store"
import { useTheme } from "@/lib/use-theme"
import { cn } from "@/lib/utils"
import { nodeSlotCount, nodesForSystem, getHardwareStats } from "@/lib/selectors"
import { newId } from "@/lib/filament"
import { HARDWARE_COLORS } from "@/lib/hardware"
import type { StorageNode } from "@/lib/types"
import { Button } from "../ui/button"
import { Field, Input, Checkbox } from "../ui/field"
import {
  draftFromNode,
  draftToConfig,
  makeDraft,
  StorageLayoutEditor,
  type StorageDraft,
} from "../storage-layout-editor"

/**
 * Settings for the Hardware area. Mirrors the filament Settings tab but scoped
 * to hardware units (no printers, no filament presets). Adds category + color
 * preset management used by the add-hardware form, and lets a hardware
 * paternoster be linked as a slave — even to a filament master, since the
 * physical carousel chain is shared across areas.
 */
export function HardwareSettingsView() {
  const { state, dispatch } = useStore()
  const stats = getHardwareStats(state)
  const hwNodes = nodesForSystem(state, "hardware")

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 overflow-y-auto p-4 scrollbar-thin">
      <h1 className="text-xl font-bold">Hardware settings</h1>

      {/* Safety — independent of the filament side; controls only hardware units.
          Falls back to the filament flag for saves predating this per-area toggle. */}
      <Section icon={<ShieldCheck className="h-5 w-5 text-primary" />} title="Safety">
        <Checkbox
          checked={state.settings.confirmBeforeMoveHardware ?? state.settings.confirmBeforeMove}
          onChange={(v) => dispatch({ type: "UPDATE_SETTINGS", settings: { confirmBeforeMoveHardware: v } })}
          label="Confirm before every movement"
          description="When on, the machine waits for a 'Confirm & rotate' tap before the carousel moves during a job. Turn off to let it move automatically."
        />
      </Section>

      {/* Appearance — per-device theme (same control as filament Settings). */}
      <Section icon={<Sun className="h-5 w-5 text-primary" />} title="Appearance">
        <ThemeToggle />
      </Section>

      {/* Storage units */}
      <Section icon={<Network className="h-5 w-5 text-primary" />} title="Hardware storage units">
        <p className="text-sm text-muted-foreground">
          Add storage for hardware — a <span className="font-medium text-foreground">shelf</span> or{" "}
          <span className="font-medium text-foreground">library</span> for manual storage, or a{" "}
          <span className="font-medium text-foreground">paternoster</span> carousel that auto-balances parts across its
          slots. Each unit becomes its own tab on the Hardware home screen.
        </p>
        <NodeList />
        <AddNodeRow />
        <dl className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Units" value={hwNodes.length} />
          <Stat label="Total slots" value={stats.totalSlots} />
          <Stat label="Used" value={stats.usedSlots} />
        </dl>
      </Section>

      {/* Categories */}
      <Section icon={<Tags className="h-5 w-5 text-primary" />} title="Categories">
        <p className="text-sm text-muted-foreground">
          Categories group your hardware (e.g. Bolts, Nuts, Washers). Create them here or on the fly when adding
          hardware.
        </p>
        <CategoryManager />
      </Section>

      {/* Color presets */}
      <Section icon={<Palette className="h-5 w-5 text-primary" />} title="Slot colors">
        <p className="text-sm text-muted-foreground">
          Saved colors show up as quick picks in the add-hardware form. A slot takes its part&apos;s color in the
          carousel so it&apos;s easy to spot.
        </p>
        <ColorManager />
      </Section>

      {/* Danger zone */}
      <Section icon={<TriangleAlert className="h-5 w-5 text-destructive" />} title="Danger zone" danger>
        <p className="text-sm text-muted-foreground">
          Remove all hardware units and the parts stored on them. Filament storage is not affected. This cannot be
          undone.
        </p>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm("Remove every hardware unit and all stored hardware? Filament is untouched.")) {
              for (const n of nodesForSystem(state, "hardware")) dispatch({ type: "REMOVE_NODE", id: n.id })
            }
          }}
          disabled={hwNodes.length === 0}
        >
          <X className="h-4 w-4" /> Remove all hardware units
        </Button>
      </Section>
    </div>
  )
}

/**
 * Light/dark slider — per-device (localStorage), shared with the filament
 * Settings tab so a screen keeps one look across both areas.
 */
function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const isDark = theme === "dark"
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{isDark ? "Dark" : "Light"} theme</p>
        <p className="text-xs text-muted-foreground">
          Applies to this device only. Each screen remembers its own choice.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label="Toggle dark theme"
        onClick={toggle}
        className="relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border border-border bg-secondary transition-colors"
      >
        <span
          className={cn(
            "inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-transform",
            isDark ? "translate-x-7" : "translate-x-1",
          )}
        >
          {isDark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
        </span>
      </button>
    </div>
  )
}

/** Small colored connection indicator for a node. */
function LinkChip({ node }: { node: StorageNode }) {
  const map = {
    online: { dot: "bg-success", text: "text-success", label: "online" },
    checking: { dot: "bg-warning animate-pulse", text: "text-warning", label: "connecting" },
    offline: { dot: "bg-destructive", text: "text-destructive", label: "offline" },
    waiting: { dot: "bg-warning animate-pulse", text: "text-warning", label: "waiting for slave" },
    unlinked: { dot: "bg-muted-foreground", text: "text-muted-foreground", label: "not linked" },
  } as const

  // Driver-first: a node linked to a REAL Pi (driver "hardware") reports the
  // live relay link. Otherwise it's simulated, where the mock pairing code drives
  // status (paired = online, mid-pairing = waiting, created-but-unlinked = not
  // linked). A plain simulated node with no pairing is simply "online".
  let key: keyof typeof map
  if (node.driver === "hardware") {
    key = node.link
  } else if (node.pairStatus) {
    key = node.pairStatus === "paired" ? "online" : node.pairStatus === "pairing" ? "waiting" : "unlinked"
  } else {
    key = "online"
  }

  const s = map[key]
  return (
    <span className={`flex items-center gap-1 text-[10px] ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} /> {s.label}
    </span>
  )
}

function NodeList() {
  const { state, dispatch } = useStore()
  const hwNodes = nodesForSystem(state, "hardware")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pairingId, setPairingId] = useState<string | null>(null)
  const pairingNode = pairingId ? hwNodes.find((n) => n.id === pairingId) ?? null : null

  if (hwNodes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border bg-background/40 p-4 text-center text-sm text-muted-foreground">
        No hardware units yet. Add one below to start tracking hardware.
      </p>
    )
  }

  return (
    <>
    <ul className="space-y-2">
      {hwNodes.map((node) => {
        const nodeType = node.type ?? "paternoster"
        const isShelf = nodeType === "shelf"
        const isLibrary = nodeType === "library"
        const isManual = isShelf || isLibrary
        const isMaster = node.role === "master"
        const total = nodeSlotCount(node)
        return (
          <li key={node.id} className="rounded-xl border border-border bg-background/50 p-3">
            <div className="flex items-center gap-3">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                aria-hidden
              >
                {isLibrary ? (
                  <Library className="h-5 w-5" />
                ) : isShelf ? (
                  <Package className="h-5 w-5" />
                ) : (
                  <Server className="h-5 w-5" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">{node.name}</span>
                  <span className="rounded-md bg-secondary/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {isLibrary ? "library" : isShelf ? "shelf" : "paternoster"}
                  </span>
                  {!isManual && (
                    <>
                      <span
                        className={cn(
                          "rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          isMaster ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                        )}
                      >
                        {node.role}
                      </span>
                      <LinkChip node={node} />
                    </>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">
                    {isLibrary ? "library" : `${node.slots.length} shelves · ${total} slots`}
                    {node.driver === "hardware" && node.ip
                      ? ` · ${node.ip}:${node.port}`
                      : node.pairStatus === "paired" && node.deviceId
                        ? ` · ${node.deviceId}`
                        : ""}
                  </span>
                </p>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditingId(editingId === node.id ? null : node.id)}>
                <Pencil className="h-4 w-4" /> {editingId === node.id ? "Close" : "Edit layout"}
              </Button>
              {/* Promotes this unit to the single system-wide master; every
                  other paternoster (filament or hardware) becomes its slave, so
                  a hardware carousel can run under a filament master and vice
                  versa on the shared physical chain. */}
              {!isManual && !isMaster && (
                <Button variant="outline" size="sm" onClick={() => dispatch({ type: "SET_MASTER", id: node.id })}>
                  Make master
                </Button>
              )}
              {/* Link controls. A paternoster is either driven by a real Pi
                  (driver "hardware", linked by host:port) or simulated (optionally
                  mock-paired by code). Offer Link whenever it's neither yet. */}
              {!isManual && node.driver !== "hardware" && node.pairStatus !== "paired" && (
                <Button size="sm" onClick={() => setPairingId(node.id)}>
                  <LinkIcon className="h-4 w-4" /> Link
                </Button>
              )}
              {/* A real-linked Pi can be retried without editing the address, and
                  unlinked back to simulation. */}
              {node.driver === "hardware" && (
                <>
                  <Button variant="outline" size="sm" onClick={() => dispatch({ type: "RECONNECT_NODE", id: node.id })}>
                    <RotateCcw className="h-4 w-4" /> Reconnect
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (confirm(`Unlink ${node.name} from its Pi? It falls back to simulation until re-linked.`)) {
                        dispatch({
                          type: "UPDATE_NODE",
                          id: node.id,
                          changes: { driver: "simulated", ip: "" },
                        })
                      }
                    }}
                  >
                    <Unlink className="h-4 w-4" /> Unlink
                  </Button>
                </>
              )}
              {/* A mock (simulated) pairing can be cleared too. */}
              {node.driver !== "hardware" && node.pairStatus === "paired" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Unlink ${node.name}? You'll need to pair it again.`)) {
                      dispatch({ type: "UNPAIR_NODE", id: node.id })
                    }
                  }}
                >
                  <Unlink className="h-4 w-4" /> Unlink
                </Button>
              )}
              {state.nodes.length > 1 && !isMaster && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Remove ${node.name}? Hardware stored on it will be removed.`)) {
                      dispatch({ type: "REMOVE_NODE", id: node.id })
                    }
                  }}
                >
                  <X className="h-4 w-4" /> Remove
                </Button>
              )}
            </div>

            {editingId === node.id && <NodeLayoutEditor node={node} onDone={() => setEditingId(null)} />}
          </li>
        )
      })}
    </ul>
    {pairingNode && <PairingDialog node={pairingNode} onClose={() => setPairingId(null)} />}
    </>
  )
}

function NodeLayoutEditor({ node, onDone }: { node: StorageNode; onDone: () => void }) {
  const { dispatch } = useStore()
  const [draft, setDraft] = useState<StorageDraft>(() => draftFromNode(node))

  const save = () => {
    const { storage, shelfMeta } = draftToConfig(draft)
    dispatch({
      type: "UPDATE_NODE",
      id: node.id,
      changes: { name: draft.name.trim() || node.name, area: draft.area.trim() || undefined },
    })
    dispatch({ type: "RESHAPE_NODE", id: node.id, storage, shelfMeta })
    onDone()
  }

  return (
    <div className="mt-3 rounded-xl border border-border/70 bg-muted/20 p-3">
      <p className="mb-3 text-xs font-medium text-muted-foreground">
        {(node.type ?? "paternoster") === "library"
          ? "Rename or relocate this library. Its contents are never affected."
          : "Edit layout — removing shelves or slots discards any hardware stored there."}
      </p>
      <StorageLayoutEditor draft={draft} onChange={setDraft} allowTypeChange={false} />
      <div className="mt-3 flex gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" onClick={save}>
          <Save className="h-4 w-4" /> Save layout
        </Button>
      </div>
    </div>
  )
}

/** Turn a unit name into a default mDNS hostname, e.g. "Workshop Hardware" →
 *  "workshop-hardware.local". The Pi's install.sh derives the same name, so this
 *  is usually exactly what the operator needs to type. */
function slugifyHost(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${slug || "paternoster"}.local`
}

const HOST_RE = /^(\d{1,3}\.){3}\d{1,3}$/
const MDNS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/i

/**
 * Link a paternoster to its controller. Two ways, in tabs:
 *
 * - **Real Pi** — the production path. Enter the Pi's `<name>.local` mDNS name
 *   (printed by install.sh) + agent port; this flips the node to the "hardware"
 *   driver so the shared relay (`NodeConnection` → `/api/pi/stream`) opens a live
 *   connection. Identical to how a filament paternoster connects. Works for a
 *   master or a slave — the agent has no such concept.
 * - **Simulated** — a mock "pairing code" phone-home used for demos/testing when
 *   no hardware is present. It never touches a motor; clearly labelled as such.
 */
function PairingDialog({ node, onClose }: { node: StorageNode; onClose: () => void }) {
  const { state } = useStore()
  const live = nodesForSystem(state, "hardware").find((n) => n.id === node.id) ?? node
  const [tab, setTab] = useState<"real" | "sim">("real")

  return (
    <Dialog open onClose={onClose} title={`Link ${node.name}`} className="max-w-md">
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg border border-border bg-muted/20 p-1">
        {(
          [
            { id: "real", label: "Real Pi", Icon: Radio },
            { id: "sim", label: "Simulated", Icon: Cpu },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              tab === id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>
      {tab === "real" ? (
        <RealLinkPanel node={node} live={live} onClose={onClose} />
      ) : (
        <SimLinkPanel node={node} live={live} onClose={onClose} />
      )}
    </Dialog>
  )
}

/** Real-hardware connection form — the piece that drives an actual carousel. */
function RealLinkPanel({ node, live, onClose }: { node: StorageNode; live: StorageNode; onClose: () => void }) {
  const { dispatch } = useStore()
  const isHw = live.driver === "hardware"
  const [host, setHost] = useState(isHw && live.ip ? live.ip : slugifyHost(node.name))
  const [port, setPort] = useState(live.port || 8765)
  const valid = HOST_RE.test(host.trim()) || MDNS_RE.test(host.trim())
  const dirty = host.trim() !== live.ip || port !== live.port

  const connect = () =>
    dispatch({ type: "UPDATE_NODE", id: node.id, changes: { driver: "hardware", ip: host.trim(), port } })

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground text-pretty">
        Enter the Pi&apos;s network name and agent port. The app connects through its own server, so any device can
        drive the carousel as long as the server can reach the Pi.
      </p>
      <Field label="Pi hostname / IP address">
        <Input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="workshop-hardware.local"
          aria-label="Pi hostname or IP address"
        />
        {host && !valid && (
          <p className="mt-1 text-xs text-destructive">Enter an IPv4 address or a *.local hostname.</p>
        )}
      </Field>
      <Field label="Agent port">
        <Input
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(Math.max(1, Math.min(65535, Number.parseInt(e.target.value) || 8765)))}
          aria-label="Agent port"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Use the Pi&apos;s hostname (set when you imaged it) plus the agent port you passed to install.sh. Default port
          is 8765; give each Pi a unique hostname.
        </p>
      </Field>

      {/* Live link feedback once connected, mirroring the filament endpoint editor. */}
      {isHw && (
        <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                live.link === "online" ? "bg-success" : live.link === "checking" ? "bg-warning animate-pulse" : "bg-destructive",
              )}
            />
            {live.link === "online" ? "Connected to Pi agent" : live.link === "checking" ? "Connecting…" : "Offline"}
          </p>
          {live.link !== "online" && live.linkError && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground/80">{live.linkError}</p>
          )}
          {live.agentSimulated && (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs leading-relaxed text-warning">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Agent is faking motion (not driving GPIO){live.agentSimReason ? `: ${live.agentSimReason}` : ""}. The motor
              will not physically turn.
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={onClose}>
          {isHw && live.link === "online" ? "Done" : "Cancel"}
        </Button>
        {!isHw || dirty ? (
          <Button className="flex-1" disabled={!valid} onClick={connect}>
            <LinkIcon className="h-4 w-4" /> {isHw ? "Save & reconnect" : "Connect"}
          </Button>
        ) : (
          <Button variant="outline" className="flex-1" onClick={() => dispatch({ type: "RECONNECT_NODE", id: node.id })}>
            <RotateCcw className="h-4 w-4" /> Reconnect
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Mock "pairing code" phone-home for when there is no hardware yet. Stands in for
 * a slave that connects out and presents a code; it never drives a motor. A real
 * carousel is linked from the Real Pi tab instead.
 */
function SimLinkPanel({ node, live, onClose }: { node: StorageNode; live: StorageNode; onClose: () => void }) {
  const { dispatch } = useStore()
  const paired = live.pairStatus === "paired"

  // Issue a fresh code when the panel opens (unless already mid-pairing/paired).
  useEffect(() => {
    if (live.pairStatus !== "pairing" && live.pairStatus !== "paired") {
      dispatch({ type: "START_PAIRING", id: node.id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mock phone-home: the "slave" checks in shortly after the code appears.
  useEffect(() => {
    if (live.pairStatus !== "pairing") return
    const t = setTimeout(() => dispatch({ type: "CONFIRM_PAIRING", id: node.id }), 2600)
    return () => clearTimeout(t)
  }, [live.pairStatus, node.id, dispatch])

  // Leaving a half-finished pairing returns the unit to "unpaired".
  useEffect(() => {
    return () => {
      if (live.pairStatus === "pairing") dispatch({ type: "UNPAIR_NODE", id: node.id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (paired) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success">
          <Check className="h-6 w-6" />
        </span>
        <div>
          <p className="font-semibold text-foreground">{node.name} is linked (simulated)</p>
          <p className="text-sm text-muted-foreground">
            Mock device <span className="font-mono text-foreground">{live.deviceId}</span>. This does not drive real
            hardware — use the Real Pi tab for that.
          </p>
        </div>
        <Button className="mt-2 w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Simulation only — no motor is driven. For real assembly, use the Real Pi tab.
      </div>
      <p className="text-sm text-muted-foreground text-pretty">
        Enter this code on the slave (or flash it into its image). It connects out and presents the code — no address
        to set.
      </p>
      <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-muted/20 py-5">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Pairing code</span>
        <span className="font-mono text-3xl font-bold tracking-[0.2em] text-foreground">
          {live.pairingCode ?? "······"}
        </span>
      </div>
      <div className="flex items-center justify-center gap-2 text-sm text-warning">
        <Loader2 className="h-4 w-4 animate-spin" /> Waiting for the slave to check in…
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" className="flex-1" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="outline" className="flex-1" onClick={() => dispatch({ type: "START_PAIRING", id: node.id })}>
          New code
        </Button>
        <Button className="flex-1" onClick={() => dispatch({ type: "CONFIRM_PAIRING", id: node.id })}>
          Simulate slave
        </Button>
      </div>
    </div>
  )
}

/** Add a hardware storage unit (tagged system: "hardware"). */
function AddNodeRow() {
  const { dispatch } = useStore()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<StorageDraft>(() => makeDraft("paternoster"))
  // "Real Pi" here means a physical slave linked by pairing code (no IP typed).
  const [hardware, setHardware] = useState(false)

  const isShelf = draft.nodeType === "shelf"
  const isManual = draft.nodeType === "shelf" || draft.nodeType === "library"
  const reset = () => {
    setOpen(false)
    setDraft(makeDraft("paternoster"))
    setHardware(false)
  }

  const canAdd = draft.name.trim().length > 0

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add hardware unit
      </Button>
    )
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-background/50 p-3">
      <StorageLayoutEditor draft={draft} onChange={setDraft} />

      {!isManual && (
        <div>
          <p className="mb-1.5 text-sm font-medium text-muted-foreground">Controller</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setHardware(false)}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                !hardware
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background/50 text-muted-foreground hover:border-primary/50",
              )}
            >
              <Cpu className="h-4 w-4" /> Simulated
            </button>
            <button
              type="button"
              onClick={() => setHardware(true)}
              className={cn(
                "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                hardware
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-background/50 text-muted-foreground hover:border-primary/50",
              )}
            >
              <Radio className="h-4 w-4" /> Real Pi
            </button>
          </div>
          {hardware && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-muted/20 p-3">
              <LinkIcon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Added unpowered for now. When your Pi is assembled, tap{" "}
                <span className="font-medium text-foreground">Link</span> → <span className="font-medium text-foreground">Real Pi</span>{" "}
                and enter its <span className="font-mono">.local</span> name to drive the real carousel. No hardware yet?
                The Simulated tab links a mock unit for testing.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="ghost" onClick={reset}>
          Cancel
        </Button>
        <Button
          disabled={!canAdd}
          onClick={() => {
            const { storage, shelfMeta } = draftToConfig(draft)
            dispatch({
              type: "ADD_NODE",
              name: draft.name.trim(),
              nodeType: draft.nodeType,
              system: "hardware",
              area: draft.area.trim() || undefined,
              storage,
              shelfMeta,
              // A real slave runs on the simulated driver (mock link) and is
              // linked by pairing code rather than a hand-typed IP.
              driver: "simulated",
              pair: !isManual && hardware,
            })
            reset()
          }}
        >
          <Plus className="h-4 w-4" />{" "}
          {draft.nodeType === "library" ? "Add library" : isShelf ? "Add shelf storage" : "Add paternoster"}
        </Button>
      </div>
    </div>
  )
}

function CategoryManager() {
  const { state, dispatch } = useStore()
  const categories = state.settings.hardwareCategories ?? []
  const [name, setName] = useState("")

  const add = () => {
    if (!name.trim()) return
    dispatch({ type: "ADD_HW_CATEGORY", category: { id: newId("hwcat"), name: name.trim() } })
    setName("")
  }

  return (
    <div className="space-y-3">
      {categories.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <li
              key={c.id}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/60 py-1.5 pl-3 pr-1.5 text-sm text-foreground"
            >
              {c.name}
              <button
                type="button"
                onClick={() => dispatch({ type: "REMOVE_HW_CATEGORY", id: c.id })}
                aria-label={`Remove ${c.name}`}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Bolts"
          aria-label="New category name"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) add()
          }}
        />
        <Button onClick={add} disabled={!name.trim()} className="shrink-0">
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
    </div>
  )
}

function ColorManager() {
  const { state, dispatch } = useStore()
  const presets = state.settings.hardwareColorPresets ?? []
  const [name, setName] = useState("")
  const [hex, setHex] = useState("#ef4444")

  const add = () => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return
    dispatch({ type: "ADD_HW_COLOR", color: { name: name.trim() || hex, hex } })
    setName("")
  }

  return (
    <div className="space-y-3">
      {/* Built-in swatches for quick reference. */}
      <div className="flex flex-wrap gap-2">
        {HARDWARE_COLORS.map((c) => (
          <span
            key={c.hex}
            className="h-7 w-7 rounded-md border border-border"
            style={{ backgroundColor: c.hex }}
            title={c.name}
          />
        ))}
      </div>

      {presets.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {presets.map((c) => (
            <li
              key={c.hex}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/60 py-1.5 pl-2 pr-1.5 text-sm text-foreground"
            >
              <span className="h-4 w-4 rounded border border-border" style={{ backgroundColor: c.hex }} />
              {c.name}
              <button
                type="button"
                onClick={() => dispatch({ type: "REMOVE_HW_COLOR", hex: c.hex })}
                aria-label={`Remove ${c.name}`}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <input
          type="color"
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          aria-label="Custom color"
          className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-border bg-background"
        />
        <Field label="Name" className="flex-1">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Steel Blue" aria-label="Color name" />
        </Field>
        <Button onClick={add} className="shrink-0">
          <Plus className="h-4 w-4" /> Save
        </Button>
      </div>
    </div>
  )
}

function Section({
  icon,
  title,
  danger,
  children,
}: {
  icon: React.ReactNode
  title: string
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        "space-y-3 rounded-2xl border p-4",
        danger ? "border-destructive/40 bg-destructive/5" : "border-border bg-panel",
      )}
    >
      <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-background/50 p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-lg font-semibold text-foreground">{value}</dd>
    </div>
  )
}
