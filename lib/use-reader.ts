"use client"

import { useEffect, useRef, useState } from "react"

/**
 * Subscribe to a wireless RFID reader's SSE stream.
 *
 * Opens `/api/reader/stream?token=…` and reports the reader's online presence
 * plus each tag scan as it arrives. `onTag` is held in a ref so callers can pass
 * an inline closure without reopening the stream every render.
 *
 * Pass `token = null` (or `enabled = false`) to stay disconnected — handy for a
 * "waiting for scan" mode that only listens while a dialog is open.
 */
export function useReader(
  token: string | null | undefined,
  onTag: (uid: string) => void,
  enabled = true,
): { online: boolean } {
  const [online, setOnline] = useState(false)
  const onTagRef = useRef(onTag)
  onTagRef.current = onTag

  useEffect(() => {
    if (!token || !enabled) {
      setOnline(false)
      return
    }

    let es: EventSource
    try {
      es = new EventSource(`/api/reader/stream?token=${encodeURIComponent(token)}`)
    } catch {
      setOnline(false)
      return
    }

    const onPresence = (e: MessageEvent) => {
      try {
        const p = JSON.parse(e.data) as { online?: boolean }
        setOnline(p.online === true)
      } catch {
        // ignore malformed frame
      }
    }
    const onTagEvent = (e: MessageEvent) => {
      try {
        const p = JSON.parse(e.data) as { uid?: string }
        if (p.uid) onTagRef.current(p.uid)
      } catch {
        // ignore malformed frame
      }
    }

    es.addEventListener("presence", onPresence)
    es.addEventListener("tag", onTagEvent)
    es.onerror = () => setOnline(false)

    return () => {
      try {
        es.close()
      } catch {
        // ignore
      }
    }
  }, [token, enabled])

  return { online }
}

/**
 * Subscribe to MANY reader tokens at once and fire `onTag` for any scan from any
 * of them. Used by the Scan flow's "wireless reader" mode so a scan from any
 * paired device is accepted. Reports whether at least one reader is online.
 */
export function useReaders(
  tokens: string[],
  onTag: (uid: string) => void,
  enabled = true,
): { anyOnline: boolean } {
  const [onlineSet, setOnlineSet] = useState<Record<string, boolean>>({})
  const onTagRef = useRef(onTag)
  onTagRef.current = onTag
  const key = tokens.join("|")

  useEffect(() => {
    if (!enabled || tokens.length === 0) {
      setOnlineSet({})
      return
    }
    const sources: EventSource[] = []
    for (const token of tokens) {
      let es: EventSource
      try {
        es = new EventSource(`/api/reader/stream?token=${encodeURIComponent(token)}`)
      } catch {
        continue
      }
      es.addEventListener("presence", (e) => {
        try {
          const p = JSON.parse((e as MessageEvent).data) as { online?: boolean }
          setOnlineSet((prev) => ({ ...prev, [token]: p.online === true }))
        } catch {
          // ignore
        }
      })
      es.addEventListener("tag", (e) => {
        try {
          const p = JSON.parse((e as MessageEvent).data) as { uid?: string }
          if (p.uid) onTagRef.current(p.uid)
        } catch {
          // ignore
        }
      })
      es.onerror = () => setOnlineSet((prev) => ({ ...prev, [token]: false }))
      sources.push(es)
    }
    return () => {
      for (const es of sources) {
        try {
          es.close()
        } catch {
          // ignore
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  return { anyOnline: Object.values(onlineSet).some(Boolean) }
}
