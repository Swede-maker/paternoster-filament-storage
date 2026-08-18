/**
 * Self-healing guard for native modules, run automatically on `postinstall`.
 *
 * Why this exists: user setups are stored in a local SQLite database via
 * `better-sqlite3`, which ships a compiled native binary tied to the exact
 * Node.js ABI. After a `git pull` + `pnpm install` — especially under a
 * different Node version — that binary can become stale, and every database
 * call throws. When that happened at startup the app used to fall back to the
 * first-run setup wizard, so users appeared to "lose" their data.
 *
 * This script loads better-sqlite3 once. If it imports cleanly, we do nothing.
 * If it throws (missing/mismatched binding), we rebuild it in place so the very
 * next `pnpm start` works. It never exits non-zero: a rebuild problem must not
 * block installs in environments that don't run the SQLite path.
 */
import { execSync } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

function canLoadBetterSqlite() {
  try {
    // Constructing an in-memory DB forces the native binding to actually load.
    const Database = require("better-sqlite3")
    const db = new Database(":memory:")
    db.close()
    return true
  } catch (err) {
    console.log("[v0] better-sqlite3 native binding not usable:", err?.message ?? err)
    return false
  }
}

function rebuild() {
  // Prefer pnpm (this project's package manager); fall back to npm if needed.
  const commands = ["pnpm rebuild better-sqlite3", "npm rebuild better-sqlite3"]
  for (const cmd of commands) {
    try {
      console.log(`[v0] Rebuilding better-sqlite3 with: ${cmd}`)
      execSync(cmd, { stdio: "inherit" })
      return true
    } catch (err) {
      console.log(`[v0] "${cmd}" failed:`, err?.message ?? err)
    }
  }
  return false
}

try {
  if (canLoadBetterSqlite()) {
    process.exit(0)
  }
  const ok = rebuild()
  if (ok && canLoadBetterSqlite()) {
    console.log("[v0] better-sqlite3 rebuilt successfully — your saved data will load normally.")
  } else if (!ok) {
    console.log(
      "[v0] Could not rebuild better-sqlite3 automatically. If the app shows a load error, run `pnpm rebuild better-sqlite3` on the server and restart.",
    )
  }
} catch (err) {
  // Never fail the install because of this guard.
  console.log("[v0] ensure-native-modules guard error (ignored):", err?.message ?? err)
}

process.exit(0)
