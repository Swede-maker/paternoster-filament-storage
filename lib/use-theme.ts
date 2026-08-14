"use client"

import { useCallback, useEffect, useState } from "react"

export type Theme = "light" | "dark"

const KEY = "pax-theme"

/**
 * Per-device light/dark theme. The choice is stored in localStorage (not the
 * shared system document) so each screen — the Pi touchscreen, a phone, a
 * laptop — keeps its own preference. The initial class is applied before paint
 * by the inline script in app/layout.tsx; this hook just reads and updates it.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("dark")

  // Sync from whatever the no-flash script already applied to <html>.
  useEffect(() => {
    const stored = typeof localStorage !== "undefined" ? (localStorage.getItem(KEY) as Theme | null) : null
    const initial: Theme =
      stored ?? (document.documentElement.classList.contains("dark") ? "dark" : "light")
    setThemeState(initial)
  }, [])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    try {
      localStorage.setItem(KEY, t)
    } catch {
      // Private mode / storage disabled — the toggle still works for this session.
    }
    const d = document.documentElement
    d.classList.toggle("dark", t === "dark")
    d.style.colorScheme = t
  }, [])

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark")
  }, [theme, setTheme])

  return { theme, setTheme, toggle }
}
