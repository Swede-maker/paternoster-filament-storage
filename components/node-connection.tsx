"use client"

import { useEffect, useRef } from "react"
import { useStore } from "@/lib/store"
import type { StorageNode } from "@/lib/types"
import { agentUrl, encodeCommand, parseEvent, type NodeCommand } from "@/lib/node-protocol"

/**
 * Owns the live WebSocket connections to hardware nodes' Pi agents.
 *
 * Responsibilities:
 *  - Open/close a socket per hardware node (reconnecting with backoff).
 *  - Translate the machine's *intent* (homing / moving) into agent commands,
 *    sending each command exactly once per episode.
 *  - Translate agent *events* (pos / arrived / homed / fault) back into store
 *    actions so the UI reflects the real carousel.
 *
 * Renders nothing. Simulated nodes are ignored entirely (they run on in-app
 * timers inside the store).
 *
 * NOTE on mixed content: a browser page served over HTTPS cannot open an
 * insecure ws:// socket. Real hardware use therefore happens over the LAN via
 * http:// (or a wss:// reverse proxy on the Pi). On the hosted HTTPS preview,
 * hardware nodes will simply show as "offline" — this is expected.
 */

interface Conn {
  ws: WebSocket | null
  /** `${ip}:${port}` — used to detect when a node's endpoint changed. */
  key: string
  reconnect: ReturnType<typeof setTimeout> | null
  closedByUs: boolean
  // Command de-duplication so we don't spam the agent every render.
  homeSent: boolean
  gotoTarget: number | null
  /** True between sending a home/goto and receiving its arrived/homed. */
  commandActive: boolean
}

const RECONNECT_MS = 3000

export function NodeConnection() {
  const { state, dispatch } = useStore()
  const conns = useRef<Record<string, Conn>>({})
  // Keep the latest nodes list available to socket callbacks (which close over
  // stale state otherwise).
  const nodesRef = useRef<StorageNode[]>(state.nodes)
  nodesRef.current = state.nodes

  // --- Reconcile the set of open sockets with the hardware nodes. ---
  const connectionSig = state.nodes
    .filter((n) => n.driver === "hardware")
    // Include connSeq so a manual "Reconnect" (which bumps it) changes the key
    // for that node and forces the reconcile below to close + reopen its socket.
    .map((n) => `${n.id}@${n.ip}:${n.port}#${n.connSeq ?? 0}`)
    .join("|")

  useEffect(() => {
    const hardware = state.nodes.filter((n) => n.driver === "hardware")
    const wanted = new Map(hardware.map((n) => [n.id, `${n.ip}:${n.port}#${n.connSeq ?? 0}`]))

    const send = (nodeId: string, cmd: NodeCommand) => {
      const c = conns.current[nodeId]
      if (c?.ws && c.ws.readyState === WebSocket.OPEN) c.ws.send(encodeCommand(cmd))
    }

    const closeConn = (nodeId: string) => {
      const c = conns.current[nodeId]
      if (!c) return
      c.closedByUs = true
      if (c.reconnect) clearTimeout(c.reconnect)
      try {
        c.ws?.close()
      } catch {
        // ignore
      }
      delete conns.current[nodeId]
    }

    const connect = (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      const c = conns.current[nodeId]
      if (!node || !c) return
      dispatch({ type: "NODE_LINK", nodeId, link: "checking" })
      let ws: WebSocket
      try {
        ws = new WebSocket(agentUrl(node.ip, node.port))
      } catch {
        dispatch({ type: "NODE_LINK", nodeId, link: "offline" })
        scheduleReconnect(nodeId)
        return
      }
      c.ws = ws

      ws.onopen = () => {
        dispatch({ type: "NODE_LINK", nodeId, link: "online" })
        // Tell the agent the carousel geometry so it can wrap shelf indexes.
        const fresh = nodesRef.current.find((n) => n.id === nodeId)
        if (fresh) send(nodeId, { type: "config", shelves: fresh.storage.shelves })
      }

      ws.onmessage = (e) => {
        const ev = parseEvent(typeof e.data === "string" ? e.data : "")
        if (!ev) return
        const conn = conns.current[nodeId]
        switch (ev.type) {
          case "hello":
            break
          case "state":
            dispatch({ type: "NODE_POS", nodeId, currentShelf: ev.shelf })
            break
          case "pos":
            dispatch({ type: "NODE_POS", nodeId, currentShelf: ev.shelf })
            break
          case "arrived":
            if (conn) {
              conn.commandActive = false
              conn.gotoTarget = null
            }
            dispatch({ type: "NODE_ARRIVED", nodeId, shelf: ev.shelf })
            break
          case "homed":
            if (conn) {
              conn.commandActive = false
              conn.homeSent = false
            }
            dispatch({ type: "NODE_HOMED", nodeId, currentShelf: ev.shelf })
            break
          case "fault":
            if (conn) {
              conn.commandActive = false
              conn.gotoTarget = null
              conn.homeSent = false
            }
            dispatch({ type: "NODE_FAULT", nodeId, message: ev.message })
            break
        }
      }

      ws.onclose = () => {
        const conn = conns.current[nodeId]
        if (!conn) return
        conn.ws = null
        dispatch({ type: "NODE_LINK", nodeId, link: "offline" })
        if (!conn.closedByUs) scheduleReconnect(nodeId)
      }

      ws.onerror = () => {
        try {
          ws.close()
        } catch {
          // onclose will handle reconnect
        }
      }
    }

    const scheduleReconnect = (nodeId: string) => {
      const c = conns.current[nodeId]
      if (!c || c.reconnect) return
      c.reconnect = setTimeout(() => {
        const conn = conns.current[nodeId]
        if (!conn) return
        conn.reconnect = null
        connect(nodeId)
      }, RECONNECT_MS)
    }

    // Close sockets for nodes that are gone or whose endpoint changed.
    for (const nodeId of Object.keys(conns.current)) {
      if (!wanted.has(nodeId) || wanted.get(nodeId) !== conns.current[nodeId].key) {
        closeConn(nodeId)
      }
    }

    // Open sockets for new hardware nodes.
    for (const [nodeId, key] of wanted) {
      if (!conns.current[nodeId]) {
        conns.current[nodeId] = {
          ws: null,
          key,
          reconnect: null,
          closedByUs: false,
          homeSent: false,
          gotoTarget: null,
          commandActive: false,
        }
        connect(nodeId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionSig])

  // --- Translate machine intent into commands for connected agents. ---
  const intentSig = state.nodes
    .filter((n) => n.driver === "hardware")
    .map((n) => `${n.id}:${n.link}:${n.machine.status}:${n.machine.targetShelf}`)
    .join("|")

  useEffect(() => {
    for (const node of state.nodes) {
      if (node.driver !== "hardware") continue
      const c = conns.current[node.id]
      if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) continue
      const m = node.machine
      const send = (cmd: NodeCommand) => c.ws?.send(encodeCommand(cmd))

      if (m.status === "homing") {
        if (!c.homeSent) {
          send({ type: "home" })
          c.homeSent = true
          c.commandActive = true
        }
      } else if (m.status === "moving") {
        if (m.targetShelf != null && c.gotoTarget !== m.targetShelf) {
          send({ type: "goto", shelf: m.targetShelf })
          c.gotoTarget = m.targetShelf
          c.commandActive = true
        }
      } else if (m.status === "idle") {
        // Reached idle without an arrival/homed (e.g. the user cancelled a
        // job) — make sure the physical motor stops too.
        if (c.commandActive) {
          send({ type: "stop" })
          c.commandActive = false
        }
        c.homeSent = false
        c.gotoTarget = null
      }
      // awaiting-*-confirm: hold; nothing to send until the user proceeds.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentSig])

  // Cleanup on unmount.
  useEffect(() => {
    const map = conns.current
    return () => {
      for (const id of Object.keys(map)) {
        const c = map[id]
        c.closedByUs = true
        if (c.reconnect) clearTimeout(c.reconnect)
        try {
          c.ws?.close()
        } catch {
          // ignore
        }
        delete map[id]
      }
    }
  }, [])

  return null
}
