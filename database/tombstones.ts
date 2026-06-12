export const getRecordTimestamp = (record: any): number => {
  if (!record || typeof record !== "object") return 0;

  const candidates = [
    record.updatedAt,
    record.updated_at,
    record.createdAt,
    record.created,
    record?.meta?.createdAt,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim()) {
      const timestamp = Date.parse(candidate);
      if (Number.isFinite(timestamp) && timestamp > 0) {
        return timestamp;
      }
    }
  }

  return 0;
};

export const isTombstoneRecord = (record: any): boolean => {
  if (!record || typeof record !== "object") return false;
  const deletedAt = record.deletedAt;
  if (typeof deletedAt === "string") return deletedAt.trim().length > 0;
  return Boolean(deletedAt);
};

export const shouldReplaceWithNextRecord = (
  nextRecord: any,
  currentRecord: any
): boolean => {
  const nextTs = getRecordTimestamp(nextRecord);
  const currentTs = getRecordTimestamp(currentRecord);

  if (nextTs !== currentTs) return nextTs > currentTs;
  return isTombstoneRecord(nextRecord) && !isTombstoneRecord(currentRecord);
};

export const buildTombstoneRecord = <T extends Record<string, any>>(
  record: T,
  nowIso: string
): T & { deletedAt: string; updatedAt: string } => ({
  ...record,
  deletedAt: nowIso,
  updatedAt: nowIso,
});
