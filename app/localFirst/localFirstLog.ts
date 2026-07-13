/**
 * Structured local-first diagnostics for desktop/RN verification.
 * Secrets must never be passed in `data` (use refs/flags only).
 *
 * Desktop mirrors console.* into the diagnostic file log.
 */

export type LocalFirstLogData = Record<
  string,
  string | number | boolean | null | undefined
>;

const PREFIX = "[localFirst]";

export function localFirstLog(
  event: string,
  data?: LocalFirstLogData,
): void {
  const safeEvent = event.trim() || "unknown";
  if (data && Object.keys(data).length > 0) {
    // Single-line JSON-ish for easy rg in diagnostic logs
    try {
      console.info(PREFIX, safeEvent, JSON.stringify(data));
    } catch {
      console.info(PREFIX, safeEvent, data);
    }
    return;
  }
  console.info(PREFIX, safeEvent);
}
