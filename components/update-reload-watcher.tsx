"use client"

import { useEffect, useState } from "react"
import type { UpdateStatus } from "@/lib/server/updater"

const KEY = "pax:update-in-flight"
const EVENT = "pax:update-started"
const POLL_MS = 3000

type Marker = { fromHash?: string; startedAt: number }

function readMarker(): Marker | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Marker) : null
  } catch {
    return null
  }
}

function clearMarker() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

/** Call right after the update was accepted by the server. */
export function markUpdateStarted(fromHash: string | undefined) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ fromHash, startedAt: Date.now() } satisfies Marker))
  } catch {
    // Storage disabled: the watcher still runs for this page via the event.
  }
  window.dispatchEvent(new CustomEvent<Marker>(EVENT, { detail: { fromHash, startedAt: Date.now() } }))
}

async function fetchStatus(): Promise<UpdateStatus | null> {
  try {
    const res = await fetch("/api/update", { cache: "no-store", signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    return (await res.json()) as UpdateStatus
  } catch {
    return null
  }
}

/**
 * Reloads the page once an update started from this browser tab has finished
 * and the NEW version is serving. Mounted at the app root so it keeps watching
 * even if the user leaves Settings, and the marker survives a manual reload.
 *
 * It polls on a fixed timer on purpose: SWR stops its refresh interval while a
 * request is failing and falls back to exponential retry backoff (up to ~8
 * minutes between tries), so during a long rebuild the page often wasn't even
 * asking when the app came back.
 */
export function UpdateReloadWatcher() {
  const [marker, setMarker] = useState<Marker | null>(null)

  useEffect(() => {
    setMarker(readMarker())
    const onStart = (e: Event) => setMarker((e as CustomEvent<Marker>).detail)
    window.addEventListener(EVENT, onStart)
    return () => window.removeEventListener(EVENT, onStart)
  }, [])

  useEffect(() => {
    if (!marker) return
    let stopped = false
    let sawOutage = false
    const tick = async () => {
      const status = await fetchStatus()
      if (stopped) return
      if (!status) {
        sawOutage = true
        return
      }
      if (status.phase === "failed") {
        clearMarker()
        setMarker(null)
        return
      }
      const newCode = !!marker.fromHash && !!status.current?.hash && status.current.hash !== marker.fromHash
      const finishedAfterStart =
        status.phase === "done" &&
        !!status.finishedAt &&
        new Date(status.finishedAt).getTime() >= marker.startedAt - 60_000
      // Only reload into a server that is answering with the new build; reloading
      // mid-restart lands on the browser's own error page.
      if (newCode || (finishedAfterStart && sawOutage)) {
        clearMarker()
        stopped = true
        window.location.reload()
      }
    }
    const iv = window.setInterval(tick, POLL_MS)
    // Give up after an hour so a stale marker can't poll forever.
    const giveUp = window.setTimeout(() => {
      clearMarker()
      setMarker(null)
    }, Math.max(0, marker.startedAt + 60 * 60_000 - Date.now()))
    return () => {
      stopped = true
      window.clearInterval(iv)
      window.clearTimeout(giveUp)
    }
  }, [marker])

  return null
}
