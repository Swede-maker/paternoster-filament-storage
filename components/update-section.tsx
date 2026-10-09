"use client"

import { useEffect, useRef, useState } from "react"
import useSWR from "swr"
import { Check, CheckCircle2, Copy, Download, Loader2, RefreshCw, Terminal, TriangleAlert } from "lucide-react"
import { Button } from "./ui/button"
import { cn } from "@/lib/utils"
import type { UpdateStatus } from "@/lib/server/updater"

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<UpdateStatus>)

function relative(iso?: string): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.round(diff / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return new Date(iso).toLocaleDateString()
}

export function UpdateSection() {
  const [checking, setChecking] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Remember that we kicked off an update so the restart (connection errors)
  // is shown as progress rather than failure, and reload once it's back.
  const [inFlight, setInFlight] = useState(false)
  const sawOutage = useRef(false)

  const { data, mutate, error: fetchError } = useSWR("/api/update", fetcher, {
    refreshInterval: (latest) =>
      inFlight || latest?.phase === "requested" || latest?.phase === "running" ? 2000 : 0,
    shouldRetryOnError: true,
    errorRetryInterval: 2000,
  })

  const busy = inFlight || data?.phase === "requested" || data?.phase === "running"

  useEffect(() => {
    if (!inFlight) return
    if (fetchError) {
      sawOutage.current = true
      return
    }
    // Back after the restart with a finished run: load the new version.
    if (sawOutage.current && data && (data.phase === "done" || data.phase === "failed")) {
      if (data.phase === "done") window.location.reload()
      setInFlight(false)
    }
  }, [inFlight, fetchError, data])

  async function check() {
    setChecking(true)
    setError(null)
    try {
      const next = await fetcher("/api/update?check=1&force=1")
      await mutate(next, { revalidate: false })
    } finally {
      setChecking(false)
    }
  }

  async function start() {
    setStarting(true)
    setError(null)
    try {
      const res = await fetch("/api/update", { method: "POST" })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Could not start the update (${res.status})`)
        return
      }
      sawOutage.current = false
      setInFlight(true)
      await mutate()
    } finally {
      setStarting(false)
    }
  }

  if (!data && !fetchError) {
    return <p className="text-sm text-muted-foreground">Checking the installation…</p>
  }

  if (data && !data.available) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground text-pretty">
          {data.reason}
          {data.reason?.startsWith("The app is not running from a Pi") &&
            " Install on a Raspberry Pi with the one-line installer to update from here."}
        </p>
        <SshUpdateCommand />
      </div>
    )
  }

  const behind = data?.behind ?? 0
  const upToDate = data?.checkedAt && !data.checkError && behind === 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Installed</span>
            {data?.current ? (
              <>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{data.current.hash}</code>
                <span className="truncate">{data.current.subject}</span>
              </>
            ) : (
              <span className="text-muted-foreground">unknown</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            Branch <span className="font-mono">{data?.branch}</span>
            {data?.current?.date && <> · committed {relative(data.current.date)}</>}
            {data?.checkedAt && <> · checked {relative(data.checkedAt)}</>}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={check} disabled={checking || busy}>
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Check for updates
        </Button>
      </div>

      {data?.checkError && !busy && (
        <p className="flex items-start gap-2 text-sm text-destructive text-pretty">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Could not reach GitHub: {data.checkError}
        </p>
      )}

      {!busy && upToDate && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-primary" /> You have the newest version.
        </p>
      )}

      {!busy && behind > 0 && (
        <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">
              {behind} new {behind === 1 ? "change" : "changes"} available
            </p>
            <Button size="sm" onClick={start} disabled={starting}>
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Update now
            </Button>
          </div>
          <ul className="max-h-40 space-y-1 overflow-y-auto text-xs scrollbar-thin">
            {data!.newCommits.map((c) => (
              <li key={c.hash} className="flex gap-2">
                <code className="shrink-0 font-mono text-muted-foreground">{c.hash}</code>
                <span className="text-pretty">{c.subject}</span>
              </li>
            ))}
            {behind > data!.newCommits.length && (
              <li className="text-muted-foreground">…and {behind - data!.newCommits.length} more</li>
            )}
          </ul>
          <p className="text-xs text-muted-foreground text-pretty">
            Downloads the newest code, rebuilds the app and restarts it. Your filaments, shelves, storage units and
            settings are kept, and a backup of the database is made first. Takes 5–15 minutes on a Pi 4; the app is
            offline while it rebuilds.
          </p>
        </div>
      )}

      {(busy || data?.phase === "done" || data?.phase === "failed") && (
        <UpdateProgress status={data} busy={busy} offline={!!fetchError} />
      )}

      {error && (
        <p className="flex items-start gap-2 text-sm text-destructive text-pretty">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </p>
      )}

      <SshUpdateCommand />
    </div>
  )
}

const SSH_UPDATE_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/Swede-maker/paternoster-filament-storage/main/setup.sh | sudo bash -s -- --update"

function SshUpdateCommand() {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(SSH_UPDATE_COMMAND)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="h-4 w-4 text-muted-foreground" /> Update over SSH
        </p>
        <Button variant="outline" size="sm" className="min-h-11" onClick={copy}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <code className="block break-all rounded bg-muted p-2 font-mono text-xs leading-relaxed">
        {SSH_UPDATE_COMMAND}
      </code>
      <p className="text-xs text-muted-foreground text-pretty">
        Paste it into an SSH session on the Pi. It pulls the newest code from GitHub and keeps your setup, filaments,
        storage units and motor tuning. A backup of the database is made first.
      </p>
    </div>
  )
}

function UpdateProgress({ status, busy, offline }: { status?: UpdateStatus; busy: boolean; offline: boolean }) {
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [status?.log])

  const phase = status?.phase
  // The path unit normally reacts within seconds. If nothing has happened
  // after a minute the updater service is probably not installed.
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    if (phase !== "requested") {
      setStuck(false)
      return
    }
    const t = window.setTimeout(() => setStuck(true), 60_000)
    return () => window.clearTimeout(t)
  }, [phase])
  let headline: string
  let icon: React.ReactNode
  if (offline && busy) {
    headline = "Restarting the app… this page reconnects by itself."
    icon = <Loader2 className="h-4 w-4 animate-spin text-primary" />
  } else if (busy) {
    headline = phase === "requested" ? "Starting the updater…" : "Updating — please keep the Pi powered."
    icon = <Loader2 className="h-4 w-4 animate-spin text-primary" />
  } else if (phase === "done") {
    headline = `Updated ${relative(status?.finishedAt)}.`
    icon = <CheckCircle2 className="h-4 w-4 text-primary" />
  } else {
    headline = `The last update failed${status?.finishedAt ? ` (${relative(status.finishedAt)})` : ""}. The previous version is still running.`
    icon = <TriangleAlert className="h-4 w-4 text-destructive" />
  }

  return (
    <div className={cn("space-y-2 rounded-lg border p-3", phase === "failed" && !busy && "border-destructive/40")}>
      <p className="flex items-center gap-2 text-sm font-medium">
        {icon} {headline}
      </p>
      {stuck && (
        <p className="text-xs text-muted-foreground text-pretty">
          Nothing has started yet. The updater service may be missing on this Pi — run the one-line installer over SSH
          once; it adds the updater and future updates work from here.
        </p>
      )}
      {status?.log && (
        <pre
          ref={logRef}
          className="max-h-48 overflow-y-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed text-muted-foreground scrollbar-thin"
        >
          {status.log}
        </pre>
      )}
    </div>
  )
}
