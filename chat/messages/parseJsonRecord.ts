/**
 * Shared pure JSON-record parser for chat tool / preview payloads.
 *
 * Tool message content, delete-confirm previews, activity status readers, and
 * similar surfaces all need "unknown → plain object or reject". Keep one
 * definition so arrays, empty strings, and invalid JSON cannot drift across
 * chat modules.
 *
 * Accepts either a JSON string or an already-parsed value. Uses dependency-free
 * core/isRecord so pure unit tests do not pull React/store modules.
 */

import { isRecord } from "../../core/isRecord";

/**
 * Parse unknown input as a plain JSON object (record).
 * Returns `undefined` for empty strings, invalid JSON, arrays, and primitives.
 */
export function asOptionalJsonRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return isRecord(value) ? value : undefined;
}
