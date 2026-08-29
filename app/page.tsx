"use client"

import { useEffect, useState } from "react"
import { StoreProvider, useStore } from "@/lib/store"
import { getStats } from "@/lib/selectors"
import { dayKey } from "@/lib/statistics"
import { FlowProvider } from "@/components/flow-controller"
import { SetupWizard } from "@/components/setup-wizard"
import { HomeView } from "@/components/home-view"
import { ScanView } from "@/components/scan-view"
import { OrdersView } from "@/components/orders-view"
import { HistoryView } from "@/components/history-view"
import { FilamentDryingView } from "@/components/filament-drying-view"
import { InventoryView } from "@/components/inventory-view"
import { StatisticsView } from "@/components/statistics-view"
import { SettingsView } from "@/components/settings-view"
import { MotionOverlay } from "@/components/motion-overlay"
import { BottomNav, type NavTab } from "@/components/bottom-nav"
import { NodeConnection } from "@/components/node-connection"

export default function Page() {
  return (
    <StoreProvider>
      <FlowProvider>
        <NodeConnection />
        <DailyStorageSnapshot />
        <AppShell />
      </FlowProvider>
    </StoreProvider>
  )
}

/**
 * Records one storage-fullness snapshot per calendar day so the Statistik
 * "storage usage over time" chart has real data points. Renders nothing; the
 * reducer dedupes to a single snapshot per day, so re-running is harmless.
 */
function DailyStorageSnapshot() {
  const { state, dispatch, ready } = useStore()
  useEffect(() => {
    if (!ready) return
    const day = dayKey()
    if ((state.storageSnapshots ?? []).some((s) => s.day === day)) return
    const { usedSlots, totalSlots, totalGrams } = getStats(state)
    if (totalSlots === 0) return
    dispatch({ type: "RECORD_STORAGE_SNAPSHOT", snapshot: { day, usedSlots, totalSlots, totalGrams } })
    // Re-check when the day rolls over or storage totals change materially.
  }, [ready, state, dispatch])
  return null
}

function AppShell() {
  const { state, ready, loadError } = useStore()
  const [tab, setTab] = useState<NavTab>("home")

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground">
        <span className="animate-pulse text-sm">Starting PAX…</span>
      </div>
    )
  }

  // The database could not be read. We must NOT show the setup wizard here —
  // doing so would risk overwriting the user's real saved data with an empty
  // setup. Show a recoverable error instead. The most common cause after an
  // update is the better-sqlite3 native module needing a rebuild.
  if (loadError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-2xl border border-border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">Could not load your data</h1>
          <p className="mt-2 text-sm text-muted-foreground text-pretty">
            Your saved setup is safe on disk, but the app could not read the database. This often happens after an
            update when the database module needs rebuilding on the server.
          </p>
          <p className="mt-3 rounded-lg bg-muted px-3 py-2 text-left font-mono text-xs text-muted-foreground break-words">
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Try again
          </button>
          <p className="mt-3 text-xs text-muted-foreground">
            {"If it persists, run "}
            <span className="font-mono">pnpm rebuild better-sqlite3</span>
            {" on the server and restart."}
          </p>
        </div>
      </div>
    )
  }

  if (!state.configured) {
    return <SetupWizard />
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {/* Home is a fixed dashboard that fills the viewport (no page scroll on
          desktop). Every other view is document-flow and can exceed the
          viewport, so it must scroll on desktop too — otherwise its lower cards
          get clipped. */}
      <main
        className={
          tab === "home"
            ? "flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden"
            : "flex min-h-0 flex-1 flex-col overflow-y-auto"
        }
      >
        {tab === "home" ? (
          <HomeView />
        ) : tab === "scan" ? (
          <ScanView />
        ) : tab === "orders" ? (
          <OrdersView />
        ) : tab === "history" ? (
          <HistoryView />
        ) : tab === "drying" ? (
          <FilamentDryingView />
        ) : tab === "inventory" ? (
          <InventoryView onGoHome={() => setTab("home")} />
        ) : tab === "statistics" ? (
          <StatisticsView />
        ) : (
          <SettingsView />
        )}
      </main>
      <BottomNav tab={tab} onChange={setTab} />
      <MotionOverlay />
    </div>
  )
}
