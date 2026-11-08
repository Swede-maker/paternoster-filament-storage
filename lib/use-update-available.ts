"use client"

import useSWR from "swr"
import type { UpdateStatus } from "@/lib/server/updater"

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<UpdateStatus>)

/**
 * Number of new changes waiting on GitHub, as last seen by the server's 6-hour
 * background check. Reading /api/update without ?check never contacts GitHub,
 * so polling it every 15 minutes is cheap.
 */
export function useUpdateAvailable(): number {
  const { data } = useSWR("/api/update", fetcher, {
    refreshInterval: 15 * 60_000,
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  })
  if (!data?.available) return 0
  if (data.phase === "requested" || data.phase === "running") return 0
  return data.behind ?? 0
}
