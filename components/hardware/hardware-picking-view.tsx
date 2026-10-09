"use client"

import { useMemo, useState } from "react"
import {
  ClipboardList,
  Plus,
  Search,
  Trash2,
  X,
  Check,
  Minus,
  PlayCircle,
  MapPin,
  CheckCircle2,
  Pencil,
  ChevronLeft,
} from "lucide-react"
import { useStore } from "@/lib/store"
import { newId } from "@/lib/filament"
import { storedParts, searchParts, type StoredPart } from "@/lib/selectors"
import { pickFromList } from "@/lib/hardware-flow"
import type { PickList, PickListLine } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "../ui/button"
import { Input } from "../ui/field"
import { PartThumb } from "./part-box"

/** Rows still needing pieces, and the overall progress of a list. */
function listProgress(list: PickList) {
  const requested = list.lines.reduce((s, ln) => s + ln.requested, 0)
  const picked = list.lines.reduce((s, ln) => s + Math.min(ln.picked, ln.requested), 0)
  const open = list.lines.filter((ln) => ln.picked < ln.requested)
  return { requested, picked, open, done: list.lines.length > 0 && open.length === 0 }
}

/**
 * Hardware picking lists: build a named list from the parts search, tick the
 * rows to pick, and run them as one carousel job. Each stop records what was
 * really taken, so the list shows picked vs. left and survives until deleted.
 */
export function HardwarePickingView({ onGoHome }: { onGoHome?: () => void } = {}) {
  const { state, dispatch } = useStore()
  const lists = state.hwPickLists ?? []
  const [openId, setOpenId] = useState<string | null>(null)
  const open = lists.find((l) => l.id === openId) ?? null

  function createList() {
    const list: PickList = {
      id: newId("picklist"),
      name: `Picking list ${lists.length + 1}`,
      lines: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    dispatch({ type: "PICKLIST_UPSERT", list })
    setOpenId(list.id)
  }

  if (open) {
    return (
      <PickListEditor
        list={open}
        onBack={() => setOpenId(null)}
        onStarted={() => {
          setOpenId(null)
          onGoHome?.()
        }}
      />
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-balance text-2xl font-semibold text-foreground">Picking lists</h1>
          <p className="mt-1 text-pretty text-sm text-muted-foreground">
            Collect the parts you need for a job, then let the carousel bring each box to you. Lists stay here until
            everything is picked or you delete them.
          </p>
        </div>
        <Button onClick={createList}>
          <Plus className="h-4 w-4" /> New list
        </Button>
      </header>

      {lists.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-background/40 px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground" aria-hidden>
            <ClipboardList className="h-6 w-6" />
          </span>
          <p className="text-sm text-muted-foreground text-pretty">
            No picking lists yet. Create one and search for the parts to add.
          </p>
          <Button variant="outline" onClick={createList}>
            <Plus className="h-4 w-4" /> Create a list
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {[...lists]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((list) => {
              const p = listProgress(list)
              return (
                <li key={list.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(list.id)}
                    className="flex w-full items-center gap-4 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/40"
                  >
                    <span
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                        p.done ? "bg-success/15 text-success" : "bg-primary/10 text-primary",
                      )}
                      aria-hidden
                    >
                      {p.done ? <CheckCircle2 className="h-5 w-5" /> : <ClipboardList className="h-5 w-5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">{list.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {list.lines.length} {list.lines.length === 1 ? "part" : "parts"} ·{" "}
                        {p.done ? "everything picked" : `${p.open.length} left to pick`}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-sm text-foreground">
                      {p.picked} / {p.requested}
                    </span>
                  </button>
                </li>
              )
            })}
        </ul>
      )}
    </div>
  )
}

function PickListEditor({
  list,
  onBack,
  onStarted,
}: {
  list: PickList
  onBack: () => void
  onStarted: () => void
}) {
  const { state, dispatch } = useStore()
  const [query, setQuery] = useState("")
  const [qtyByPart, setQtyByPart] = useState<Record<string, string>>({})
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(list.name)
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(list.lines.filter((ln) => ln.picked < ln.requested).map((ln) => ln.id)),
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  const entries = useMemo(() => storedParts(state), [state])
  const results = useMemo(
    () => (query.trim() ? searchParts(entries, query).slice(0, 12) : []),
    [entries, query],
  )
  const progress = listProgress(list)
  const busy = !!state.job

  function save(next: PickList) {
    dispatch({ type: "PICKLIST_UPSERT", list: next })
  }

  function addLine(entry: StoredPart) {
    const qty = Math.max(1, Math.floor(Number.parseInt(qtyByPart[entry.part.id] ?? "1") || 1))
    const existing = list.lines.find((ln) => ln.partId === entry.part.id)
    let lines: PickListLine[]
    let lineId: string
    if (existing) {
      lineId = existing.id
      lines = list.lines.map((ln) => (ln.id === existing.id ? { ...ln, requested: ln.requested + qty } : ln))
    } else {
      lineId = newId("pickline")
      lines = [...list.lines, { id: lineId, partId: entry.part.id, name: entry.part.name, requested: qty, picked: 0 }]
    }
    save({ ...list, lines })
    setChecked((s) => new Set(s).add(lineId))
    setQtyByPart((m) => ({ ...m, [entry.part.id]: "1" }))
  }

  function setRequested(line: PickListLine, requested: number) {
    const r = Math.max(1, Math.floor(requested))
    save({ ...list, lines: list.lines.map((ln) => (ln.id === line.id ? { ...ln, requested: r } : ln)) })
  }

  function removeLine(line: PickListLine) {
    save({ ...list, lines: list.lines.filter((ln) => ln.id !== line.id) })
    setChecked((s) => {
      const n = new Set(s)
      n.delete(line.id)
      return n
    })
  }

  function toggle(lineId: string) {
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(lineId)) n.delete(lineId)
      else n.add(lineId)
      return n
    })
  }

  function commitName() {
    const name = nameDraft.trim() || list.name
    if (name !== list.name) save({ ...list, name })
    setNameDraft(name)
    setEditingName(false)
  }

  function startPicking() {
    const ids = list.lines.filter((ln) => checked.has(ln.id) && ln.picked < ln.requested).map((ln) => ln.id)
    const ok = pickFromList(state, dispatch, list, ids)
    if (!ok) {
      setStartError("None of the ticked parts are in storage right now.")
      return
    }
    setStartError(null)
    onStarted()
  }

  const pickable = list.lines.filter((ln) => checked.has(ln.id) && ln.picked < ln.requested)

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> All lists
      </button>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editingName ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                commitName()
              }}
            >
              <Input
                value={nameDraft}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                aria-label="List name"
                className="max-w-sm text-lg font-semibold"
              />
              <Button type="submit" size="sm" variant="outline" aria-label="Save name">
                <Check className="h-4 w-4" />
              </Button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setEditingName(true)}
              className="group inline-flex max-w-full items-center gap-2 text-left"
              aria-label="Rename list"
            >
              <h1 className="truncate text-balance text-2xl font-semibold text-foreground">{list.name}</h1>
              <Pencil className="h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )}
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {progress.picked} / {progress.requested} pcs picked
            {progress.done ? " · complete" : progress.open.length > 0 ? ` · ${progress.open.length} rows left` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {confirmDelete ? (
            <>
              <span className="text-xs text-muted-foreground">Delete this list?</span>
              <Button size="sm" variant="danger" onClick={() => dispatch({ type: "PICKLIST_DELETE", id: list.id })}>
                Delete
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" /> Delete list
            </Button>
          )}
        </div>
      </header>

      {progress.done && (
        <div className="mb-5 flex items-center gap-3 rounded-xl border border-success/40 bg-success/10 px-4 py-3 text-sm text-foreground">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden />
          Everything on this list has been picked.
        </div>
      )}

      {/* Search & add */}
      <section className="mb-6 rounded-2xl border border-border bg-card p-4">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search parts to add by name, category, tag or location…"
            className="pl-9 pr-9"
            aria-label="Search parts to add"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </label>

        {query.trim() && (
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {results.length === 0 && (
              <li className="py-4 text-center text-sm text-muted-foreground">No parts in storage match.</li>
            )}
            {results.map((entry) => {
              const onList = list.lines.find((ln) => ln.partId === entry.part.id)
              return (
                <li key={entry.part.id} className="flex items-center gap-3 py-2.5">
                  <PartThumb color={entry.part.color} imageUrl={entry.part.imageUrl} name={entry.part.name} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{entry.part.name}</p>
                    <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                      {entry.nodeName} · {entry.shelfName} · Slot {entry.loc.slot + 1} ·{" "}
                      <span className="font-mono">{entry.part.count} pcs</span>
                      {onList && <span className="text-primary"> · on list ({onList.requested})</span>}
                    </p>
                  </div>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={qtyByPart[entry.part.id] ?? "1"}
                    onChange={(e) => setQtyByPart((m) => ({ ...m, [entry.part.id]: e.target.value }))}
                    aria-label={`Quantity of ${entry.part.name}`}
                    className="w-20 text-center"
                  />
                  <Button size="sm" onClick={() => addLine(entry)}>
                    <Plus className="h-4 w-4" /> Add to list
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Lines */}
      {list.lines.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground text-pretty">
          The list is empty. Search above and press &ldquo;Add to list&rdquo;.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.lines.map((line) => {
            const part = state.parts[line.partId]
            const entry = entries.find((e) => e.part.id === line.partId)
            const left = Math.max(0, line.requested - line.picked)
            const done = left === 0
            const isChecked = checked.has(line.id) && !done
            return (
              <li
                key={line.id}
                className={cn(
                  "flex items-center gap-3 rounded-xl border bg-card px-3 py-3",
                  done ? "border-success/30 opacity-80" : isChecked ? "border-primary/40" : "border-border",
                )}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isChecked}
                  disabled={done}
                  onClick={() => toggle(line.id)}
                  aria-label={`Pick ${line.name}`}
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-md border transition-colors",
                    done
                      ? "border-success bg-success text-background"
                      : isChecked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:border-primary/50",
                  )}
                >
                  {(isChecked || done) && <Check className="h-4 w-4" strokeWidth={3} />}
                </button>
                {part ? <PartThumb color={part.color} imageUrl={part.imageUrl} name={part.name} size={40} /> : <span className="h-10 w-10 rounded-lg bg-muted" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{part?.name ?? line.name}</p>
                  <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                    {entry ? (
                      <>
                        <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                        {entry.nodeName} · {entry.shelfName} · Slot {entry.loc.slot + 1} ·{" "}
                        <span className="font-mono">{part?.count ?? 0} in stock</span>
                      </>
                    ) : (
                      <span className="text-warning">Not in storage</span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setRequested(line, line.requested - 1)}
                      disabled={line.requested <= 1 || done}
                      className="rounded-md border border-border p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                      aria-label="Decrease quantity"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={line.requested}
                      onChange={(e) => setRequested(line, Number.parseInt(e.target.value) || 1)}
                      aria-label={`Quantity of ${line.name}`}
                      className="h-8 w-16 text-center"
                    />
                    <button
                      type="button"
                      onClick={() => setRequested(line, line.requested + 1)}
                      className="rounded-md border border-border p-1 text-muted-foreground hover:text-foreground"
                      aria-label="Increase quantity"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className={cn("font-mono text-[11px]", done ? "text-success" : "text-muted-foreground")}>
                    {done ? `picked ${line.picked}` : `${line.picked} picked · ${left} left`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeLine(line)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={`Remove ${line.name} from list`}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Actions */}
      {list.lines.length > 0 && !progress.done && (
        <div className="sticky bottom-2 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur">
          <p className="text-xs text-muted-foreground">
            {pickable.length} of {progress.open.length} open rows ticked · list is saved automatically
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onBack}>
              Save &amp; close
            </Button>
            <Button onClick={startPicking} disabled={pickable.length === 0 || busy}>
              <PlayCircle className="h-4 w-4" /> Begin picking
            </Button>
          </div>
          {busy && <p className="w-full text-xs text-warning">An operation is already running — finish it first.</p>}
          {startError && <p className="w-full text-xs text-warning">{startError}</p>}
        </div>
      )}
    </div>
  )
}
