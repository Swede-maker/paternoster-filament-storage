"use client"

import { useState } from "react"
import { StoreProvider, useStore } from "@/lib/store"
import { FlowProvider } from "@/components/flow-controller"
import { SetupWizard } from "@/components/setup-wizard"
import { HomeView } from "@/components/home-view"
import { OrdersView } from "@/components/orders-view"
import { HistoryView } from "@/components/history-view"
import { SettingsView } from "@/components/settings-view"
import { MotionOverlay } from "@/components/motion-overlay"
import { BottomNav, type NavTab } from "@/components/bottom-nav"
import { NodeConnection } from "@/components/node-connection"

export default function Page() {
  return (
    <StoreProvider>
      <FlowProvider>
        <NodeConnection />
        <AppShell />
      </FlowProvider>
    </StoreProvider>
  )
}

function AppShell() {
  const { state, ready } = useStore()
  const [tab, setTab] = useState<NavTab>("home")

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground">
        <span className="animate-pulse text-sm">Starting PAX…</span>
      </div>
    )
  }

  if (!state.configured) {
    return <SetupWizard />
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden">
        {tab === "home" ? (
          <HomeView />
        ) : tab === "orders" ? (
          <OrdersView />
        ) : tab === "history" ? (
          <HistoryView />
        ) : (
          <SettingsView />
        )}
      </main>
      <BottomNav tab={tab} onChange={setTab} />
      <MotionOverlay />
    </div>
  )
}
