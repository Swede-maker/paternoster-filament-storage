"use client"

import { useCallback, useState } from "react"

/**
 * Multi-select state for the manual storage views (shelf + library). Lets the
 * user flip a unit into "selection mode", tick several spools, then act on them
 * in bulk (queue them for retrieval or delete them) instead of opening the
 * single-spool action dialog one at a time.
 *
 * State is intentionally local to each view: selecting spools in the shelf unit
 * shouldn't carry over to the library, and leaving a view resets the selection.
 */
export function useSpoolSelection() {
  const [active, setActive] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** Enter selection mode, optionally seeding it with a first spool. */
  const enter = useCallback((seedId?: string) => {
    setActive(true)
    if (seedId) setSelected(new Set([seedId]))
  }, [])

  /** Leave selection mode and drop every tick. */
  const exit = useCallback(() => {
    setActive(false)
    setSelected(new Set())
  }, [])

  const selectAll = useCallback((ids: string[]) => setSelected(new Set(ids)), [])
  const clear = useCallback(() => setSelected(new Set()), [])

  return { active, selected, count: selected.size, toggle, enter, exit, selectAll, clear }
}
