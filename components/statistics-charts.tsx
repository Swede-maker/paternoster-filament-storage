"use client"

import { useMemo } from "react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"
import { Printer as PrinterIcon } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "./ui/chart"
import { parseDayKey, sumBy, totalGrams, type DayRange } from "@/lib/statistics"
import type { ConsumptionBucket, StorageSnapshot } from "@/lib/types"

/** Chart accent tokens, cycled for categorical series (material, printers). */
const CHART_VARS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
]

/** Format grams as kg with one decimal (matches the reference dashboard). */
export function kg(grams: number): string {
  return `${(grams / 1000).toFixed(1)} kg`
}

/** Short "Apr 20" style label for a YYYY-MM-DD day key. */
function shortDay(day: string): string {
  return parseDayKey(day).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** Shared empty state — logging is forward-only, so early on there's no data. */
function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-[220px] flex-col items-center justify-center gap-1 text-center">
      <p className="text-sm text-muted-foreground text-pretty">{message}</p>
    </div>
  )
}

const CARD = "border-border bg-card"

/* ------------------------------------------------------------------ */
/* Filament usage by material — donut with a legend/value table.       */
/* ------------------------------------------------------------------ */
export function UsageByMaterialCard({ buckets, rangeLabel }: { buckets: ConsumptionBucket[]; rangeLabel: string }) {
  const data = useMemo(
    () =>
      sumBy(buckets, (b) => b.material || "Unknown").map((d, i) => ({
        ...d,
        fill: CHART_VARS[i % CHART_VARS.length],
      })),
    [buckets],
  )
  const total = totalGrams(buckets)
  const config: ChartConfig = Object.fromEntries(
    data.map((d, i) => [d.key, { label: d.label, color: CHART_VARS[i % CHART_VARS.length] }]),
  )

  return (
    <Card className={CARD}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-wide">Filament usage by material</CardTitle>
        <p className="text-xs text-muted-foreground">{rangeLabel}</p>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <EmptyChart message="No consumption recorded yet for this range. Usage appears here as your printers extrude filament." />
        ) : (
          <div className="grid items-center gap-4 sm:grid-cols-2">
            <ChartContainer config={config} className="mx-auto aspect-square max-h-[240px]">
              <PieChart>
                <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
                <Pie data={data} dataKey="grams" nameKey="label" innerRadius="58%" outerRadius="86%" strokeWidth={2}>
                  {data.map((d) => (
                    <Cell key={d.key} fill={d.fill} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>
            <div>
              <ul className="space-y-2">
                {data.map((d) => (
                  <li key={d.key} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2 text-foreground">
                      <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: d.fill }} />
                      {d.label}
                    </span>
                    <span className="font-mono text-muted-foreground">{kg(d.grams)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm font-semibold text-foreground">
                <span>Total</span>
                <span className="font-mono">{kg(total)}</span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Filament usage by color — bars rendered in the real filament color. */
/* ------------------------------------------------------------------ */
export function UsageByColorCard({ buckets, rangeLabel }: { buckets: ConsumptionBucket[]; rangeLabel: string }) {
  const data = useMemo(() => {
    const grouped = sumBy(
      buckets,
      (b) => (b.color || "#888888").toLowerCase(),
      (b) => b.colorName || b.color || "Unknown",
    )
    return grouped.slice(0, 8).map((d) => ({ ...d, kg: d.grams / 1000 }))
  }, [buckets])

  return (
    <Card className={CARD}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-wide">Filament usage by color</CardTitle>
        <p className="text-xs text-muted-foreground">{rangeLabel}</p>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <EmptyChart message="No consumption recorded yet for this range." />
        ) : (
          <ChartContainer config={{ kg: { label: "kg" } }} className="h-[240px] w-full">
            <BarChart data={data} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize={11}
                interval={0}
                angle={data.length > 5 ? -30 : 0}
                textAnchor={data.length > 5 ? "end" : "middle"}
                height={data.length > 5 ? 48 : 24}
              />
              <YAxis tickLine={false} axisLine={false} width={48} fontSize={11} unit="kg" />
              <ChartTooltip
                content={<ChartTooltipContent nameKey="label" formatter={(v) => `${Number(v).toFixed(1)} kg`} />}
              />
              <Bar dataKey="kg" radius={[4, 4, 0, 0]} maxBarSize={56}>
                {data.map((d) => (
                  <Cell key={d.key} fill={d.key} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Printer usage — grams consumed per printer with a share bar.        */
/* ------------------------------------------------------------------ */
export function PrinterUsageCard({ buckets, rangeLabel }: { buckets: ConsumptionBucket[]; rangeLabel: string }) {
  const rows = useMemo(() => {
    const byPrinter = sumBy(
      buckets,
      (b) => b.printerId,
      (b) => b.printerName || "Printer",
    )
    const max = byPrinter[0]?.grams ?? 0
    // Distinct active days per printer, as a lightweight "jobs"-like signal.
    const days = new Map<string, Set<string>>()
    for (const b of buckets) {
      if (!days.has(b.printerId)) days.set(b.printerId, new Set())
      days.get(b.printerId)!.add(b.day)
    }
    return byPrinter.map((p) => ({ ...p, share: max > 0 ? p.grams / max : 0, days: days.get(p.key)?.size ?? 0 }))
  }, [buckets])

  return (
    <Card className={CARD}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-wide">Printer usage</CardTitle>
        <p className="text-xs text-muted-foreground">{rangeLabel}</p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyChart message="No printer activity recorded yet for this range." />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Printer</span>
              <span className="flex gap-6">
                <span>Used</span>
                <span>Days</span>
              </span>
            </div>
            {rows.map((p) => (
              <div key={p.key} className="flex items-center gap-3">
                <PrinterIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="w-24 shrink-0 truncate text-sm text-foreground">{p.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-[var(--color-chart-1)]"
                    style={{ width: `${Math.max(4, p.share * 100)}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right font-mono text-sm text-foreground">{kg(p.grams)}</span>
                <span className="w-8 shrink-0 text-right font-mono text-sm text-muted-foreground">{p.days}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Storage usage over time — area chart of used% from daily snapshots. */
/* ------------------------------------------------------------------ */
export function StorageOverTimeCard({
  snapshots,
  rangeLabel,
}: {
  snapshots: StorageSnapshot[]
  rangeLabel: string
}) {
  const data = useMemo(
    () =>
      snapshots.map((s) => ({
        day: s.day,
        used: s.totalSlots > 0 ? Math.round((s.usedSlots / s.totalSlots) * 100) : 0,
      })),
    [snapshots],
  )
  const avg =
    data.length > 0 ? Math.round(data.reduce((sum, d) => sum + d.used, 0) / data.length) : 0

  return (
    <Card className={CARD}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold uppercase tracking-wide">Storage usage over time</CardTitle>
        <p className="text-xs text-muted-foreground">{rangeLabel}</p>
      </CardHeader>
      <CardContent>
        {data.length < 2 ? (
          <EmptyChart message="Storage history builds up one snapshot per day. Check back after a few days of use." />
        ) : (
          <>
            <ChartContainer
              config={{ used: { label: "Slots used (%)", color: "var(--color-chart-1)" } }}
              className="h-[220px] w-full"
            >
              <AreaChart data={data} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillUsed" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  fontSize={11}
                  tickFormatter={shortDay}
                  minTickGap={24}
                />
                <YAxis
                tickLine={false}
                axisLine={false}
                width={44}
                fontSize={11}
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                unit="%"
              />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(l) => shortDay(String(l))}
                      formatter={(v) => `${v}% used`}
                    />
                  }
                />
                <Area
                  dataKey="used"
                  type="monotone"
                  stroke="var(--color-chart-1)"
                  strokeWidth={2}
                  fill="url(#fillUsed)"
                />
              </AreaChart>
            </ChartContainer>
            <div className="mt-3 rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">Average used</p>
              <p className="text-2xl font-semibold text-foreground">{avg}%</p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Storage by shelf (current) — horizontal fill bars + overall gauge.  */
/* ------------------------------------------------------------------ */
export interface ShelfUsage {
  label: string
  used: number
  total: number
}

export function StorageByShelfCard({
  shelves,
  usedSlots,
  totalSlots,
  options = [],
  selectedId,
  onSelect,
}: {
  shelves: ShelfUsage[]
  usedSlots: number
  totalSlots: number
  /** Storage units to choose between ("All storage" plus each node). */
  options?: { id: string; name: string }[]
  selectedId?: string
  onSelect?: (id: string) => void
}) {
  const overall = totalSlots > 0 ? Math.round((usedSlots / totalSlots) * 100) : 0
  // Only offer the picker when there's more than one storage unit to choose.
  const showPicker = options.length > 2 && onSelect

  return (
    <Card className={CARD}>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-sm font-semibold uppercase tracking-wide">Storage by shelf</CardTitle>
          <p className="text-xs text-muted-foreground">Current</p>
        </div>
        {showPicker && (
          <select
            aria-label="Storage unit"
            value={selectedId}
            onChange={(e) => onSelect?.(e.target.value)}
            className="max-w-[10rem] shrink-0 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
      </CardHeader>
      <CardContent>
        {shelves.length === 0 ? (
          <EmptyChart message="No shelves configured." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="space-y-2">
              {shelves.map((s) => {
                const pct = s.total > 0 ? Math.round((s.used / s.total) * 100) : 0
                return (
                  <div key={s.label} className="flex items-center gap-3 text-sm">
                    <span className="w-16 shrink-0 truncate text-muted-foreground">{s.label}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-secondary">
                      <div className="h-full rounded-full bg-[var(--color-chart-2)]" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-10 shrink-0 text-right font-mono text-muted-foreground">{pct}%</span>
                  </div>
                )
              })}
            </div>
            <div className="flex flex-col items-center gap-3">
              <div
                className="relative flex h-28 w-28 items-center justify-center rounded-full"
                style={{
                  background: `conic-gradient(var(--color-chart-2) ${overall * 3.6}deg, var(--color-secondary) 0deg)`,
                }}
              >
                <div className="flex h-20 w-20 flex-col items-center justify-center rounded-full bg-card">
                  <span className="text-xl font-semibold text-foreground">{overall}%</span>
                  <span className="text-[10px] text-muted-foreground">Overall</span>
                </div>
              </div>
              <div className="rounded-lg border border-border px-4 py-2 text-center">
                <p className="text-xs text-muted-foreground">Total slots</p>
                <p className="font-mono text-sm text-foreground">
                  {usedSlots} / {totalSlots}
                </p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
