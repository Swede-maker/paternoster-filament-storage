import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import path from "node:path"

const exec = promisify(execFile)

/**
 * Self-update support for the Pi installation (Settings → Update).
 *
 * The web app runs unprivileged, so it never pulls or builds itself. It only
 * (a) asks git what the remote has, and (b) writes `update.request` into the
 * data directory. `pax-update.path` (installed by setup.sh) starts a root
 * service that pulls, rebuilds, restarts the app and logs to `update.log`.
 */

export type UpdateCommit = { hash: string; subject: string; date: string }

export type UpdateStatus = {
  /** False when not running from the Pi installer (dev, Vercel, zip). */
  available: boolean
  reason?: string
  branch: string
  current?: UpdateCommit
  /** Null until a check has been made. */
  remote?: UpdateCommit | null
  behind: number
  newCommits: UpdateCommit[]
  checkedAt?: string
  checkError?: string
  /** Phase of the updater service, derived from the files it writes. */
  phase: "idle" | "requested" | "running" | "done" | "failed"
  startedAt?: string
  finishedAt?: string
  log: string
}

const APP_DIR = process.cwd()
const DATA_DIR = process.env.PAX_DATA_DIR
  ?? (process.env.PATERNOSTER_DB_PATH ? path.dirname(process.env.PATERNOSTER_DB_PATH) : "")
const BRANCH = process.env.PAX_BRANCH || "main"
const UPDATER_BIN = "/usr/local/sbin/pax-update"

const REQUEST_FILE = () => path.join(DATA_DIR, "update.request")
const LOG_FILE = () => path.join(DATA_DIR, "update.log")
const RESULT_FILE = () => path.join(DATA_DIR, "update.result")

async function git(args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await exec("git", ["-C", APP_DIR, ...args], { timeout, encoding: "utf8" })
  return stdout.trim()
}

function parseCommit(line: string): UpdateCommit | undefined {
  const [hash, date, ...rest] = line.split("\x1f")
  if (!hash) return undefined
  return { hash, date, subject: rest.join("\x1f") }
}

const LOG_FORMAT = "--format=%h\x1f%cI\x1f%s"

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function installedOnPi(): Promise<string | undefined> {
  if (!DATA_DIR) return "The app is not running from a Pi installation (no data directory configured)."
  if (!(await exists(UPDATER_BIN))) {
    return "The updater is not installed. Run setup.sh once over SSH to add it; after that updates can be started from here."
  }
  if (!(await exists(path.join(APP_DIR, ".git")))) return "The app directory is not a git checkout."
  return undefined
}

/** Remote check result, cached briefly so a page refresh doesn't hammer GitHub. */
let lastCheck: { at: number; remote: UpdateCommit | null; behind: number; newCommits: UpdateCommit[]; error?: string } | undefined
const CHECK_TTL_MS = 5 * 60_000

async function checkRemote(force: boolean) {
  if (!force && lastCheck && Date.now() - lastCheck.at < CHECK_TTL_MS) return lastCheck
  try {
    await git(["fetch", "-q", "origin", BRANCH], 30_000)
    const remoteLine = await git(["log", "-1", LOG_FORMAT, `origin/${BRANCH}`])
    const behind = Number(await git(["rev-list", "--count", `HEAD..origin/${BRANCH}`])) || 0
    const newLines = behind > 0 ? await git(["log", "-n", "20", LOG_FORMAT, `HEAD..origin/${BRANCH}`]) : ""
    lastCheck = {
      at: Date.now(),
      remote: parseCommit(remoteLine) ?? null,
      behind,
      newCommits: newLines.split("\n").map(parseCommit).filter((c): c is UpdateCommit => !!c),
    }
  } catch (err) {
    lastCheck = {
      at: Date.now(),
      remote: lastCheck?.remote ?? null,
      behind: lastCheck?.behind ?? 0,
      newCommits: lastCheck?.newCommits ?? [],
      error: err instanceof Error ? err.message.split("\n")[0] : "Could not reach GitHub",
    }
  }
  return lastCheck
}

async function readTail(file: string, maxBytes = 12_000): Promise<string> {
  try {
    const buf = await fs.readFile(file)
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString("utf8")
  } catch {
    return ""
  }
}

async function readProgress(): Promise<Pick<UpdateStatus, "phase" | "startedAt" | "finishedAt" | "log">> {
  if (!DATA_DIR) return { phase: "idle", log: "" }
  const [requested, log, result] = await Promise.all([
    exists(REQUEST_FILE()),
    readTail(LOG_FILE()),
    readTail(RESULT_FILE(), 200),
  ])
  const startedAt = /Update started (\S+)/.exec(log)?.[1]
  if (result.startsWith("ok")) return { phase: "done", startedAt, finishedAt: result.split(" ")[1]?.trim(), log }
  if (result.startsWith("failed")) return { phase: "failed", startedAt, finishedAt: result.split(" ")[2]?.trim(), log }
  if (requested) return { phase: "requested", log }
  if (startedAt) return { phase: "running", startedAt, log }
  return { phase: "idle", log }
}

export async function getUpdateStatus(opts: { check?: boolean; force?: boolean } = {}): Promise<UpdateStatus> {
  const reason = await installedOnPi()
  const progress = await readProgress()
  if (reason) {
    return { available: false, reason, branch: BRANCH, behind: 0, newCommits: [], ...progress }
  }

  let current: UpdateCommit | undefined
  try {
    current = parseCommit(await git(["log", "-1", LOG_FORMAT, "HEAD"]))
  } catch {
    /* detached or empty repo — leave undefined */
  }

  const check = opts.check ? await checkRemote(!!opts.force) : lastCheck
  return {
    available: true,
    branch: BRANCH,
    current,
    remote: check?.remote ?? null,
    behind: check?.behind ?? 0,
    newCommits: check?.newCommits ?? [],
    checkedAt: check ? new Date(check.at).toISOString() : undefined,
    checkError: check?.error,
    ...progress,
  }
}

/** Ask the root updater to run. Returns false if one is already in flight. */
export async function requestUpdate(): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const reason = await installedOnPi()
  if (reason) return { ok: false, error: reason, status: 409 }
  const progress = await readProgress()
  if (progress.phase === "requested" || progress.phase === "running") {
    return { ok: false, error: "An update is already running", status: 409 }
  }
  try {
    // Clear the previous outcome so the UI shows this run from the start.
    await fs.rm(RESULT_FILE(), { force: true })
    await fs.writeFile(REQUEST_FILE(), new Date().toISOString() + "\n")
    lastCheck = undefined
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not write the update request" }
  }
}
