"use client"

import { useEffect, useRef } from "react"
import { useStore } from "@/lib/store"
import type { StorageNode } from "@/lib/types"
import { parseEvent, type NodeCommand } from "@/lib/node-protocol"
import { moveDutyFor, homingDutyFor, approachDutyFor, DEFAULT_RAMP_PCT } from "@/lib/filament"

/**
 * Owns the live connection to hardware nodes' Pi agents — via the app server.
 *
 * Rather than each browser opening its own `ws://<pi-ip>:<port>` socket (which
 * only works on devices that can reach the Pi's LAN IP and aren't blocked by
 * HTTPS mixed-content), every browser talks to THIS app's own origin:
 *   - downstream: an EventSource on `/api/pi/stream` (SSE) delivers Pi events
 *     and relay link-status.
 *   - upstream: `POST /api/pi/command` forwards commands.
 * The app server keeps the single WebSocket to the Pi and fans out to everyone,
 * so ANY device (phone on cellular, HTTPS, other subnet) can drive the carousel
 * as long as the server can reach the Pi.
 *
 * Renders nothing. Simulated nodes are ignored (they run on in-app timers).
 */

interface Conn {
  es: EventSource | null
  /** `${ip}:${port}#${connSeq}` — used to detect when a node changed. */
  key: string
  /** Whether the relay currently has a live socket to the Pi. */
  online: boolean
  // Command de-duplication so we don't spam the agent every render.
  homeSent: boolean
  gotoTarget: number | null
  /** True between sending a home/goto and receiving its arrived/homed. */
  commandActive: boolean
  /** True once an e-stop has been delivered for the current "stopped" state. */
  stopSent: boolean
}

export function NodeConnection() {
  const { state, dispatch } = useStore()
  const conns = useRef<Record<string, Conn>>({})
  // Keep the latest nodes list available to callbacks (which close over stale
  // state otherwise).
  const nodesRef = useRef<StorageNode[]>(state.nodes)
  nodesRef.current = state.nodes

  // --- Reconcile the set of open streams with the hardware nodes. ---
  const connectionSig = state.nodes
    .filter((n) => n.driver === "hardware")
    // Include connSeq so a manual "Reconnect" (which bumps it) re-opens the
    // stream for that node.
    .map((n) => `${n.id}@${n.ip}:${n.port}#${n.connSeq ?? 0}`)
    .join("|")

  useEffect(() => {
    const hardware = state.nodes.filter((n) => n.driver === "hardware")
    const wanted = new Map(hardware.map((n) => [n.id, `${n.ip}:${n.port}#${n.connSeq ?? 0}`]))

    const closeConn = (nodeId: string) => {
      const c = conns.current[nodeId]
      if (!c) return
      try {
        c.es?.close()
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

      const params = new URLSearchParams({
        ip: node.ip,
        port: String(node.port),
        shelves: String(node.storage.shelves),
      })
      let es: EventSource
      try {
        es = new EventSource(`/api/pi/stream?${params.toString()}`)
      } catch {
        dispatch({ type: "NODE_LINK", nodeId, link: "offline" })
        return
      }
      c.es = es

      // Relay link-status frames reflect the server↔Pi socket state.
      es.addEventListener("link", (e) => {
        const conn = conns.current[nodeId]
        if (!conn) return
        let status: string | undefined
        let reason: string | undefined
        try {
          const payload = JSON.parse((e as MessageEvent).data) as { status?: string; reason?: string }
          status = payload.status
          reason = payload.reason
        } catch {
          return
        }
        if (status === "online" || status === "checking" || status === "offline") {
          conn.online = status === "online"
          dispatch({ type: "NODE_LINK", nodeId, link: status, reason })
        }
      })

      // Pi event frames (raw agent JSON), forwarded verbatim by the relay.
      es.addEventListener("pi", (e) => {
        const conn = conns.current[nodeId]
        const ev = parseEvent((e as MessageEvent).data)
        if (!ev) return
        switch (ev.type) {
          case "hello":
            // The agent tells us here whether it is driving real GPIO. A
            // simulating agent reports perfect motion with idle motor pins, so
            // this is the only way to catch a carousel that "works" but never
            // physically moves.
            dispatch({
              type: "NODE_AGENT_MODE",
              nodeId,
              simulated: ev.simulated === true,
              reason: ev.simReason ?? undefined,
            })
            break
          // A `state` frame is the agent's opening summary on connect. It must
          // NOT be treated like a `pos` frame: the agent keeps position purely
          // in memory and resets to `current_shelf = 0, homed = False` on every
          // start, so a freshly (re)started agent reports a position it has not
          // actually verified. Adopting it overwrote the correct persisted shelf
          // on every browser refresh — and if the agent restarted mid-home the
          // number varied, which is why the jump looked random.
          //
          // An un-homed agent knows nothing about where the carousel is, so the
          // persisted position stays authoritative until it genuinely homes.
          case "state":
            if (ev.homed) {
              dispatch({ type: "NODE_POS", nodeId, currentShelf: ev.shelf })
            }
            break
          case "pos":
            // Real sensor crossing during motion — always authoritative.
            dispatch({ type: "NODE_POS", nodeId, currentShelf: ev.shelf })
            break
          case "sensor":
            // Live level of the physical shelf proximity sensor (GPIO), pushed
            // whenever it changes and once on connect. Drives the real-time
            // sensor lamp on the carousel.
            dispatch({ type: "NODE_SENSOR", nodeId, on: ev.on })
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
      })

      // SSE dropped (network blip). EventSource auto-reconnects; show "checking"
      // meanwhile and let the next `link` frame restore the true status.
      es.onerror = () => {
        const conn = conns.current[nodeId]
        if (!conn) return
        conn.online = false
        // This is the browser↔app-server hop failing, NOT the server↔Pi hop, so
        // it needs its own wording — the Pi may well be fine.
        dispatch({
          type: "NODE_LINK",
          nodeId,
          link: "checking",
          reason: "Lost the event stream from the app server — retrying…",
        })
      }
    }

    // Close streams for nodes that are gone or whose endpoint changed.
    for (const nodeId of Object.keys(conns.current)) {
      if (!wanted.has(nodeId) || wanted.get(nodeId) !== conns.current[nodeId].key) {
        closeConn(nodeId)
      }
    }

    // Open streams for new hardware nodes.
    for (const [nodeId, key] of wanted) {
      if (!conns.current[nodeId]) {
        conns.current[nodeId] = {
          es: null,
          key,
          online: false,
          homeSent: false,
          gotoTarget: null,
          commandActive: false,
          stopSent: false,
        }
        connect(nodeId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionSig])

  // --- Translate machine intent into commands, sent via the relay. ---
  const intentSig = state.nodes
    .filter((n) => n.driver === "hardware")
    .map((n) => `${n.id}:${n.link}:${n.machine.status}:${n.machine.targetShelf}`)
    .join("|")

  useEffect(() => {
    const post = (node: StorageNode, cmd: NodeCommand) => {
      void fetch("/api/pi/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: node.ip, port: node.port, command: cmd }),
      }).catch(() => {
        // Delivery failure is surfaced by the lack of a resulting Pi event; the
        // relay keeps retrying its own socket independently.
      })
    }

    for (const node of state.nodes) {
      if (node.driver !== "hardware") continue
      const c = conns.current[node.id]
      if (!c) continue
      const m = node.machine

      // EMERGENCY STOP FIRST, and unconditionally.
      //
      // Checked BEFORE the `online` guard on purpose. A stop is a safety command,
      // so it must be attempted even when this client currently believes the link
      // is down: "we think it is offline" is not evidence the motor is off, and a
      // stale/flapping `online` flag must never be what swallows it. Every other
      // command still requires a live link (guard below).
      //
      // This branch did not exist. `EMERGENCY_STOP` puts the machine in the
      // dedicated "stopped" status, which is neither "homing", "moving" nor
      // "idle" — so it fell straight through this if/else chain and NO `stop`
      // was ever sent to the Pi. The browser showed the "Emergency stopped"
      // banner and froze its own animation while the real carousel carried on
      // turning, which is exactly what happens mid-homing: homing is a long
      // autonomous routine on the agent, so with no stop delivered it simply
      // ran to completion.
      //
      // Deliberately NOT gated on `c.commandActive`. That flag only tracks what
      // this app believes it started; an e-stop must also halt motion the app
      // did not initiate (a resumed routine, or an agent restarted mid-move).
      // Re-sending `stop` is idempotent and harmless.
      if (m.status === "stopped") {
        if (!c.stopSent) {
          post(node, { type: "stop" })
          c.stopSent = true
        }
        // Clear the command latches so RESUME re-issues home/goto rather than
        // assuming the in-flight command survived the stop.
        c.commandActive = false
        c.homeSent = false
        c.gotoTarget = null
        continue
      }
      c.stopSent = false

      // Everything past this point is a normal motion command, which is only
      // meaningful on a live link.
      if (!c.online) continue

      if (m.status === "homing") {
        if (!c.homeSent) {
          post(node, { type: "home" })
          c.homeSent = true
          c.commandActive = true
        }
      } else if (m.status === "moving") {
        if (m.targetShelf != null && c.gotoTarget !== m.targetShelf) {
          post(node, { type: "goto", shelf: m.targetShelf })
          c.gotoTarget = m.targetShelf
          c.commandActive = true
        }
      } else if (m.status === "idle") {
        // Reached idle without an arrival/homed (e.g. the user cancelled a
        // job) — make sure the physical motor stops too.
        if (c.commandActive) {
          post(node, { type: "stop" })
          c.commandActive = false
        }
        c.homeSent = false
        c.gotoTarget = null
      }
      // awaiting-*-confirm: hold; nothing to send until the user proceeds.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentSig])

  // --- Push machine settings (shelf count + motion tuning) to the agent. ---
  //
  // This effect did not exist, which is why the speed and soft-start sliders had
  // no effect on the hardware: they updated local state that only retimed the
  // on-screen animation, and no `config` command was ever sent. The agent kept
  // running on its built-in defaults.
  //
  // Keyed on the values themselves, so it re-sends whenever a slider moves and
  // also right after (re)connecting — a restarted Pi comes back on defaults and
  // must be told the current settings again.
  //
  // The link state MUST come from the store (`n.link`), not from
  // `conns.current[id].online`. `conns` is a ref: flipping `online` is a plain
  // mutation that triggers no re-render, so a signature built from it stays
  // frozen at whatever it was on mount ("off", since the map starts empty) and
  // this effect never re-fires on connect. Reading `n.link` — which is dispatched
  // to the store right beside that mutation — makes connect/disconnect a real
  // state change that recomputes the signature.
  const configSig = state.nodes
    .filter((n) => n.driver === "hardware")
    .map((n) =>
      [
        n.id,
        n.link,
        n.storage.shelves,
        moveDutyFor(n),
        homingDutyFor(n),
        approachDutyFor(n),
        n.rampPct ?? DEFAULT_RAMP_PCT,
      ].join(":"),
    )
    .join("|")

  useEffect(() => {
    // Debounced: dragging a slider fires a change per pixel, and each one would
    // otherwise be a POST to the Pi.
    const timer = setTimeout(() => {
      for (const node of nodesRef.current) {
        if (node.driver !== "hardware") continue
        // No ref-based online gate here either. The relay remembers motion
        // settings and replays them when the Pi reconnects, so sending while the
        // link is down is harmless (the route answers "Pi not connected") and
        // strictly better than dropping the operator's setting on the floor.
        void fetch("/api/pi/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ip: node.ip,
            port: node.port,
            command: {
              type: "config",
              shelves: node.storage.shelves,
              moveSpeed: moveDutyFor(node),
              homingSpeed: homingDutyFor(node),
              approachSpeed: approachDutyFor(node),
              rampPct: node.rampPct ?? DEFAULT_RAMP_PCT,
            },
          }),
        }).catch(() => {
          // Settings are re-sent on the next change or reconnect.
        })
      }
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configSig])

  // Cleanup on unmount.
  useEffect(() => {
    const map = conns.current
    return () => {
      for (const id of Object.keys(map)) {
        try {
          map[id].es?.close()
        } catch {
          // ignore
        }
        delete map[id]
      }
    }
  }, [])

  return null
}
