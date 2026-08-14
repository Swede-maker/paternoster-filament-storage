"use client"

import { Home, Settings, ShoppingCart, History } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"
import { dueReminders } from "@/lib/selectors"

export type NavTab = "home" | "orders" | "history" | "settings"

export function BottomNav({
  tab,
  onChange,
}: {
  tab: NavTab
  onChange: (t: NavTab) => void
}) {
  const { state } = useStore()

  const orderCount = (state.settings.orders ?? []).length
  // Surface overdue dry reminders as an alert badge on the History tab.
  const dueCount = dueReminders(state).length

  const items: { id: NavTab; label: string; icon: typeof Home; badge?: number; alert?: boolean }[] = [
    { id: "home", label: "Home", icon: Home },
    { id: "orders", label: "Orders", icon: ShoppingCart, badge: orderCount || undefined },
    { id: "history", label: "History", icon: History, badge: dueCount || undefined, alert: dueCount > 0 },
    { id: "settings", label: "Settings", icon: Settings },
  ]

  // The system is "online" once every linked node is homed and none is homing.
  const anyHoming = state.nodes.some((n) => n.machine.status === "homing")
  const online = state.nodes.every((n) => n.machine.homed) && !anyHoming

  return (
    <footer className="flex h-14 shrink-0 items-center justify-between border-t border-border bg-panel px-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            "h-2 w-2 rounded-full",
            online ? "bg-success" : "bg-warning",
          )}
        />
        {online ? "System Online" : anyHoming ? "Homing…" : "Not Homed"}
      </div>

      <nav className="flex items-center gap-1">
        {items.map(({ id, label, icon: Icon, badge, alert }) => {
          const active = tab === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className={cn(
                "relative flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              <span className="relative">
                <Icon className="h-4 w-4" />
                {badge ? (
                  <span
                    className={cn(
                      "absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none",
                      alert
                        ? "bg-warning text-background"
                        : "bg-primary text-primary-foreground",
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

      <div className="text-xs text-muted-foreground">
        PAX Filament System v1.0.0
      </div>
    </footer>
  )
}
