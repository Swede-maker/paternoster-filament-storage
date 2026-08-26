/**
 * Set LOW_MEM=1 to build on a memory-constrained machine (a Raspberry Pi).
 *
 * MEASURED, so expectations stay realistic: on a 2-core box, a cold build of this
 * project peaks at ~1530 MB, and LOW_MEM only brings that to ~1510 MB. It is a
 * rounding error, NOT a fix.
 *
 * The reason is that Next.js 16 builds with Turbopack, which is Rust: its peak
 * lives outside the V8 heap, so neither `--max-old-space-size` nor the worker
 * count moves it much. There is currently no config option that meaningfully
 * lowers a Turbopack build's ceiling (`turbopackMemoryEviction` looks like one
 * but is documented as dev-session only).
 *
 * So on a 2 GB Pi the reliable options are swap, or building elsewhere and
 * copying `.next` over. See "Building on the Pi" in the README.
 */
const lowMem = process.env.LOW_MEM === "1"

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  // NOTE: no `eslint` key. Next.js 16 removed it from next.config and rejects it
  // as an unrecognized option — `next build` no longer runs ESLint at all, so
  // there is nothing left to opt out of. Linting lives in `pnpm lint`.
  images: {
    unoptimized: true,
  },
  // Source maps exist to symbolicate stack traces in browser devtools, and this
  // app is served on a LAN to its owner, who has the source checked out next to
  // it. Skipping them is a small, free saving in every build.
  productionBrowserSourceMaps: false,
  enablePrerenderSourceMaps: false,
  // These server-only packages must NOT be bundled by the server compiler —
  // they have to be required at runtime from node_modules:
  //  - better-sqlite3: native (.node) addon.
  //  - mqtt: Bambu Lab MQTT client; depends on Node built-ins (net/tls/ws) and
  //    breaks when bundled, crashing the /api/bambu route (surfaces in the UI as
  //    an opaque "Failed to fetch").
  //  - ws: WebSocket client used by the Pi relay routes; same Node built-in deps.
  serverExternalPackages: ["better-sqlite3", "mqtt", "ws"],
  experimental: {
    serverSourceMaps: false,
    // Runtime, not build: the server otherwise eagerly loads every route's
    // modules at startup to make the first request faster. On a Pi that startup
    // spike competes with the carousel agent for RAM, and this app has one page
    // and a handful of tiny API routes, so there is very little to gain.
    //
    // This one is worth keeping regardless of build machine — it lowers the
    // RUNNING app's footprint, which is where the Pi actually lives.
    preloadEntriesOnStart: false,
    ...(lowMem
      ? {
          // Caps compiler workers at one instead of one per core. Measured at
          // roughly 6 MB on this project — kept because it costs nothing and
          // scales with project size, not because it rescues a 2 GB Pi.
          cpus: 1,
        }
      : {}),
  },
}

export default nextConfig
