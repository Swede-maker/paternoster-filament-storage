"use client"

import { useState } from "react"
import {
  ShieldCheck,
  Network,
  Server,
  Package,
  Library,
  Plus,
  Radio,
  RotateCcw,
  Save,
  TriangleAlert,
  Cpu,
  Tags,
  MapPin,
  Pencil,
  Box,
  X,
  Layers,
  Sun,
  Moon,
  Barcode as BarcodeIcon,
} from "lucide-react"
import { useStore } from "@/lib/store"
import { useTheme } from "@/lib/use-theme"
import { cn } from "@/lib/utils"
import { getStats, nodeSlotCount } from "@/lib/selectors"
import { newId, formatGrams } from "@/lib/filament"
import type { Container, StorageNode } from "@/lib/types"
import { Button } from "./ui/button"
import { Field, Input, Select, Checkbox } from "./ui/field"
import { SpoolDisc } from "./spool"
import { BarcodeScanner } from "./barcode-scanner"
import {
  draftFromNode,
  draftToConfig,
  makeDraft,
  StorageLayoutEditor,
  type StorageDraft,
} from "./storage-layout-editor"

export function SettingsView() {
  const { state, dispatch } = useStore()
  const stats = getStats(state)

  const [name, setName] = useState(state.settings.systemName)
  const [weight, setWeight] = useState(state.settings.defaultSpoolWeight)

  const nameDirty = name !== state.settings.systemName
  const weightDirty = weight !== state.settings.defaultSpoolWeight

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 overflow-y-auto p-4 scrollbar-thin">
      <h1 className="text-xl font-bold">Settings</h1>

      {/* Safety */}
      <Section icon={<ShieldCheck className="h-5 w-5 text-primary" />} title="Safety">
        <Checkbox
          checked={state.settings.confirmBeforeMove}
          onChange={(v) => dispatch({ type: "UPDATE_SETTINGS", settings: { confirmBeforeMove: v } })}
          label="Confirm before every movement"
          description="When on, the machine waits for a 'Confirm & rotate' tap before the carousel moves during a job. Turn off to let it move automatically."
        />
      </Section>

      {/* Appearance */}
      <Section icon={<Sun className="h-5 w-5 text-primary" />} title="Appearance">
        <ThemeToggle />
      </Section>

      {/* General */}
      <Section icon={<Cpu className="h-5 w-5 text-primary" />} title="General">
        <Field label="System name">
          <div className="flex gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
            <Button
              disabled={!nameDirty || !name.trim()}
              onClick={() => dispatch({ type: "UPDATE_SETTINGS", settings: { systemName: name.trim() } })}
            >
              <Save className="h-4 w-4" /> Save
            </Button>
          </div>
        </Field>

        <Field label="Default full-spool weight (g)">
          <div className="flex gap-2">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={5000}
              value={weight}
              onChange={(e) => setWeight(Math.max(0, Number.parseInt(e.target.value) || 0))}
            />
            <Button
              disabled={!weightDirty}
              onClick={() => dispatch({ type: "UPDATE_SETTINGS", settings: { defaultSpoolWeight: weight } })}
            >
              <Save className="h-4 w-4" /> Save
            </Button>
          </div>
        </Field>

        <Field label="Default filament diameter">
          <Select
            value={String(state.settings.defaultDiameter ?? 1.75)}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_SETTINGS",
                settings: { defaultDiameter: Number.parseFloat(e.target.value) || 1.75 },
              })
            }
            aria-label="Default filament diameter"
          >
            <option value="1.75">1.75 mm (standard)</option>
            <option value="2.85">2.85 mm</option>
            <option value="3">3.0 mm</option>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">
            Pre-selected on new spools and used to convert print length into grams consumed.
          </p>
        </Field>
      </Section>

      {/* Filament presets */}
      <Section icon={<Tags className="h-5 w-5 text-primary" />} title="Filament presets">
        <p className="text-sm text-muted-foreground">
          Names you save while adding filament show up here. Remove the ones you no longer need. Built-in types and
          brands can&apos;t be deleted.
        </p>
        <PresetList
          label="Custom materials / types"
          values={state.settings.customMaterials ?? []}
          onRemove={(v) => dispatch({ type: "REMOVE_PRESET", kind: "material", value: v })}
        />
        <PresetList
          label="Custom brands"
          values={state.settings.customBrands ?? []}
          onRemove={(v) => dispatch({ type: "REMOVE_PRESET", kind: "brand", value: v })}
        />
      </Section>

      {/* Filament profiles + barcode mappings */}
      <Section icon={<Layers className="h-5 w-5 text-primary" />} title="Profiles & barcodes">
        <p className="text-sm text-muted-foreground">
          Profiles are reusable filament presets — save one from the &ldquo;Add filament&rdquo; form, then apply it in a
          tap. Link a barcode to a profile so scanning a spool auto-fills everything.
        </p>
        <ProfileManager />
        <BarcodeManager />
      </Section>

      {/* Storage containers / dry boxes */}
      <Section icon={<Box className="h-5 w-5 text-primary" />} title="Storage containers">
        <p className="text-sm text-muted-foreground">
          Set up dry boxes or containers and their empty weight. When you store a spool you can mark that it sits in one
          of these, and the system adds the container&apos;s weight when balancing the carousel.
        </p>
        <ContainerManager />
      </Section>

      {/* Storage units (nodes) */}
      <Section icon={<Network className="h-5 w-5 text-primary" />} title="Storage units">
        <p className="text-sm text-muted-foreground">
          Add as many storage units as you like — each becomes its own tab on the Home screen. A{" "}
          <span className="font-medium text-foreground">shelf</span> is plain manual storage; a{" "}
          <span className="font-medium text-foreground">paternoster</span> is an automated carousel driven by its own
          Raspberry Pi (one Pi per paternoster).
        </p>
        <NodeList />
        <AddNodeRow />
        <dl className="grid grid-cols-3 gap-3 text-center">
          <Stat label="Units" value={state.nodes.length} />
          <Stat label="Total slots" value={stats.totalSlots} />
          <Stat label="Printers" value={state.printers.length} />
        </dl>
      </Section>

      {/* Danger zone */}
      <Section icon={<TriangleAlert className="h-5 w-5 text-destructive" />} title="Danger zone" danger>
        <p className="text-sm text-muted-foreground">
          Reset everything — machine layout, printers, and all stored filament. This cannot be undone.
        </p>
        <Button
          variant="destructive"
          onClick={() => {
            if (confirm("Reset the entire system? All spools, printers and layout will be erased.")) {
              dispatch({ type: "RESET_ALL" })
            }
          }}
        >
          <RotateCcw className="h-4 w-4" /> Reset system
        </Button>
      </Section>
    </div>
  )
}

/**
 * Light/dark slider. Per-device (localStorage), so each screen keeps its own
 * look. The track itself is the control — tap or click anywhere to flip.
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
  // Simulated nodes are always "online". Hardware reflects the real socket.
  const link = node.driver === "hardware" ? node.link : "online"
  const map = {
    online: { dot: "bg-success", text: "text-success", label: "online" },
    checking: { dot: "bg-warning animate-pulse", text: "text-warning", label: "connecting" },
    offline: { dot: "bg-destructive", text: "text-destructive", label: "offline" },
  } as const
  const s = map[link]
  return (
    <span className={`flex items-center gap-1 text-[10px] ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} /> {s.label}
    </span>
  )
}

/** Lists every storage unit with its type, location, link state and slot count. */
function NodeList() {
  const { state, dispatch } = useStore()
  const canRemove = state.nodes.length > 1
  const [editingId, setEditingId] = useState<string | null>(null)

  return (
    <ul className="space-y-2">
      {state.nodes.map((node) => {
        const nodeType = node.type ?? "paternoster"
        const isShelf = nodeType === "shelf"
        const isLibrary = nodeType === "library"
        // Manual units (shelf + library) have no controller, role, driver or
        // hardware endpoint, so all carousel-only chrome is hidden for them.
        const isManual = isShelf || isLibrary
        const isMaster = node.role === "master"
        const isActive = node.id === state.activeNodeId
        const total = nodeSlotCount(node)
        // Count only slots that resolve to a spool that still exists — the same
        // occupancy definition the Library view uses. The raw slot array keeps
        // its (now-empty) entries after a delete, so its length would report a
        // stale count (the "still says 5 spools after deleting them" bug).
        const librarySpools = (node.slots[0] ?? []).filter((id) => id && state.spools[id]).length
        return (
          <li
            key={node.id}
            className={
              "rounded-xl border p-3 " +
              (isActive ? "border-primary/60 bg-primary/5" : "border-border bg-background/50")
            }
          >
            <div className="flex items-center gap-3">
              <span
                className={
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg " +
                  (isActive ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")
                }
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
                        className={
                          "rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
                          (isMaster ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")
                        }
                      >
                        {node.role}
                      </span>
                      <span
                        className={
                          "rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
                          (node.driver === "hardware"
                            ? "bg-accent/15 text-accent-foreground"
                            : "bg-muted text-muted-foreground")
                        }
                      >
                        {node.driver === "hardware" ? "hardware" : "simulated"}
                      </span>
                      <LinkChip node={node} />
                    </>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {node.area && (
                    <span className="mr-1 inline-flex items-center gap-0.5 align-middle">
                      <MapPin className="h-3 w-3" /> {node.area} ·
                    </span>
                  )}
                  {!isManual && (
                    <span className="font-mono">
                      {node.driver === "hardware" ? `${node.ip}:${node.port}` : node.ip} ·{" "}
                    </span>
                  )}
                  <span className="font-mono">
                    {isLibrary
                      ? `${librarySpools} ${librarySpools === 1 ? "spool" : "spools"}`
                      : `${node.slots.length} shelves · ${total} slots`}
                  </span>
                </p>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              {!isActive && (
                <Button variant="outline" size="sm" onClick={() => dispatch({ type: "SET_ACTIVE_NODE", id: node.id })}>
                  View
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditingId(editingId === node.id ? null : node.id)}
              >
                <Pencil className="h-4 w-4" /> {editingId === node.id ? "Close" : "Edit layout"}
              </Button>
              {!isManual && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    dispatch({
                      type: "UPDATE_NODE",
                      id: node.id,
                      changes: { driver: node.driver === "hardware" ? "simulated" : "hardware" },
                    })
                  }
                >
                  {node.driver === "hardware" ? (
                    <>
                      <Cpu className="h-4 w-4" /> Use simulation
                    </>
                  ) : (
                    <>
                      <Radio className="h-4 w-4" /> Connect real Pi
                    </>
                  )}
                </Button>
              )}
              {!isManual && !isMaster && (
                <Button variant="outline" size="sm" onClick={() => dispatch({ type: "SET_MASTER", id: node.id })}>
                  Make master
                </Button>
              )}
              {canRemove && !isMaster && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Remove ${node.name}? Spools stored on it will be removed.`)) {
                      dispatch({ type: "REMOVE_NODE", id: node.id })
                    }
                  }}
                >
                  <X className="h-4 w-4" /> Remove
                </Button>
              )}
            </div>

            {editingId === node.id && (
              <NodeLayoutEditor node={node} onDone={() => setEditingId(null)} />
            )}

            {!isManual && node.driver === "hardware" && <NodeEndpointEditor node={node} />}
          </li>
        )
      })}
    </ul>
  )
}

/** Inline editor to rename / relocate / reshape an existing storage unit. */
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
          : "Edit layout — removing shelves or slots discards any spools stored there."}
      </p>
      {/* Type is fixed once created; a paternoster can't become a shelf. */}
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

/** Inline editor for a hardware node's Pi address + agent port. */
function NodeEndpointEditor({ node }: { node: StorageNode }) {
  const { dispatch } = useStore()
  const [ip, setIp] = useState(node.ip)
  const [port, setPort] = useState(node.port)
  const ipValid = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip.trim()) || /^[a-z0-9.-]+\.local$/i.test(ip.trim())
  const dirty = ip.trim() !== node.ip || port !== node.port

  return (
    <div className="mt-3 rounded-lg border border-border/70 bg-muted/30 p-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">Pi agent connection</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          className="sm:flex-1"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="192.168.1.42"
          aria-label="Pi IP address"
        />
        <Input
          className="sm:w-28"
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(Math.max(1, Math.min(65535, Number.parseInt(e.target.value) || 8765)))}
          aria-label="Agent port"
        />
        {dirty ? (
          <Button
            size="sm"
            disabled={!ipValid}
            onClick={() => dispatch({ type: "UPDATE_NODE", id: node.id, changes: { ip: ip.trim(), port } })}
          >
            Save & reconnect
          </Button>
        ) : (
          // No pending edits — offer a plain retry that reopens the socket
          // without needing to change (and change back) the IP/port.
          <Button size="sm" variant="secondary" onClick={() => dispatch({ type: "RECONNECT_NODE", id: node.id })}>
            <RotateCcw className="h-4 w-4" /> Reconnect
          </Button>
        )}
      </div>
      {/* Live link state so the retry gives visible feedback. */}
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            node.link === "online" ? "bg-success" : node.link === "checking" ? "bg-warning" : "bg-destructive",
          )}
        />
        {node.link === "online"
          ? "Connected to Pi agent"
          : node.link === "checking"
            ? "Connecting…"
            : "Offline — check the Pi agent is running, then Reconnect."}
      </p>
      {ip && !ipValid && <p className="mt-1 text-xs text-destructive">Enter an IPv4 address or a *.local hostname.</p>}
    </div>
  )
}

/** Add a new storage unit — a manual shelf or an automated paternoster. */
function AddNodeRow() {
  const { dispatch } = useStore()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<StorageDraft>(() => makeDraft("paternoster"))
  const [hardware, setHardware] = useState(false)
  const [ip, setIp] = useState("")
  const [port, setPort] = useState(8765)
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

  const isShelf = draft.nodeType === "shelf"
  // Shelf and library units have no controller/hardware — only a paternoster does.
  const isManual = draft.nodeType === "shelf" || draft.nodeType === "library"
  const reset = () => {
    setOpen(false)
    setDraft(makeDraft("paternoster"))
    setHardware(false)
    setIp("")
    setPort(8765)
  }

  const ipValid = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip.trim()) || /^[a-z0-9.-]+\.local$/i.test(ip.trim())
  // Manual units have no controller, so IP validity only matters for a
  // hardware paternoster. Simulated paternosters get an auto-assigned address.
  const canAdd = draft.name.trim().length > 0 && (isManual || !hardware || ipValid)

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add storage unit
      </Button>
    )
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-background/50 p-3">
      <StorageLayoutEditor draft={draft} onChange={setDraft} />

      {/* Controller settings only apply to the automated paternoster. */}
      {!isManual && (
        <>
          <div>
            <p className="mb-1.5 text-sm font-medium text-muted-foreground">Controller</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setHardware(false)}
                className={
                  "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors " +
                  (!hardware
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-background/50 text-muted-foreground hover:border-primary/50")
                }
              >
                <Cpu className="h-4 w-4" /> Simulated
              </button>
              <button
                type="button"
                onClick={() => setHardware(true)}
                className={
                  "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors " +
                  (hardware
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-background/50 text-muted-foreground hover:border-primary/50")
                }
              >
                <Radio className="h-4 w-4" /> Real Pi
              </button>
            </div>
          </div>

          {hardware && (
            <>
              <Field label="Pi IP address / hostname">
                <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.1.42" />
                {ip && !ipValid && (
                  <p className="mt-1 text-xs text-destructive">Enter an IPv4 address or a *.local hostname.</p>
                )}
              </Field>
              <Field label="Agent WebSocket port">
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(clamp(Number.parseInt(e.target.value) || 8765, 1, 65535))}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Each paternoster needs its own Pi — this address must be unique. Default agent port is 8765.
                </p>
              </Field>
            </>
          )}
        </>
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
              area: draft.area.trim() || undefined,
              storage,
              shelfMeta,
              ip: !isManual && hardware ? ip.trim() : undefined,
              driver: !isManual && hardware ? "hardware" : "simulated",
              port: !isManual && hardware ? port : undefined,
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

/**
 * Manage storage containers / dry boxes: list existing ones with their weight,
 * and add new ones. Container weight is factored into carousel balance when a
 * spool is marked as living in one. Persisted in `settings.containers`.
 */
function ContainerManager() {
  const { state, dispatch } = useStore()
  const containers = state.settings.containers ?? []
  const [name, setName] = useState("")
  const [weight, setWeight] = useState<number>(0)

  const nameValid = name.trim().length > 0
  const weightValid = weight > 0
  const duplicate = containers.some((c) => c.name.toLowerCase() === name.trim().toLowerCase())
  const canAdd = nameValid && weightValid && !duplicate

  const save = (next: Container[]) => dispatch({ type: "UPDATE_SETTINGS", settings: { containers: next } })

  const add = () => {
    if (!canAdd) return
    save([...containers, { id: newId("box"), name: name.trim(), weightGrams: Math.round(weight) }])
    setName("")
    setWeight(0)
  }

  return (
    <div className="space-y-3">
      {containers.length === 0 ? (
        <p className="text-sm text-muted-foreground/70">No containers yet. Add a dry box below.</p>
      ) : (
        <ul className="space-y-2">
          {containers.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-background/50 p-3"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
                <Box className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{c.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{formatGrams(c.weightGrams)} empty</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${c.name}`}
                onClick={() => save(containers.filter((x) => x.id !== c.id))}
              >
                <X className="h-4 w-4" /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-xl border border-border bg-background/50 p-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Field label="Container name" className="sm:flex-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Polymaker dry box"
              aria-label="Container name"
            />
          </Field>
          <Field label="Empty weight (g)" className="sm:w-40">
            <Input
              type="number"
              inputMode="numeric"
              min={0}
              max={10000}
              value={weight || ""}
              onChange={(e) => setWeight(Math.max(0, Number.parseInt(e.target.value) || 0))}
              placeholder="e.g. 850"
              aria-label="Container empty weight in grams"
            />
          </Field>
        </div>
        {duplicate && <p className="mt-1 text-xs text-warning">A container with that name already exists.</p>}
        <Button className="mt-2" disabled={!canAdd} onClick={add}>
          <Plus className="h-4 w-4" /> Add container
        </Button>
      </div>
    </div>
  )
}

/** Lists saved filament profiles with a color preview and a remove action. */
function ProfileManager() {
  const { state, dispatch } = useStore()
  const profiles = state.settings.filamentProfiles ?? []

  return (
    <div>
      <p className="mb-2 text-sm font-medium text-muted-foreground">Saved profiles</p>
      {profiles.length === 0 ? (
        <p className="text-sm text-muted-foreground/70">
          No profiles yet. Fill in the &ldquo;Add filament&rdquo; form and tap Save to create one.
        </p>
      ) : (
        <ul className="space-y-2">
          {profiles.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-background/50 p-3"
            >
              <SpoolDisc color={p.color} size={40} fill={1} boxed={!!p.containerId} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{p.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {p.material} · {p.brand} · {formatGrams(p.capacity)}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${p.name}`}
                onClick={() => dispatch({ type: "REMOVE_PROFILE", id: p.id })}
              >
                <X className="h-4 w-4" /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Map scanned/entered barcodes to saved profiles; scan-to-fill uses these. */
function BarcodeManager() {
  const { state, dispatch } = useStore()
  const profiles = state.settings.filamentProfiles ?? []
  const barcodes = state.settings.barcodes ?? []
  const [code, setCode] = useState("")
  const [profileId, setProfileId] = useState("")
  const [scannerOpen, setScannerOpen] = useState(false)

  const trimmed = code.trim()
  const canAdd = trimmed !== "" && profileId !== ""
  const nameFor = (id: string) => profiles.find((p) => p.id === id)?.name ?? "Unknown profile"

  function add() {
    if (!canAdd) return
    dispatch({ type: "ADD_BARCODE", code: trimmed, profileId })
    setCode("")
    setProfileId("")
  }

  return (
    <div className="space-y-3">
      <p className="mb-1 text-sm font-medium text-muted-foreground">Barcode links</p>
      {barcodes.length === 0 ? (
        <p className="text-sm text-muted-foreground/70">No barcodes linked yet.</p>
      ) : (
        <ul className="space-y-2">
          {barcodes.map((b) => (
            <li
              key={b.code}
              className="flex items-center gap-3 rounded-xl border border-border bg-background/50 p-3"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
                <BarcodeIcon className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm font-semibold text-foreground">{b.code}</p>
                <p className="truncate text-xs text-muted-foreground">→ {nameFor(b.profileId)}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove barcode ${b.code}`}
                onClick={() => dispatch({ type: "REMOVE_BARCODE", code: b.code })}
              >
                <X className="h-4 w-4" /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">Save a profile first, then link a barcode to it.</p>
      ) : (
        <div className="rounded-xl border border-border bg-background/50 p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Field label="Barcode" className="sm:flex-1">
              <div className="flex gap-2">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Scan or type a code"
                  spellCheck={false}
                  className="font-mono"
                  aria-label="Barcode value"
                />
                <Button variant="outline" onClick={() => setScannerOpen(true)} aria-label="Scan barcode">
                  <BarcodeIcon className="h-4 w-4" />
                </Button>
              </div>
            </Field>
            <Field label="Profile" className="sm:w-48">
              <Select value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="Profile to link">
                <option value="">Choose a profile…</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button className="mt-2" disabled={!canAdd} onClick={add}>
            <Plus className="h-4 w-4" /> Link barcode
          </Button>
        </div>
      )}

      <BarcodeScanner
        open={scannerOpen}
        title="Scan to link"
        description="Scan the spool barcode you want to map to a profile."
        onDetected={(c) => {
          setCode(c)
          setScannerOpen(false)
        }}
        onClose={() => setScannerOpen(false)}
      />
    </div>
  )
}

/** Lists user-saved presets as removable chips. */
function PresetList({
  label,
  values,
  onRemove,
}: {
  label: string
  values: string[]
  onRemove: (v: string) => void
}) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-muted-foreground">{label}</p>
      {values.length === 0 ? (
        <p className="text-sm text-muted-foreground/70">None saved yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {values.map((v) => (
            <li key={v}>
              <span className="flex items-center gap-1.5 rounded-lg border border-border bg-background/50 py-1 pl-3 pr-1.5 text-sm">
                <span className="text-foreground">{v}</span>
                <button
                  type="button"
                  aria-label={`Remove ${v}`}
                  onClick={() => onRemove(v)}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Section({
  icon,
  title,
  children,
  danger,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <section
      className={
        "space-y-4 rounded-2xl border p-4 " +
        (danger ? "border-destructive/40 bg-destructive/5" : "border-border bg-card")
      }
    >
      <h2 className="flex items-center gap-2 text-base font-semibold">
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
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-2xl font-bold text-primary">{value}</dd>
    </div>
  )
}
