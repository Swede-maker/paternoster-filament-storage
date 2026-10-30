"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import type { StorageNode } from "@/lib/types"
import { parseEvent, type NetResultEvent, type NetSlave, type NetStatusEvent } from "@/lib/node-protocol"
import { NetworkPanel } from "./network-panel"

const LOCAL_HOST = "127.0.0.1"
const LOCAL_PORT = 8765

/**
 * Network panel for a server-only master Pi (installed without a carousel).
 * There is no storage unit to hang the panel on, so this opens its own relay
 * stream to the master service on the same machine and renders only once that
 * service answers — on a laptop or the v0 preview nothing listens on :8765 and
 * the section stays hidden.
 */
export function LocalMasterNetwork({ children }: { children: (panel: ReactNode) => ReactNode }) {
  const [online, setOnline] = useState(false)
  const [net, setNet] = useState<NetStatusEvent | null>(null)
  const [slaves, setSlaves] = useState<NetSlave[]>([])
  const [result, setResult] = useState<NetResultEvent | null>(null)

  useEffect(() => {
    const params = new URLSearchParams({ ip: LOCAL_HOST, port: String(LOCAL_PORT), shelves: "0" })
    const es = new EventSource(`/api/pi/stream?${params.toString()}`)
    es.addEventListener("link", (e) => {
      try {
        const { status } = JSON.parse((e as MessageEvent).data) as { status?: string }
        setOnline(status === "online")
      } catch {}
    })
    es.addEventListener("pi", (e) => {
      const ev = parseEvent((e as MessageEvent).data as string)
      if (!ev) return
      if (ev.type === "net.status") setNet(ev)
      else if (ev.type === "net.slaves") setSlaves(ev.slaves)
      else if (ev.type === "net.result") setResult(ev)
    })
    return () => es.close()
  }, [])

  const node = useMemo(
    () =>
      ({
        id: "local-master",
        name: "PAX server",
        ip: LOCAL_HOST,
        port: LOCAL_PORT,
        role: "master",
        driver: "hardware",
        link: online ? "online" : "offline",
        net,
        netSlaves: slaves,
        netResult: result,
      }) as unknown as StorageNode,
    [online, net, slaves, result],
  )

  if (!online) return null
  return <>{children(<NetworkPanel node={node} onResult={setResult} />)}</>
}
