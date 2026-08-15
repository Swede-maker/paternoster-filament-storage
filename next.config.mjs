/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // These server-only packages must NOT be bundled by the server compiler —
  // they have to be required at runtime from node_modules:
  //  - better-sqlite3: native (.node) addon.
  //  - mqtt: Bambu Lab MQTT client; depends on Node built-ins (net/tls/ws) and
  //    breaks when bundled, crashing the /api/bambu route (surfaces in the UI as
  //    an opaque "Failed to fetch").
  //  - ws: WebSocket client used by the Pi relay routes; same Node built-in deps.
  serverExternalPackages: ["better-sqlite3", "mqtt", "ws"],
}

export default nextConfig
