/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // better-sqlite3 is a native (.node) addon and must not be bundled by the
  // server compiler — it has to be required at runtime from node_modules.
  serverExternalPackages: ["better-sqlite3"],
}

export default nextConfig
