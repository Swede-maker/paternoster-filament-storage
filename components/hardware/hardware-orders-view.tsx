"use client"

import { useState } from "react"
import { Plus, X, Trash2, PackageOpen, ShoppingCart, ChevronDown, ExternalLink, Store, Pencil } from "lucide-react"
import { useStore } from "@/lib/store"
import { newId } from "@/lib/filament"
import type { HardwareOrder, HardwareOrderItem, OrderStore } from "@/lib/types"
import { Button } from "../ui/button"
import { Field, Input } from "../ui/field"
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "../ui/dialog"

/**
 * Normalise a user-typed shop URL so quick-launch always opens a valid absolute
 * link: add https:// when no scheme was given, reject anything we can't parse.
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

function openStore(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
}

/**
 * Incoming hardware orders / carts. Each cart groups hardware you've ordered;
 * the items are qty-based (name + category + quantity). Received parts are then
 * added through the normal "add hardware" flow so weight/color/tags get set —
 * so here we just track what's on the way, mirroring the filament Orders tab
 * but without spool-specific fields (no printers in the hardware area).
 */
export function HardwareOrdersView() {
  const { state, dispatch } = useStore()
  const orders = state.hardwareOrders ?? []
  const [newCartName, setNewCartName] = useState("")

  function addCart() {
    const name = newCartName.trim() || `Cart ${orders.length + 1}`
    dispatch({ type: "ADD_HW_ORDER", order: { id: newId("hworder"), name, createdAt: Date.now(), items: [] } })
    setNewCartName("")
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-balance text-2xl font-semibold text-foreground">Incoming orders</h1>
        <p className="mt-1 text-pretty text-sm text-muted-foreground">
          Track hardware you&apos;ve ordered. When it arrives, add each part from Home so the carousel finds a slot by
          weight.
        </p>
      </header>

      <StoreLinks />

      <div className="mb-6 flex gap-2">
        <Input
          value={newCartName}
          onChange={(e) => setNewCartName(e.target.value)}
          placeholder="New cart name (e.g. McMaster)"
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
          <span
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"
            aria-hidden
          >
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

function OrderCard({ order }: { order: HardwareOrder }) {
  const { dispatch } = useStore()
  const [addOpen, setAddOpen] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [name, setName] = useState(order.name)
  const [collapsed, setCollapsed] = useState(false)

  const totalPieces = order.items.reduce((n, it) => n + Math.max(1, it.quantity), 0)

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
                dispatch({ type: "RENAME_HW_ORDER", id: order.id, name })
                setEditingName(false)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  dispatch({ type: "RENAME_HW_ORDER", id: order.id, name })
                  setEditingName(false)
                }
              }}
              aria-label="Cart name"
            />
          ) : (
            <button type="button" onClick={() => setEditingName(true)} className="block truncate text-left">
              <span className="text-base font-semibold text-foreground">{order.name}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                {totalPieces} {totalPieces === 1 ? "piece" : "pieces"}
              </span>
            </button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Delete ${order.name}`}
          onClick={() => dispatch({ type: "REMOVE_HW_ORDER", id: order.id })}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {!collapsed && (
        <div className="p-4">
          {order.items.length === 0 ? (
            <p className="mb-4 text-sm text-muted-foreground/80">No items yet — add the hardware you ordered.</p>
          ) : (
            <ul className="mb-4 space-y-2">
              {order.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 rounded-xl border border-border bg-background/60 p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.name}
                      {item.quantity > 1 && <span className="ml-1.5 text-primary">×{item.quantity}</span>}
                    </p>
                    {item.category && (
                      <p className="truncate font-mono text-xs text-muted-foreground">{item.category}</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Remove item"
                    onClick={() => dispatch({ type: "REMOVE_HW_ORDER_ITEM", orderId: order.id, itemId: item.id })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <Button variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" /> Add item
          </Button>
        </div>
      )}

      <AddItemDialog orderId={order.id} open={addOpen} onClose={() => setAddOpen(false)} />
    </li>
  )
}

function AddItemDialog({ orderId, open, onClose }: { orderId: string; open: boolean; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const categories = state.settings.hardwareCategories ?? []
  const [name, setName] = useState("")
  const [category, setCategory] = useState("")
  const [quantity, setQuantity] = useState(1)

  function submit() {
    if (!name.trim()) return
    dispatch({
      type: "ADD_HW_ORDER_ITEM",
      orderId,
      item: {
        id: newId("hwitem"),
        name: name.trim(),
        category: category.trim(),
        quantity: Math.max(1, Math.round(quantity)),
      } satisfies HardwareOrderItem,
    })
    setName("")
    setCategory("")
    setQuantity(1)
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="Add to cart" description="Add hardware to this incoming order.">
      <DialogBody>
        <div className="space-y-4">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. M5×40 socket screw"
              aria-label="Item name"
              autoFocus
            />
          </Field>
          <Field label="Category (optional)">
            <Input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Bolts"
              aria-label="Category"
              list="hw-order-categories"
            />
            <datalist id="hw-order-categories">
              {categories.map((c) => (
                <option key={c.id} value={c.name} />
              ))}
            </datalist>
          </Field>
          <Field label="Quantity">
            <Input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              aria-label="Quantity"
            />
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!name.trim()}>
          <Plus className="h-4 w-4" /> Add to cart
        </Button>
      </DialogFooter>
    </Dialog>
  )
}

/** Quick-launch strip of saved hardware shops (mirrors the filament Orders tab). */
function StoreLinks() {
  const { state } = useStore()
  const stores = state.settings.hardwareStores ?? []
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
          <Plus className="h-4 w-4" /> Add a shop you order hardware from
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
  const stores = state.settings.hardwareStores ?? []
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
    dispatch({ type: "ADD_HW_STORE", store: { id: newId("hwstore"), name: name.trim(), url: normalized } })
    setName("")
    setUrl("")
    setError(null)
  }

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader
        icon={<Store className="h-5 w-5" />}
        title="Saved stores"
        description="Quick links to the shops you buy hardware from."
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
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. McMaster" aria-label="Store name" />
            </Field>
            <Field label="Website">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="e.g. mcmaster.com"
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

function StoreRow({ store }: { store: OrderStore }) {
  const { dispatch } = useStore()

  return (
    <li className="flex items-center gap-2 rounded-lg border border-border bg-background/60 p-3">
      <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{store.name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{store.url}</p>
      </div>
      <button
        type="button"
        onClick={() => dispatch({ type: "REMOVE_HW_STORE", id: store.id })}
        aria-label={`Delete ${store.name}`}
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  )
}
