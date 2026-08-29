// Web NFC (NDEFReader) helpers.
//
// IMPORTANT platform reality: Web NFC only exists in Chrome/Edge on Android over
// HTTPS. iOS Safari (and every iOS browser) has no Web NFC at all, and desktop
// browsers don't expose it either. So NFC is a bonus fast-path; the app always
// offers QR scanning (camera) and manual entry so every device can participate.
//
// We identify an NFC tag by its hardware `serialNumber`, which is stable, unique,
// and available on read without writing anything to the tag. The binding
// (id → spool/shelf/printer) lives in the synced app document, so a tag can be
// re-bound or erased any number of times without touching the physical tag.

/** Minimal shape of the Web NFC reader we rely on. */
interface NDEFReadingEventLike {
  serialNumber?: string
}

/** True only where the browser actually exposes Web NFC (Android Chrome/Edge). */
export function nfcSupported(): boolean {
  return typeof window !== "undefined" && "NDEFReader" in window
}

export interface NfcScan {
  /** The tag's hardware serial number — used as its stable id. */
  serialNumber: string
}

/**
 * Scan for a single NFC tag. Resolves with the first tag's serial number, or
 * rejects if NFC is unsupported, permission is denied, or the signal aborts.
 * Pass an AbortSignal to stop scanning when the dialog closes.
 */
export function scanNfcOnce(signal?: AbortSignal): Promise<NfcScan> {
  return new Promise<NfcScan>((resolve, reject) => {
    if (!nfcSupported()) {
      reject(new Error("unsupported"))
      return
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reader = new (window as any).NDEFReader()
      let settled = false
      const onReading = (event: NDEFReadingEventLike) => {
        if (settled) return
        const serial = (event.serialNumber || "").trim()
        if (!serial) return
        settled = true
        resolve({ serialNumber: serial })
      }
      reader.addEventListener?.("reading", onReading)
      reader.onreading = onReading
      reader.onreadingerror = () => {
        if (!settled) {
          settled = true
          reject(new Error("read-error"))
        }
      }
      reader.scan({ signal }).catch((e: unknown) => {
        if (!settled) {
          settled = true
          reject(e instanceof Error ? e : new Error("scan-failed"))
        }
      })
      signal?.addEventListener("abort", () => {
        if (!settled) {
          settled = true
          reject(new DOMException("aborted", "AbortError"))
        }
      })
    } catch (e) {
      reject(e instanceof Error ? e : new Error("scan-failed"))
    }
  })
}
