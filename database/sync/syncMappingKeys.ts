/**
 * Device-local durable keys for explicit sync mappings.
 *
 * Why not normal content records:
 * - Content queries use type prefixes (agent-/dialog-/page-/meta-/…).
 * - Mapping rows must never appear in useMyContentItems / useUserData lists.
 * - Owner is always the device-local sentinel so replication authority returns [].
 *
 * Key shape: syncmap-local-{accountUserId}::{localDbKey}
 * The `::` separator keeps account + local key unambiguous for Level range scans.
 */

export const SYNC_MAPPING_KEY_PREFIX = "syncmap-local-";
export const SYNC_MAPPING_KEY_SEPARATOR = "::";
export const SYNC_MAPPING_RECORD_TYPE = "sync_mapping";

const normalizeSegment = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export function buildSyncMappingRecordKey(
  accountUserId: string,
  localDbKey: string
): string {
  const account = normalizeSegment(accountUserId);
  const local = normalizeSegment(localDbKey);
  if (!account) {
    throw new Error("syncMapping record key requires accountUserId");
  }
  if (!local) {
    throw new Error("syncMapping record key requires localDbKey");
  }
  if (account.includes(SYNC_MAPPING_KEY_SEPARATOR)) {
    throw new Error(
      `syncMapping accountUserId must not contain "${SYNC_MAPPING_KEY_SEPARATOR}"`
    );
  }
  return `${SYNC_MAPPING_KEY_PREFIX}${account}${SYNC_MAPPING_KEY_SEPARATOR}${local}`;
}

export function isSyncMappingRecordKey(dbKey: unknown): boolean {
  const key = normalizeSegment(dbKey);
  return key.startsWith(SYNC_MAPPING_KEY_PREFIX);
}

export function syncMappingRecordKeyRange(): { gte: string; lte: string } {
  const start = SYNC_MAPPING_KEY_PREFIX;
  return {
    gte: start,
    lte: `${start}\uffff`,
  };
}

export function parseSyncMappingRecordKey(
  dbKey: string
): { accountUserId: string; localDbKey: string } | null {
  const key = normalizeSegment(dbKey);
  if (!key.startsWith(SYNC_MAPPING_KEY_PREFIX)) return null;
  const rest = key.slice(SYNC_MAPPING_KEY_PREFIX.length);
  const sep = rest.indexOf(SYNC_MAPPING_KEY_SEPARATOR);
  if (sep <= 0) return null;
  const accountUserId = rest.slice(0, sep).trim();
  const localDbKey = rest.slice(sep + SYNC_MAPPING_KEY_SEPARATOR.length).trim();
  if (!accountUserId || !localDbKey) return null;
  return { accountUserId, localDbKey };
}
