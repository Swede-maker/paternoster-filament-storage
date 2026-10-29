"use client"

import {
  Home,
  Settings,
  ShoppingCart,
  History,
  Droplets,
  Boxes,
  BarChart3,
  ScanLine,
  Printer,
  Lock,
  ClipboardList,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"
import { useFlow } from "./flow-controller"
import { dueReminders, lowStockParts } from "@/lib/selectors"
import type { TopArea } from "@/lib/types"
import { getDryers, timerStatus } from "@/lib/dryers"
import { useEffect, useState } from "react"

type NavBadge = { count: number; tone: "warning" | "info" | "primary" }
type NavItem = { id: NavTab; label: string; icon: typeof Home; badges?: NavBadge[] }

export type NavTab =
  | "home"
  | "scan"
  | "orders"
  | "history"
  | "drying"
  | "inventory"
  | "statistics"
  | "locked"
  | "picking"
  | "settings"

export function BottomNav({
  tab,
  onChange,
  area = "filament",
}: {
  tab: NavTab
  onChange: (t: NavTab) => void
  /** Which area's tab set to render. Hardware drops printers/scan/drying/stats;
      the printers area is self-contained and shows a single Home entry. */
  area?: TopArea
}) {
  const { state } = useStore()

  const orderCount = (state.settings.orders ?? []).length
  const hwOrderCount = (state.hardwareOrders ?? []).length
  // Surface overdue dry reminders as an alert badge on the Filament Drying tab —
  // like the Orders badge, but colored as an alert since it's time-sensitive.
  const dueCount = dueReminders(state).length
  // Hardware low-stock count drives an alert badge on the hardware nav.
  const lowCount = lowStockParts(state).length
  const lockedCount = Object.values(state.parts ?? {}).filter((p) => p.lockedSlot).length
  // Lists that still have something left to pick.
  const openListCount = (state.hwPickLists ?? []).filter((l) =>
    l.lines.some((ln) => ln.picked < ln.requested),
  ).length

  // A queue assembled from another tab only runs from Home, so flag it there.
  const { inItems, outItems } = useFlow()
  const queuedCount = inItems.length + outItems.length
  // Spools picked out for a dryer wait for "They're in" on the Drying tab.
  const dryers = getDryers(state)
  const awaitingLoadCount = dryers.reduce((n, d) => n + (d.awaitingLoad?.length ?? 0), 0)
  const dryingAlertCount = dueCount + awaitingLoadCount
  // Re-check timers every 30 s so the badge appears when one finishes.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  const timersDoneCount = dryers.reduce(
    (n, d) => n + d.chambers.filter((c) => c.spoolIds.length > 0 && timerStatus(c.timer, now) === "done").length,
    0,
  )

  const filamentItems: NavItem[] = [
    { id: "home", label: "Home", icon: Home, badges: [{ count: queuedCount, tone: "warning" }] },
    { id: "scan", label: "Scan", icon: ScanLine },
    { id: "orders", label: "Orders", icon: ShoppingCart, badges: [{ count: orderCount, tone: "primary" }] },
    { id: "history", label: "History", icon: History },
    {
      id: "drying",
      label: "Filament Drying",
      icon: Droplets,
      badges: [
        { count: dryingAlertCount, tone: "warning" },
        { count: timersDoneCount, tone: "info" },
      ],
    },
    { id: "inventory", label: "All Filament In Storage", icon: Boxes },
    { id: "statistics", label: "Statistik", icon: BarChart3 },
    { id: "settings", label: "Settings", icon: Settings },
  ]

  // Hardware area: no printers, so no scan/drying/statistik. The inventory tab
  // becomes "All Hardware", and low-stock parts get an alert badge on it.
  const hardwareItems: typeof filamentItems = [
    { id: "home", label: "Home", icon: Home },
    { id: "inventory", label: "All Hardware In Storage", icon: Boxes, badges: [{ count: lowCount, tone: "warning" }] },
    { id: "orders", label: "Orders", icon: ShoppingCart, badges: [{ count: hwOrderCount, tone: "primary" }] },
    { id: "locked", label: "Locked slots", icon: Lock, badges: [{ count: lockedCount, tone: "primary" }] },
    { id: "picking", label: "Picking lists", icon: ClipboardList, badges: [{ count: openListCount, tone: "primary" }] },
    { id: "settings", label: "Settings", icon: Settings },
  ]

  // Printers is a self-contained section with its own in-view navigation, so the
  // footer only carries a single Home entry for consistency (status + version).
  const printerItems: typeof filamentItems = [{ id: "home", label: "Printers", icon: Printer }]

  const items = area === "hardware" ? hardwareItems : area === "printers" ? printerItems : filamentItems

  // The system is "online" once every linked node is homed and none is homing.
  const anyHoming = state.nodes.some((n) => n.machine.status === "homing")
  const online = state.nodes.every((n) => n.machine.homed) && !anyHoming

  return (
    <footer className="flex h-14 shrink-0 items-center gap-2 border-t border-border bg-panel px-3 sm:px-4">
      {/* System status. Keep just the dot on phones so the tab row has room;
          show the label from sm up. */}
      <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("h-2 w-2 rounded-full", online ? "bg-success" : "bg-warning")} />
        <span className="hidden sm:inline">
          {online ? "System Online" : anyHoming ? "Homing…" : "Not Homed"}
        </span>
      </div>

      {/* Tabs. Horizontally scrollable so every tab (incl. Settings) is always
          reachable on a narrow phone — swipe left/right. Scrollbar is hidden. */}
      <nav
        className="flex flex-1 items-center justify-start gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] sm:justify-center [&::-webkit-scrollbar]:hidden"
        aria-label="Primary"
      >
        {items.map(({ id, label, icon: Icon, badges }) => {
          const active = tab === id
          const shown = (badges ?? []).filter((b) => b.count > 0)
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className={cn(
                "relative flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
                active ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              <span className="relative">
                <Icon className="h-4 w-4" />
                {shown.length > 0 ? (
                  <span className="absolute -top-2 left-2 flex items-center gap-0.5">
                    {shown.map((b) => (
                      <span
                        key={b.tone}
                        className={cn(
                          "flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none",
                          b.tone === "warning" && "bg-warning text-background",
                          b.tone === "info" && "bg-info text-background",
                          b.tone === "primary" && "bg-primary text-primary-foreground",
                        )}
                      >
                        {b.count}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              {label}
            </button>
          )
        })}
      </nav>

      {/* Version footnote — desktop only; it just wastes width on a phone. */}
      <div className="hidden shrink-0 text-xs text-muted-foreground lg:block">PAX Storage System</div>
    </footer>
  )
}
