// QR code generation + printing, built on the already-installed @zxing writer.
// Client-only (touches the DOM). QR is the universal fallback for devices
// without Web NFC (notably iPhones): the same tag id is encoded into a code the
// camera can read anywhere.

import { BrowserQRCodeSvgWriter } from "@zxing/browser"

/**
 * Render a QR code for `contents` as an SVG markup string. Black modules on a
 * transparent ground; callers place it on a white card. Returns null if the
 * writer fails (e.g. contents too long).
 */
export function qrSvgMarkup(contents: string, size = 240): string | null {
  try {
    const writer = new BrowserQRCodeSvgWriter()
    const svg = writer.write(contents, size, size)
    // The writer omits width/height styling; make it scale to its container.
    svg.setAttribute("width", "100%")
    svg.setAttribute("height", "100%")
    svg.setAttribute("shape-rendering", "crispEdges")
    return svg.outerHTML
  } catch {
    return null
  }
}

/** One printable QR label: the encoded contents plus its human-readable text. */
export interface QrLabelSpec {
  contents: string
  caption: string
  sub?: string
}

/** Physical print sizes (edge length of the QR square, in millimeters). */
export const QR_PRINT_SIZES = [
  { id: "sm", label: "Small", mm: 25 },
  { id: "md", label: "Medium", mm: 40 },
  { id: "lg", label: "Large", mm: 60 },
] as const

export type QrPrintSizeId = (typeof QR_PRINT_SIZES)[number]["id"]

export const DEFAULT_QR_SIZE_MM = 40

/**
 * Open the browser print dialog with one or more QR labels laid out on the
 * page. `sizeMm` sets the physical edge length of each QR square (printed in
 * real millimeters, so it comes out the requested size regardless of DPI).
 * Multiple labels flow and wrap so a batch prints on as few pages as possible.
 */
export function printQrLabels(labels: QrLabelSpec[], opts?: { sizeMm?: number }): void {
  const sizeMm = opts?.sizeMm ?? DEFAULT_QR_SIZE_MM
  const items: { markup: string; caption: string; sub?: string }[] = []
  for (const l of labels) {
    const markup = qrSvgMarkup(l.contents, 320)
    if (markup) items.push({ markup, caption: l.caption, sub: l.sub })
  }
  if (items.length === 0) return

  const win = window.open("", "_blank", "width=520,height=680")
  if (!win) return
  // Caption/padding scale gently with the QR size so small labels stay compact.
  const capPt = Math.max(8, Math.round(sizeMm * 0.28))
  const subPt = Math.max(7, Math.round(sizeMm * 0.2))
  const pad = Math.max(6, Math.round(sizeMm * 0.18))

  const labelsHtml = items
    .map(
      (it) => `
    <div class="label">
      <div class="qr">${it.markup}</div>
      <div class="cap">${escapeHtml(it.caption)}</div>
      ${it.sub ? `<div class="sub">${escapeHtml(it.sub)}</div>` : ""}
    </div>`,
    )
    .join("")

  win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(items[0].caption)}${items.length > 1 ? ` (+${items.length - 1})` : ""}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    display: flex; flex-wrap: wrap; align-content: flex-start;
    gap: 8mm; justify-content: center;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: #fff; color: #111; padding: 10mm;
  }
  .label {
    display: flex; flex-direction: column; align-items: center; gap: ${Math.round(pad / 2)}px;
    border: 1.5px solid #111; border-radius: 12px; padding: ${pad}px;
    page-break-inside: avoid; break-inside: avoid;
  }
  .qr { width: ${sizeMm}mm; height: ${sizeMm}mm; }
  .cap { font-size: ${capPt}pt; font-weight: 700; text-align: center; text-wrap: balance; }
  .sub { font-size: ${subPt}pt; color: #555; text-align: center; }
  @media print { .label { border-color: #000; } }
</style>
</head>
<body>
  ${labelsHtml}
  <script>
    window.onload = function () { setTimeout(function () { window.print(); }, 150); };
  </script>
</body>
</html>`)
  win.document.close()
}

/** Convenience wrapper for printing a single label. */
export function printQrLabel(contents: string, caption: string, sub?: string, opts?: { sizeMm?: number }): void {
  printQrLabels([{ contents, caption, sub }], opts)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&#39;"
    }
  })
}
