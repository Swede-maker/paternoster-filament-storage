"use server"

import { db } from "@/lib/db"
import type { PersistedState } from "@/lib/types"

export interface LoadResult {
  data: PersistedState | null
  version: number
}

interface StateRow {
  data: string
  version: number
}

/**
 * Load the single shared system document. Returns `null` data when nothing has
 * been saved yet (first ever run), so the client can show first-run setup.
 */
export async function loadSystemState(): Promise<LoadResult> {
  const row = db.prepare("SELECT data, version FROM system_state WHERE id = 1").get() as StateRow | undefined
  if (!row) return { data: null, version: 0 }
  try {
    return { data: JSON.parse(row.data) as PersistedState, version: row.version }
  } catch {
    // Corrupt row — treat as empty so the app can recover with a fresh setup.
    return { data: null, version: 0 }
  }
}

/**
 * Save the shared system document. Upserts the singleton row (id = 1) and bumps
 * the version so other devices can detect that something changed.
 *
 * Returns the new version. This is a "last write wins" model, which is the
 * right fit here: it's one household/workshop editing shared inventory, not
 * many strangers with conflicting edits.
 */
export async function saveSystemState(data: PersistedState): Promise<{ version: number }> {
  const json = JSON.stringify(data)
  const row = db
    .prepare(
      `INSERT INTO system_state (id, data, version, updated_at)
       VALUES (1, @data, 1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         data = @data,
         version = system_state.version + 1,
         updated_at = datetime('now')
       RETURNING version`,
    )
    .get({ data: json }) as { version: number }

  return { version: row?.version ?? 1 }
}

/**
 * Lightweight poll: return only the current version so clients can cheaply
 * detect that another device saved a change and then reload the full document.
 */
export async function getSystemVersion(): Promise<{ version: number }> {
  const row = db.prepare("SELECT version FROM system_state WHERE id = 1").get() as { version: number } | undefined
  return { version: row?.version ?? 0 }
}
