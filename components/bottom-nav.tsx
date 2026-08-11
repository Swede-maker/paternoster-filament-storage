"use client"

import { Home, Settings } from "lucide-react"
import { cn } from "@/lib/utils"
import { useStore } from "@/lib/store"

export type NavTab = "home" | "settings"

export function BottomNav({
  tab,
  onChange,
}: {
  tab: NavTab
  onChange: (t: NavTab) => void
}) {
  const { state } = useStore()

  const items: { id: NavTab; label: string; icon: typeof Home }[] = [
    { id: "home", label: "Home", icon: Home },
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
        {items.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              className={cn(
                "flex items-center gap-2 rounded-lg px-4 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-4 w-4" />
              {label}
              {active && <span className="ml-1 h-0.5 w-full" />}
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
