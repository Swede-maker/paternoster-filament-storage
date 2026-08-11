import Database from "better-sqlite3"
import path from "node:path"

/**
 * Local SQLite database. All system state lives in a single file on disk
 * (`paternoster.db` in the project directory by default), so the whole app is
 * fully offline — no cloud database, no internet access required.
 *
 * On a Raspberry Pi deployment this file sits next to the app and is the single
 * source of truth that every device on the network reads and writes through
 * the Next.js server.
 *
 * Set PATERNOSTER_DB_PATH to store the file elsewhere (e.g. a mounted volume).
 */
const DB_PATH = process.env.PATERNOSTER_DB_PATH ?? path.join(process.cwd(), "paternoster.db")

// Reuse a single connection across hot-reloads in dev to avoid file locks.
const globalForDb = globalThis as unknown as { __paternosterDb?: Database.Database }

function createDb(): Database.Database {
  const db = new Database(DB_PATH)
  // WAL improves concurrent read/write behavior for the polling sync loop.
  db.pragma("journal_mode = WAL")
  db.pragma("busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_state (
      id integer PRIMARY KEY CHECK (id = 1),
      data text NOT NULL,
      version integer NOT NULL DEFAULT 1,
      updated_at text NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

export const db = globalForDb.__paternosterDb ?? createDb()

if (process.env.NODE_ENV !== "production") globalForDb.__paternosterDb = db
