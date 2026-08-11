"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Check, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "./ui/field"

/**
 * A text input paired with a scrollable dropdown of saved presets. The user can
 * type any value freely; if what they type isn't already a preset, a "Save"
 * action appears so it's remembered for next time.
 */
export function PresetCombobox({
  value,
  onChange,
  options,
  onSaveNew,
  placeholder,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  /** All selectable presets (built-in + custom), in display order. */
  options: string[]
  /** Called when the user saves a brand-new value that isn't in `options`. */
  onSaveNew: (v: string) => void
  placeholder?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  // Only narrow the list while the user is actively typing. Opening via the
  // chevron or focus shows every option, even when a value is already selected.
  const [filtering, setFiltering] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Close when clicking/tapping outside.
  useEffect(() => {
    if (!open) return
    function onDown(e: PointerEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [open])

  const trimmed = value.trim()
  const exists = useMemo(
    () => options.some((o) => o.toLowerCase() === trimmed.toLowerCase()),
    [options, trimmed],
  )

  // Filter suggestions by the current input (substring match), but only when
  // the user is actively typing. Otherwise show the full list.
  const filtered = useMemo(() => {
    const q = trimmed.toLowerCase()
    if (!filtering || !q) return options
    return options.filter((o) => o.toLowerCase().includes(q))
  }, [options, trimmed, filtering])

  const canSave = trimmed.length > 0 && !exists

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <Input
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setFiltering(true)
            if (!open) setOpen(true)
          }}
          onFocus={() => {
            setFiltering(false)
            setOpen(true)
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className="pr-10"
          autoComplete="off"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Show presets"
          onClick={() => {
            setFiltering(false)
            setOpen((o) => !o)
          }}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>

      {open && (
        <div className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl scrollbar-thin">
          {canSave && (
            <button
              type="button"
              onClick={() => {
                onSaveNew(trimmed)
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-primary hover:bg-primary/10"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="truncate">
                Save {"\u201C"}
                {trimmed}
                {"\u201D"}
              </span>
            </button>
          )}
          {filtered.length === 0 && !canSave ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">No matches.</p>
          ) : (
            filtered.map((opt) => {
              const selected = opt.toLowerCase() === trimmed.toLowerCase()
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => {
                    onChange(opt)
                    setOpen(false)
                  }}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-secondary/60",
                    selected ? "text-primary" : "text-foreground",
                  )}
                >
                  <span className="truncate">{opt}</span>
                  {selected && <Check className="h-4 w-4 shrink-0" />}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
