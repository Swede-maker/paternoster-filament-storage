/**
 * Turn whatever an API put in its `error` / `message` field into display text.
 * Bambu's cloud sometimes answers with an object like `{ code, id, message }`
 * instead of a string, and rendering that object crashes React.
 */
export function errorText(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value
  if (value && typeof value === "object") {
    const o = value as { message?: unknown; error?: unknown; code?: unknown }
    const inner = typeof o.message === "string" && o.message.trim()
      ? o.message
      : typeof o.error === "string" && o.error.trim()
        ? o.error
        : ""
    if (inner) return o.code != null ? `${inner} (${String(o.code)})` : inner
    if (o.code != null) return `${fallback} (code ${String(o.code)})`
  }
  return fallback
}
