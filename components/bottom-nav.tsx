"use client"

import { Home, Settings, ShoppingCart, History, Droplets, Boxes, BarChart3, ScanLine, Printer } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"
import { dueReminders, lowStockParts } from "@/lib/selectors"
import type { TopArea } from "@/lib/types"

export type NavTab = "home" | "scan" | "orders" | "history" | "drying" | "inventory" | "statistics" | "settings"

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

  const filamentItems: { id: NavTab; label: string; icon: typeof Home; badge?: number; alert?: boolean }[] = [
    { id: "home", label: "Home", icon: Home },
    { id: "scan", label: "Scan", icon: ScanLine },
    { id: "orders", label: "Orders", icon: ShoppingCart, badge: orderCount || undefined },
    { id: "history", label: "History", icon: History },
    { id: "drying", label: "Filament Drying", icon: Droplets, badge: dueCount || undefined, alert: dueCount > 0 },
    { id: "inventory", label: "All Filament In Storage", icon: Boxes },
    { id: "statistics", label: "Statistik", icon: BarChart3 },
    { id: "settings", label: "Settings", icon: Settings },
  ]

  // Hardware area: no printers, so no scan/drying/statistik. The inventory tab
  // becomes "All Hardware", and low-stock parts get an alert badge on it.
  const hardwareItems: typeof filamentItems = [
    { id: "home", label: "Home", icon: Home },
    { id: "inventory", label: "All Hardware In Storage", icon: Boxes, badge: lowCount || undefined, alert: lowCount > 0 },
    { id: "orders", label: "Orders", icon: ShoppingCart, badge: hwOrderCount || undefined },
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
        {items.map(({ id, label, icon: Icon, badge, alert }) => {
          const active = tab === id
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
                {badge ? (
                  <span
                    className={cn(
                      "absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none",
                      alert ? "bg-warning text-background" : "bg-primary text-primary-foreground",
                    )}
                  >
                    {badge}
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
