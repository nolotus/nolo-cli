import { isRecord } from "./core/isRecord";
import { asOptionalTrimmedString } from "./core/optionalString";

/**
 * Shared pure CLI space helpers.
 *
 * Space list/filter paths (agent list, dialog list, table list) all need to:
 * - normalize free-form space input into a bare space id
 * - derive the LevelDB `space-…` key
 * - collect content keys from a space record's `contents` map
 *
 * Keep one definition so bare-id vs `space-` prefix vs URL handling cannot
 * drift across command modules. Dependency-free so pure unit tests do not
 * pull CLI command / network modules.
 */

/**
 * Normalize free-form space input to a bare space id (no `space-` prefix).
 *
 * Accepts bare ids (`abc`), prefixed keys (`space-abc`), or space page URLs
 * (`https://host/space/abc`, `https://host/space/space-abc`). Returns `""`
 * for empty input or URLs that are not `/space/<id>` paths.
 */
export function normalizeSpaceIdInput(rawInput: string): string {
  const raw = rawInput.trim();
  if (!raw) return "";

  let candidate = raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const match = new URL(raw).pathname.match(/^\/space\/([^/?#]+)/);
    if (!match?.[1]) return "";
    candidate = decodeURIComponent(match[1]);
  }

  return candidate.startsWith("space-")
    ? candidate.slice("space-".length)
    : candidate;
}

export function buildSpaceLookup(rawInput: string) {
  const spaceId = normalizeSpaceIdInput(rawInput);
  return {
    spaceId,
    spaceKey: spaceId ? `space-${spaceId}` : "",
  };
}

/**
 * Collect content keys referenced by a space record's `contents` map.
 *
 * Accepts both object-map shapes (entry key is the content key) and values
 * that carry an explicit `contentKey` field. Trims keys so whitespace cannot
 * produce false-negative membership checks.
 */
export function getSpaceContentKeys(spaceRecord: any): Set<string> {
  const keys = new Set<string>();
  const contents = spaceRecord?.contents;
  if (!contents || typeof contents !== "object") return keys;

  for (const [entryKey, value] of Object.entries(contents)) {
    const trimmedEntryKey = asOptionalTrimmedString(entryKey);
    if (trimmedEntryKey) {
      keys.add(trimmedEntryKey);
    }
    if (isRecord(value)) {
      const contentKey = asOptionalTrimmedString(value.contentKey);
      if (contentKey) {
        keys.add(contentKey);
      }
    }
  }
  return keys;
}
