"use client"

import { useState } from "react"
import { Plus, X, Trash2, PackageOpen, ShoppingCart, ChevronDown, ExternalLink, Store, Pencil } from "lucide-react"
import { useStore } from "@/lib/store"
import { useFlow } from "./flow-controller"
import { newId, densityFor, formatGrams, DEFAULT_DIAMETER } from "@/lib/filament"
import type { FilamentOrder, OrderItem, OrderStore } from "@/lib/types"
import { SpoolDisc, discColor2 } from "./spool"
import { Button } from "./ui/button"
import { Field, Input } from "./ui/field"
import { SpoolForm, emptyDraft, type SpoolDraft } from "./spool-form"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "./ui/dialog"

/**
 * Best-effort normalise a user-typed shop URL so quick-launch always opens a
 * valid absolute link: add https:// when no scheme was given, and reject input
 * we can't turn into a URL.
 */
function normalizeStoreUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).toString()
  } catch {
    return null
  }
}

/** Open a saved store in a new tab (works from inside the v0 preview iframe too). */
function openStore(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
}

/** Convert a draft (create form) into an order line item. */
function draftToItem(draft: SpoolDraft): OrderItem {
  return {
    id: newId("item"),
    material: draft.material,
    brand: draft.brand,
    color: draft.color,
    color2: draft.dualColor ? draft.color2 : undefined,
    dualColor: draft.dualColor,
    colorName: draft.colorName,
    capacity: draft.capacity,
    nozzleTemp: draft.nozzleTemp,
    density: draft.density,
    diameter: draft.diameter,
    containerId: draft.containerId,
    quantity: Math.max(1, Math.round(draft.quantity ?? 1)),
  }
}

/** Convert an order line item back into a place-flow draft. */
function itemToDraft(item: OrderItem, fallbackDiameter: number): SpoolDraft {
  return {
    material: item.material,
    brand: item.brand,
    color: item.color,
    color2: item.color2,
    dualColor: item.dualColor,
    colorName: item.colorName,
    grams: item.capacity,
    capacity: item.capacity,
    nozzleTemp: item.nozzleTemp,
    density: item.density ?? densityFor(item.material),
    diameter: item.diameter ?? fallbackDiameter,
    containerId: item.containerId,
    quantity: item.quantity,
  }
}

/**
 * Incoming orders / shopping carts. Each cart groups filament you've ordered
 * (e.g. from Amazon); "Receive" queues every item into the place flow so the
 * carousel finds the best slots and you confirm the load.
 */
export function OrdersView() {
  const { state, dispatch } = useStore()
  const orders = state.settings.orders ?? []
  const [newCartName, setNewCartName] = useState("")

  function addCart() {
    const name = newCartName.trim() || `Cart ${orders.length + 1}`
    dispatch({ type: "ADD_ORDER", order: { id: newId("order"), name, createdAt: Date.now(), items: [] } })
    setNewCartName("")
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-balance text-2xl font-semibold text-foreground">Incoming orders</h1>
        <p className="mt-1 text-pretty text-sm text-muted-foreground">
          Build a cart of filament you&apos;ve ordered, then receive it straight into storage when the box arrives.
        </p>
      </header>

      <StoreLinks />

      <div className="mb-6 flex gap-2">
        <Input
          value={newCartName}
          onChange={(e) => setNewCartName(e.target.value)}
          placeholder="New cart name (e.g. Amazon)"
          aria-label="New cart name"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) addCart()
          }}
        />
        <Button onClick={addCart} className="shrink-0">
          <Plus className="h-4 w-4" /> New cart
        </Button>
      </div>

      {orders.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-background/40 px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground" aria-hidden>
            <ShoppingCart className="h-6 w-6" />
          </span>
          <p className="text-sm text-muted-foreground">No carts yet. Create one above to track an incoming order.</p>
        </div>
      ) : (
        <ul className="space-y-4">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </div>
  )
}

function OrderCard({ order }: { order: FilamentOrder }) {
  const { state, dispatch } = useStore()
  const { startPlace } = useFlow()
  const fallbackDiameter = state.settings.defaultDiameter ?? DEFAULT_DIAMETER
  const [addOpen, setAddOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [name, setName] = useState(order.name)
  const [collapsed, setCollapsed] = useState(false)

  const totalSpools = order.items.reduce((n, it) => n + Math.max(1, it.quantity), 0)

  function receive() {
    // Queue each item (respecting its quantity) into the place flow. Everything
    // defaults into the storage unit you're currently on (the active section),
    // and the queue tray lets you redirect any spool to another unit before you
    // press Start.
    for (const item of order.items) {
      startPlace(itemToDraft(item, fallbackDiameter), state.activeNodeId)
    }
    // Clear the cart once received so it isn't double-counted.
    dispatch({ type: "REMOVE_ORDER", id: order.id })
  }

  return (
    <li className="overflow-hidden rounded-2xl border border-border bg-background/50">
      <div className="flex items-center gap-2 border-b border-border p-4">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary"
          aria-label={collapsed ? "Expand cart" : "Collapse cart"}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
        </button>
        <div className="min-w-0 flex-1">
          {editingName ? (
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                dispatch({ type: "RENAME_ORDER", id: order.id, name })
                setEditingName(false)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  dispatch({ type: "RENAME_ORDER", id: order.id, name })
                  setEditingName(false)
                }
              }}
              aria-label="Cart name"
            />
          ) : (
            <button type="button" onClick={() => setEditingName(true)} className="block truncate text-left">
              <span className="text-base font-semibold text-foreground">{order.name}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {totalSpools} {totalSpools === 1 ? "spool" : "spools"}
              </span>
            </button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Delete ${order.name}`}
          onClick={() => dispatch({ type: "REMOVE_ORDER", id: order.id })}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {!collapsed && (
        <div className="p-4">
          {order.items.length === 0 ? (
            <p className="mb-4 text-sm text-muted-foreground/80">No items yet — add the filament you ordered.</p>
          ) : (
            <ul className="mb-4 space-y-2">
              {order.items.map((item) => (
                <li key={item.id} className="flex items-center gap-3 rounded-xl border border-border bg-background/60 p-3">
                  <SpoolDisc color={item.color} color2={discColor2(item)} size={40} fill={1} boxed={!!item.containerId} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.colorName || item.material}
                      {item.quantity > 1 && <span className="ml-1.5 text-primary">×{item.quantity}</span>}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {item.material} · {item.brand} · {formatGrams(item.capacity)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Remove item"
                    onClick={() => dispatch({ type: "REMOVE_ORDER_ITEM", orderId: order.id, itemId: item.id })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" /> Add item
            </Button>
            <Button onClick={receive} disabled={order.items.length === 0}>
              <PackageOpen className="h-4 w-4" /> Receive into storage
            </Button>
          </div>
        </div>
      )}

      <AddItemDialog orderId={order.id} open={addOpen} onClose={() => setAddOpen(false)} />
    </li>
  )
}

/**
 * Quick-launch strip of saved shops. Each button opens the store's site in a new
 * tab so you can reorder filament; a "Manage" button opens the editor for
 * adding, renaming, relinking, or removing stores.
 */
function StoreLinks() {
  const { state } = useStore()
  const stores = state.settings.stores ?? []
  const [manageOpen, setManageOpen] = useState(false)

  return (
    <section className="mb-6" aria-label="Saved stores">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Store className="h-4 w-4" /> Stores
        </h2>
        <Button variant="ghost" size="sm" onClick={() => setManageOpen(true)}>
          <Pencil className="h-3.5 w-3.5" /> Manage
        </Button>
      </div>

      {stores.length === 0 ? (
        <button
          type="button"
          onClick={() => setManageOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-background/40 px-4 py-4 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="h-4 w-4" /> Add a shop you order filament from
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          {stores.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => openStore(s.url)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/60 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/50 hover:bg-primary/5"
              title={s.url}
            >
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              {s.name}
            </button>
          ))}
        </div>
      )}

      <ManageStoresDialog open={manageOpen} onClose={() => setManageOpen(false)} />
    </section>
  )
}

function ManageStoresDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const stores = state.settings.stores ?? []
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [error, setError] = useState<string | null>(null)

  function addStore() {
    const normalized = normalizeStoreUrl(url)
    if (!name.trim()) {
      setError("Give the store a name.")
      return
    }
    if (!normalized) {
      setError("Enter a valid website address.")
      return
    }
    dispatch({ type: "ADD_STORE", store: { id: newId("store"), name: name.trim(), url: normalized } })
    setName("")
    setUrl("")
    setError(null)
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader
        icon={<Store className="h-5 w-5" />}
        title="Saved stores"
        description="Quick links to the shops you buy filament from."
      />
      <DialogBody>
        <div className="space-y-4">
          {stores.length > 0 && (
            <ul className="space-y-2">
              {stores.map((s) => (
                <StoreRow key={s.id} store={s} />
              ))}
            </ul>
          )}

          <div className="space-y-3 rounded-lg border border-border bg-background/40 p-3">
            <span className="text-sm font-medium text-foreground">Add a store</span>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Amazon"
                aria-label="Store name"
              />
            </Field>
            <Field label="Website">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="e.g. amazon.com"
                aria-label="Store URL"
                inputMode="url"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) addStore()
                }}
              />
            </Field>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <Button onClick={addStore} className="w-full">
              <Plus className="h-4 w-4" /> Add store
            </Button>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

/** A single saved store inside the manage dialog: inline rename + relink + delete. */
function StoreRow({ store }: { store: OrderStore }) {
  const { dispatch } = useStore()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(store.name)
  const [url, setUrl] = useState(store.url)
  const [error, setError] = useState<string | null>(null)

  function save() {
    const normalized = normalizeStoreUrl(url)
    if (!name.trim() || !normalized) {
      setError("Enter a name and a valid website.")
      return
    }
    dispatch({ type: "UPDATE_STORE", id: store.id, changes: { name: name.trim(), url: normalized } })
    setError(null)
    setEditing(false)
  }

  if (editing) {
    return (
      <li className="space-y-2 rounded-lg border border-primary/40 bg-background/60 p-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Store name" className="h-9" />
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="Store URL"
          inputMode="url"
          spellCheck={false}
          className="h-9"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save
          </Button>
        </div>
      </li>
    )
  }

  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-background/60 p-3">
      <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{store.name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{store.url}</p>
      </div>
      <button
        type="button"
        onClick={() => {
          setName(store.name)
          setUrl(store.url)
          setEditing(true)
        }}
        aria-label={`Edit ${store.name}`}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => dispatch({ type: "REMOVE_STORE", id: store.id })}
        aria-label={`Delete ${store.name}`}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  )
}

function AddItemDialog({ orderId, open, onClose }: { orderId: string; open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const [draft, setDraft] = useState<SpoolDraft>(
    emptyDraft(state.settings.defaultSpoolWeight, state.settings.defaultDiameter),
  )

  function submit() {
    dispatch({ type: "ADD_ORDER_ITEM", orderId, item: draftToItem(draft) })
    setDraft(emptyDraft(state.settings.defaultSpoolWeight, state.settings.defaultDiameter))
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add to cart" description="Add a filament to this incoming order.">
      <DialogBody>
        <SpoolForm value={draft} onChange={setDraft} showProfiles showQuantity showBarcode />
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit}>
          <Plus className="h-4 w-4" /> Add to cart
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
