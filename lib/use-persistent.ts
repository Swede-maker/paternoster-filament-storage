"use client"

import { useCallback, useEffect, useState } from "react"

/**
 * Per-device persisted state helpers (localStorage). These intentionally do NOT
 * sync across devices — they store view-only UI preferences (panel heights,
 * collapsed sections) that should feel local to the machine you're on.
 *
 * SSR-safe: the initial render always uses `fallback` so server and first
 * client render match; the stored value is applied in an effect after mount.
 */

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Ignore quota / privacy-mode errors — the pref just won't persist.
  }
}

/** Persisted number, clamped to [min, max]. */
export function usePersistentNumber(key: string, fallback: number, min: number, max: number) {
  const clamp = useCallback((n: number) => Math.min(max, Math.max(min, n)), [min, max])
  const [value, setValue] = useState(fallback)

  // Hydrate from storage after mount (avoids SSR mismatch).
  useEffect(() => {
    const raw = readRaw(key)
    if (raw != null) {
      const parsed = Number.parseFloat(raw)
      if (Number.isFinite(parsed)) setValue(clamp(parsed))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const set = useCallback(
    (next: number | ((prev: number) => number)) => {
      setValue((prev) => {
        const resolved = clamp(typeof next === "function" ? (next as (p: number) => number)(prev) : next)
        writeRaw(key, String(resolved))
        return resolved
      })
    },
    [key, clamp],
  )

  return [value, set] as const
}

/** Persisted boolean. */
export function usePersistentBoolean(key: string, fallback: boolean) {
  const [value, setValue] = useState(fallback)

  useEffect(() => {
    const raw = readRaw(key)
    if (raw === "true" || raw === "false") setValue(raw === "true")
  }, [key])

  const set = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: boolean) => boolean)(prev) : next
        writeRaw(key, String(resolved))
        return resolved
      })
    },
    [key],
  )

  return [value, set] as const
}

/**
 * True on viewports >= the given breakpoint (default 1024px = Tailwind `lg`).
 * Used to enable the draggable divider only on the desktop two-column layout,
 * where the sidebar has a bounded height to redistribute.
 */
export function useIsDesktop(minWidth = 1024) {
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${minWidth}px)`)
    const update = () => setIsDesktop(mq.matches)
    update()
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [minWidth])

  return isDesktop
}
