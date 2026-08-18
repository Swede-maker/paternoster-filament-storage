/**
 * Next.js instrumentation: runs once when the server process starts.
 *
 * We use it to launch the Pi-side filament consumption poller, which keeps
 * subtracting filament from the printing spool as long as the server is up —
 * even when no phone or PC has the app open. See lib/server/consumption-poller.
 */
export async function register() {
  // Only the Node.js server runtime can reach printers and open the SQLite DB;
  // never run this in the Edge runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startConsumptionPoller } = await import("@/lib/server/consumption-poller")
    startConsumptionPoller()
  }
}
