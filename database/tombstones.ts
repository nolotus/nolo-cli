type TimestampRecord = Record<string, unknown> & {
  meta?: Record<string, unknown>;
};

export const TOMBSTONE_DETAIL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const readRecord = (value: unknown): TimestampRecord | null =>
  isRecord(value) ? value : null;

const parseTimestamp = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && timestamp > 0) {
      return timestamp;
    }
  }
  return 0;
};

export const getRecordTimestamp = (record: unknown): number => {
  const value = readRecord(record);
  if (!value) return 0;

  const candidates = [
    value.updatedAt,
    value.updated_at,
    value.createdAt,
    value.created,
    isRecord(value.meta) ? value.meta.createdAt : undefined,
  ];

  for (const candidate of candidates) {
    const timestamp = parseTimestamp(candidate);
    if (timestamp > 0) return timestamp;
  }

  return 0;
};

export const getTombstoneTimestamp = (record: unknown): number => {
  const value = readRecord(record);
  if (!value) return 0;
  return parseTimestamp(value.deletedAt) || getRecordTimestamp(value);
};

export const getRestoreTimestamp = (record: unknown): number => {
  const value = readRecord(record);
  if (!value) return 0;
  return parseTimestamp(value.restoredAt);
};

export const isTombstoneRecord = (record: unknown): boolean => {
  const value = readRecord(record);
  if (!value) return false;
  const deletedAt = value.deletedAt;
  if (typeof deletedAt === "string") return deletedAt.trim().length > 0;
  return Boolean(deletedAt);
};

export const isRestoredAfterTombstone = (
  activeRecord: unknown,
  tombstoneRecord: unknown
): boolean => {
  if (isTombstoneRecord(activeRecord) || !isTombstoneRecord(tombstoneRecord)) {
    return false;
  }
  const restoreTs = getRestoreTimestamp(activeRecord);
  const tombstoneTs = getTombstoneTimestamp(tombstoneRecord);
  return restoreTs > 0 && tombstoneTs > 0 && restoreTs > tombstoneTs;
};

export const shouldReplaceWithNextRecord = (
  nextRecord: unknown,
  currentRecord: unknown
): boolean => {
  const nextIsTombstone = isTombstoneRecord(nextRecord);
  const currentIsTombstone = isTombstoneRecord(currentRecord);

  if (currentIsTombstone && !nextIsTombstone) {
    return isRestoredAfterTombstone(nextRecord, currentRecord);
  }

  if (nextIsTombstone && !currentIsTombstone) {
    return !isRestoredAfterTombstone(currentRecord, nextRecord);
  }

  const nextTs = nextIsTombstone
    ? getTombstoneTimestamp(nextRecord)
    : getRecordTimestamp(nextRecord);
  const currentTs = currentIsTombstone
    ? getTombstoneTimestamp(currentRecord)
    : getRecordTimestamp(currentRecord);

  if (nextTs !== currentTs) return nextTs > currentTs;
  return nextIsTombstone && !currentIsTombstone;
};

export const buildTombstoneRecord = <T extends Record<string, unknown>>(
  record: T,
  nowIso: string
): Omit<T, "restoredAt"> & { deletedAt: string; updatedAt: string } => {
  const { restoredAt: _restoredAt, ...baseRecord } = record;
  return {
    ...baseRecord,
    deletedAt: nowIso,
    updatedAt: nowIso,
  };
};

export const buildRestorePatch = (nowIso: string): {
  deletedAt: null;
  restoredAt: string;
  updatedAt: string;
} => ({
  deletedAt: null,
  restoredAt: nowIso,
  updatedAt: nowIso,
});

const COMPACT_TOMBSTONE_FIELDS = [
  "dbKey",
  "id",
  "contentKey",
  "appKey",
  "appId",
  "type",
  "userId",
  "deletedAt",
  "updatedAt",
  "createdAt",
  "created",
  "title",
  "name",
  "displayName",
  "spaceId",
  "serverOrigin",
] as const;

export const compactTombstoneRecord = (
  record: Record<string, unknown>
): Record<string, unknown> => {
  if (!isTombstoneRecord(record)) return record;
  const compacted: Record<string, unknown> = {};
  for (const field of COMPACT_TOMBSTONE_FIELDS) {
    if (field in record) compacted[field] = record[field];
  }
  return compacted;
};

export const shouldCompactTombstoneRecord = (
  record: unknown,
  nowMs: number = Date.now(),
  retentionMs: number = TOMBSTONE_DETAIL_RETENTION_MS
): boolean => {
  if (!isTombstoneRecord(record)) return false;
  const tombstoneTs = getTombstoneTimestamp(record);
  return tombstoneTs > 0 && nowMs - tombstoneTs >= retentionMs;
};

export const prepareTombstoneRecordForCache = (
  record: Record<string, unknown>,
  nowMs: number = Date.now()
): Record<string, unknown> =>
  shouldCompactTombstoneRecord(record, nowMs)
    ? compactTombstoneRecord(record)
    : record;

export const canPhysicallyPurgeTombstoneRecord = (
  record: unknown,
  options: { explicitPurge?: boolean } = {}
): boolean => isTombstoneRecord(record) && options.explicitPurge === true;
