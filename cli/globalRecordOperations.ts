import {
  deleteDbRecord,
  queryUserRecords,
  readDbRecord,
} from "./agentRecordHelpers";
import { isTombstoneRecord } from "../database/tombstones";
import { mergeAndDedupUserData } from "../database/userDataMerge";
import type { CliFetchImpl } from "./cliFetch";

export type GlobalRecordFailure = {
  serverUrl: string;
  error: string;
};

export type GlobalDeleteResult = {
  serverUrl: string;
  dbKey?: string;
  ok: boolean;
  result?: any;
  error?: string;
};

export type GlobalRecordTarget = {
  serverUrl: string;
  authToken?: string;
};

export type DbDeleteOptions = {
  type?: "single" | "table" | "messages";
};

export async function listUserRecordsFromServers(args: {
  authToken: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  limit?: number;
  serverUrls: string[];
  summary?: boolean;
  type: string | string[];
  userId: string;
  label?: string;
}): Promise<{ records: any[]; failures: GlobalRecordFailure[] }> {
  const remoteResults: Array<{ data: { data: any[] } }> = [];
  const failures: GlobalRecordFailure[] = [];

  const promises = args.serverUrls.map(async (serverUrl) => {
    try {
      const records = await queryUserRecords({
        authToken: args.authToken,
        fallbackFetchImpl: args.fallbackFetchImpl,
        fetchImpl: args.fetchImpl,
        includeDeleted: true,
        limit: args.limit,
        serverUrl,
        summary: args.summary,
        type: args.type,
        userId: args.userId,
      });
      return { ok: true, serverUrl, records };
    } catch (error) {
      return {
        ok: false,
        serverUrl,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const results = await Promise.all(promises);

  for (const res of results) {
    if (res.ok) {
      remoteResults.push({
        data: {
          data: res.records!.map((record: any) => ({
            ...record,
            serverOrigin:
              typeof record?.serverOrigin === "string" && record.serverOrigin.trim()
                ? record.serverOrigin
                : res.serverUrl,
          })),
        },
      });
    } else {
      failures.push({
        serverUrl: res.serverUrl,
        error: res.error!,
      });
    }
  }

  if (remoteResults.length === 0 && failures.length > 0) {
    const label = args.label ?? "record query";
    throw new Error(
      `${label} failed on all candidate servers: ${failures
        .map((failure) => `${failure.serverUrl}: ${failure.error}`)
        .join("; ")}`
    );
  }

  const merged = mergeAndDedupUserData([], remoteResults, { includeDeleted: true });
  return {
    records: merged.filter((record) => !isTombstoneRecord(record)),
    failures,
  };
}

export async function readDbRecordFromServers(args: {
  authToken: string;
  dbKey: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  includeDeleted?: boolean;
  serverUrls: string[];
  label?: string;
}) {
  const failures: GlobalRecordFailure[] = [];
  for (const serverUrl of args.serverUrls) {
    try {
      const record = await readDbRecord({
        authToken: args.authToken,
        dbKey: args.dbKey,
        fallbackFetchImpl: args.fallbackFetchImpl,
        fetchImpl: args.fetchImpl,
        includeDeleted: args.includeDeleted,
        serverUrl,
      });
      return { record, serverUrl, failures };
    } catch (error) {
      failures.push({
        serverUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const label = args.label ?? `record ${args.dbKey}`;
  throw new Error(
    `${label} is unreadable on all candidate servers: ${failures
      .map((failure) => `${failure.serverUrl}: ${failure.error}`)
      .join("; ")}`
  );
}

export async function readDbRecordVersionsFromServers(args: {
  authToken: string;
  dbKey: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrls: string[];
}) {
  const records: any[] = [];
  const failures: GlobalRecordFailure[] = [];

  const promises = args.serverUrls.map(async (serverUrl) => {
    try {
      const record = await readDbRecord({
        authToken: args.authToken,
        dbKey: args.dbKey,
        fallbackFetchImpl: args.fallbackFetchImpl,
        fetchImpl: args.fetchImpl,
        includeDeleted: true,
        serverUrl,
      });
      return { ok: true, serverUrl, record };
    } catch (error) {
      return {
        ok: false,
        serverUrl,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const results = await Promise.all(promises);

  for (const res of results) {
    if (res.ok) {
      const record = res.record;
      records.push({
        ...record,
        dbKey: typeof record?.dbKey === "string" && record.dbKey.trim()
          ? record.dbKey
          : args.dbKey,
        serverOrigin:
          typeof record?.serverOrigin === "string" && record.serverOrigin.trim()
            ? record.serverOrigin
            : res.serverUrl,
      });
    } else {
      failures.push({
        serverUrl: res.serverUrl,
        error: res.error!,
      });
    }
  }
  return { records, failures };
}

export async function readLiveDbRecordAfterTombstoneMerge(args: {
  authToken: string;
  dbKey: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrls: string[];
  label?: string;
}): Promise<any> {
  const result = await readDbRecordVersionsFromServers(args);
  const merged = mergeAndDedupUserData(
    [],
    [{ data: { data: result.records } }],
    { includeDeleted: true }
  );
  const record = merged.find((item) => item?.dbKey === args.dbKey);
  if (record && !isTombstoneRecord(record)) {
    return {
      record,
      serverUrl: typeof record.serverOrigin === "string" ? record.serverOrigin : "",
      failures: result.failures,
    };
  }

  const label = args.label ?? `record ${args.dbKey}`;
  const failureText = result.failures.length
    ? ` Failures: ${result.failures
        .map((failure) => `${failure.serverUrl}: ${failure.error}`)
        .join("; ")}`
    : "";
  throw new Error(`${label} is deleted or unreadable after global tombstone merge.${failureText}`);
}

export async function recordExistsAfterTombstoneMerge(args: {
  authToken: string;
  dbKey: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrls: string[];
}) {
  try {
    await readLiveDbRecordAfterTombstoneMerge(args);
    return true;
  } catch {
    return false;
  }
}

export async function deleteDbRecordOnServers(args: {
  authToken: string;
  dbKey: string;
  deleteOptions?: DbDeleteOptions;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrls: string[];
}): Promise<GlobalDeleteResult[]> {
  return deleteDbRecordOnTargets({
    ...args,
    targets: args.serverUrls.map((serverUrl) => ({ serverUrl })),
  });
}

export async function deleteDbRecordOnTargets(args: {
  authToken: string;
  dbKey: string;
  deleteOptions?: DbDeleteOptions;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  targets: GlobalRecordTarget[];
}): Promise<GlobalDeleteResult[]> {
  const promises = args.targets.map(async (target) => {
    try {
      const result = await deleteDbRecord({
        authToken: target.authToken ?? args.authToken,
        dbKey: args.dbKey,
        deleteOptions: args.deleteOptions,
        fallbackFetchImpl: args.fallbackFetchImpl,
        fetchImpl: args.fetchImpl,
        serverUrl: target.serverUrl,
      });
      return { serverUrl: target.serverUrl, ok: true, result };
    } catch (error) {
      return {
        serverUrl: target.serverUrl,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return Promise.all(promises);
}
