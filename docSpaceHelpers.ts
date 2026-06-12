import { createSpaceKey } from "./create/space/spaceKeys";
import { readDbRecord, writeAgentRecord } from "./agentRecordHelpers";

export async function ensurePageAttachedToSpace(params: {
  baseUrl: string;
  userId: string;
  authToken: string;
  spaceId: string;
  contentKey: string;
  title: string;
  skillSummary?: Record<string, any> | null;
}) {
  const { baseUrl, userId, authToken, spaceId, contentKey, title, skillSummary } = params;
  const spaceKey = createSpaceKey.space(spaceId);
  const spaceRecord = await readDbRecord({
    dbKey: spaceKey,
    authToken,
    fetchImpl: fetch,
    serverUrl: baseUrl,
  });
  const now = Date.now();

  await writeAgentRecord({
    agentKey: spaceKey,
    authToken,
    fetchImpl: fetch,
    serverUrl: baseUrl,
    userId,
    record: {
      ...spaceRecord,
      contents: {
        ...(spaceRecord.contents ?? {}),
        [contentKey]: {
          ...(spaceRecord.contents?.[contentKey] ?? {}),
          title,
          type: "page",
          contentKey,
          ...(skillSummary !== undefined ? { skillSummary } : {}),
          updatedAt: now,
          createdAt: spaceRecord.contents?.[contentKey]?.createdAt ?? now,
        },
      },
      updatedAt: now,
    },
  });
}
