import { getAllServers } from "../database/actions/common";
import { NOLO_CLUSTER_SERVERS } from "../database/config";
import {
  getCurrentProfile,
  getDefaultProfileConfigPath,
  loadProfileConfig,
} from "./client/profileConfig";
import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import { includeTableActivityColumns } from "../render/table/activityColumns";
import type { CliFetchImpl } from "./cliFetch";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

type TableCommandDeps = {
  env?: EnvLike;
  output?: OutputLike;
  fetchImpl?: CliFetchImpl;
};

type OutputMode = "full" | "raw" | "items" | "jsonl";

type TableQueryRow = Record<string, unknown> & { dbKey?: string; updatedAt?: string | number; updated_at?: string | number; createdAt?: string | number; created?: string | number; deletedAt?: unknown };

type ResultLimit = {
  /** null = unlimited (explicit --all or --limit 0) */
  limit: number | null;
  unlimited: boolean;
  fromDefault: boolean;
};

// Multi-server query fetches a large page from each server and applies
// limit/offset after client-side merge. This caps per-server fetch size.
const MULTI_SERVER_FETCH_LIMIT = 10000;
const DELETE_ROWS_QUERY_PAGE_SIZE = 200;
const DEFAULT_TABLE_LIST_LIMIT = 50;
const DEFAULT_TABLE_QUERY_LIMIT = 20;
/** Safety cap for a single unbounded client-side dump (explicit --all). */
const UNBOUNDED_CLIENT_CAP = 100_000;

function readOption(args: string[], flag: string): string {
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (value === flag) return args[i + 1] ?? "";
    if (value.startsWith(`${flag}=`)) return value.slice(flag.length + 1);
  }
  return "";
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseJsonOption<T>(args: string[], flag: string): T | undefined {
  const raw = readOption(args, flag);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${flag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonOptionAlias<T>(args: string[], primaryFlag: string, aliasFlag: string): T | undefined {
  const primary = readOption(args, primaryFlag);
  const alias = readOption(args, aliasFlag);
  const raw = primary || alias;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const usedFlag = primary ? primaryFlag : aliasFlag;
    throw new Error(`${usedFlag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseOutputMode(raw: string): OutputMode {
  if (!raw) return "full";
  if (raw === "json") return "raw";
  if (raw === "full" || raw === "raw" || raw === "items" || raw === "jsonl") return raw;
  throw new Error(`--output must be one of full, raw, items, json, jsonl; got ${raw}`);
}

/**
 * Resolve list/query result limit.
 * - default: fallback when neither --limit nor --all
 * - --all or --limit 0: unlimited (caller may still apply a safety cap on fetch)
 * - --limit N (N>0): exact N
 */
function resolveResultLimit(args: string[], fallback: number): ResultLimit {
  if (hasFlag(args, "--all")) {
    return { limit: null, unlimited: true, fromDefault: false };
  }
  const raw = readOption(args, "--limit");
  if (!raw) {
    return { limit: fallback, unlimited: false, fromDefault: true };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { limit: fallback, unlimited: false, fromDefault: true };
  }
  if (parsed === 0) {
    return { limit: null, unlimited: true, fromDefault: false };
  }
  return { limit: Math.floor(parsed), unlimited: false, fromDefault: false };
}

function extractOutputItems(rawData: any): unknown[] {
  if (Array.isArray(rawData?.items)) return rawData.items;
  if (Array.isArray(rawData)) return rawData;
  return [];
}

/** Stream a pretty-printed JSON array without building one intermediate string for the whole array. */
function writeJsonArrayStream(output: OutputLike, items: unknown[]): void {
  output.write("[\n");
  for (let i = 0; i < items.length; i++) {
    const pretty = JSON.stringify(items[i], null, 2);
    const indented = pretty
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
    output.write(i === 0 ? indented : `,\n${indented}`);
  }
  output.write("\n]");
}

/** Stream NDJSON lines (one JSON value per line). */
function writeJsonlStream(output: OutputLike, items: unknown[]): void {
  for (const item of items) {
    output.write(`${JSON.stringify(item)}\n`);
  }
}

function writePrettyJsonStream(output: OutputLike, value: unknown): void {
  // Prefer array streaming when the top-level value is a large array.
  if (Array.isArray(value)) {
    writeJsonArrayStream(output, value);
    output.write("\n");
    return;
  }
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)) {
    const record = value as Record<string, unknown>;
    const items = record.items as unknown[];
    const keys = Object.keys(record);
    output.write("{\n");
    let wroteField = false;
    for (const key of keys) {
      if (key === "items") continue;
      const prefix = wroteField ? ",\n" : "";
      const pretty = JSON.stringify(record[key], null, 2)
        .split("\n")
        .map((line, idx) => (idx === 0 ? line : `  ${line}`))
        .join("\n");
      output.write(`${prefix}  ${JSON.stringify(key)}: ${pretty}`);
      wroteField = true;
    }
    output.write(wroteField ? ',\n  "items": ' : '  "items": ');
    // Inline array body with extra indent.
    output.write("[\n");
    for (let i = 0; i < items.length; i++) {
      const pretty = JSON.stringify(items[i], null, 2);
      const indented = pretty
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n");
      output.write(i === 0 ? indented : `,\n${indented}`);
    }
    output.write("\n  ]\n}\n");
    return;
  }
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeTableOutput(output: OutputLike, input: {
  envelope: any;
  rawData: any;
  mode: OutputMode;
}): void {
  if (input.mode === "jsonl") {
    writeJsonlStream(output, extractOutputItems(input.rawData));
    return;
  }
  if (input.mode === "items") {
    writeJsonArrayStream(output, extractOutputItems(input.rawData));
    output.write("\n");
    return;
  }
  if (input.mode === "raw") {
    writePrettyJsonStream(output, input.rawData);
    return;
  }
  writePrettyJsonStream(output, input.envelope);
}

function resolveQueryColumns(columns: string[] | undefined, includeActivity: boolean): string[] | undefined {
  if (!includeActivity) return columns;
  return Array.isArray(columns) ? includeTableActivityColumns(columns) : undefined;
}

function parseTableArg(raw: string): { tenantId?: string; tableId?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (!trimmed.startsWith("meta-")) return { tableId: trimmed };
  const parts = trimmed.split("-");
  return {
    tenantId: parts[1],
    tableId: parts.slice(2).join("-"),
  };
}

function normalizeSpaceInput(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    const match = new URL(value).pathname.match(/^\/space\/([^/]+)/);
    return match?.[1] ? decodeURIComponent(match[1]).replace(/^space-/, "") : "";
  }
  return value.replace(/^space-/, "");
}

function getSpaceContentKeys(spaceRecord: any): Set<string> {
  const keys = new Set<string>();
  const contents = spaceRecord?.contents;
  if (!contents || typeof contents !== "object") return keys;
  for (const [entryKey, value] of Object.entries(contents)) {
    keys.add(entryKey);
    if (value && typeof value === "object") {
      const contentKey = (value as any).contentKey;
      if (typeof contentKey === "string" && contentKey.trim()) {
        keys.add(contentKey.trim());
      }
    }
  }
  return keys;
}

function resolveServerUrl(args: string[], env: EnvLike): string {
  return (
    readOption(args, "--server-url") ||
    readOption(args, "--server") ||
    readOption(args, "--base-url") ||
    env.NOLO_SERVER_URL ||
    env.NOLO_SERVER ||
    env.BASE_URL ||
    DEFAULT_NOLO_SERVER_URL
  ).replace(/\/+$/, "");
}

function resolveQueryServerUrls(args: string[], env: EnvLike): string[] {
  const baseServer = resolveServerUrl(args, env);
  if (!hasFlag(args, "--multi-server")) return [baseServer];

  let syncServers: string[] | undefined;
  try {
    const configPath = readOption(args, "--profile-config") || getDefaultProfileConfigPath();
    const config = loadProfileConfig(configPath);
    const profile = getCurrentProfile(config);
    if (profile && "syncServers" in profile && Array.isArray(profile.syncServers)) {
      syncServers = profile.syncServers.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // ignore profile read errors; fall back to cluster defaults
  }

  if (!syncServers || syncServers.length === 0) {
    syncServers = NOLO_CLUSTER_SERVERS;
  }

  return getAllServers(baseServer, syncServers);
}

async function fetchTableRowsFromServer(
  serverUrl: string,
  requestBody: Record<string, unknown>,
  authToken: string,
  fetchImpl: CliFetchImpl
): Promise<{ serverUrl: string; ok: boolean; payload?: Record<string, unknown>; error?: string }> {
  try {
    const response = await fetchImpl(`${serverUrl}/api/table/query-rows`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    const text = await response.text();
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      return { serverUrl, ok: response.ok, error: text || response.statusText };
    }
    if (!response.ok || payload?.error) {
      return { serverUrl, ok: false, error: payload?.error ?? response.statusText };
    }
    return { serverUrl, ok: true, payload };
  } catch (error) {
    return {
      serverUrl,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readTableCommandError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return response.statusText;
  try {
    const payload = JSON.parse(text);
    if (payload && typeof payload.error === "string") return payload.error;
  } catch {}
  return text;
}

function resolveAuthToken(args: string[], env: EnvLike): string {
  return (
    readOption(args, "--machine-key") ||
    readOption(args, "--token") ||
    env.AUTH_TOKEN ||
    env.AUTH ||
    ""
  );
}

function parseJwtTenantId(token: string): string | undefined {
  for (const parsed of parseJwtPayloadCandidates(token)) {
    const userId = parsed.userId;
    const sub = parsed.sub;
    if (typeof userId === "string" && userId) return userId;
    if (typeof sub === "string" && sub) return sub;
  }
  return undefined;
}

function parseJwtUsername(token: string): string | undefined {
  for (const parsed of parseJwtPayloadCandidates(token)) {
    const username = parsed.username;
    if (typeof username === "string" && username.trim()) return username.trim();
  }
  return undefined;
}

function parseJwtPayloadCandidates(token: string): Array<Record<string, unknown>> {
  const trimmed = token.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(".").filter(Boolean);
  const payloadCandidates = parts.length >= 3 ? [parts[1], parts[0]] : [parts[0]];
  const parsed: Array<Record<string, unknown>> = [];
  for (const payload of payloadCandidates) {
    try {
      const decoded = Buffer.from(payload, "base64").toString("utf8");
      const value = JSON.parse(decoded);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed.push(value as Record<string, unknown>);
      }
    } catch {}
  }
  return parsed;
}

function resolveUserId(args: string[], env: EnvLike, authToken: string): string | undefined {
  const explicit = readOption(args, "--tenant-id") || env.USER_ID || parseJwtTenantId(authToken);
  if (explicit) return explicit;
  const username = parseJwtUsername(authToken);
  return username && /^[a-z0-9_-]+$/i.test(username) ? username : undefined;
}

function mergeQueryShortcutFilters(args: string[], filters: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const row = readOption(args, "--row") || readOption(args, "--row-id");
  const rowDbKey = readOption(args, "--row-dbkey");
  const shortcutFilters: Record<string, unknown> = {};
  if (row) {
    if (row.startsWith("row-")) shortcutFilters.dbKey = row;
    else shortcutFilters.rowId = row;
  }
  if (rowDbKey) shortcutFilters.dbKey = rowDbKey;
  if (Object.keys(shortcutFilters).length === 0) return filters;
  return {
    ...(filters ?? {}),
    ...shortcutFilters,
  };
}

function usage(): string {
  return [
    "Usage:",
    "  nolo table query --table <tableId|metaKey> [--tenant-id <userId>] [--filters <json>|--filter <json>] [--row <rowId|rowDbKey>] [--columns <json-array>] [--include-activity] [--no-base-fields] [--limit <n>] [--offset <n>] [--all] [--output full|raw|items|json|jsonl]",
    "",
    "Options:",
    `  --limit <n>   Max rows to return. Default: ${DEFAULT_TABLE_QUERY_LIMIT} (1 with --row). Use 0 with care.`,
    "  --offset <n>  Skip first n rows (paging). Default: 0.",
    "  --all         Full dump (same as --limit 0). Prefer --output jsonl for large results.",
    "  --output      full|raw|items|json|jsonl. jsonl streams one row per line (lowest memory).",
    "",
  ].join("\n");
}

function deleteRowsUsage(): string {
  return [
    "Usage:",
    "  nolo table delete-rows --table <tableId|metaKey> (--row-ids <json-array> | --row-dbkeys <json-array> | --filters <json-object>)",
    "",
  ].join("\n");
}

function listUsage(): string {
  return [
    "Usage:",
    "  nolo table list [--limit <n>] [--all] [--title-query <text>] [--purpose <purpose>] [--output full|raw|items|json|jsonl]",
    "",
    "Options:",
    `  --limit <n>   Max tables to return. Default: ${DEFAULT_TABLE_LIST_LIMIT}. Use --limit 0 or --all for full dump.`,
    "  --all         Full dump (same as --limit 0).",
    "  --output      full|raw|items|json|jsonl. jsonl streams one table per line.",
    "",
  ].join("\n");
}

function tableHasPurpose(table: any, purpose: string): boolean {
  return typeof table?.purpose === "string" && table.purpose.toLowerCase() === purpose.toLowerCase();
}

function getComparableUpdatedAt(record: TableQueryRow): number {
  const raw = record?.updatedAt ?? record?.updated_at ?? record?.createdAt ?? record?.created;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") return Date.parse(raw) || 0;
  return 0;
}

function shouldReplaceTableRecord(next: TableQueryRow, current: TableQueryRow): boolean {
  const nextTs = getComparableUpdatedAt(next);
  const currentTs = getComparableUpdatedAt(current);
  if (nextTs !== currentTs) return nextTs > currentTs;
  return Boolean(next?.deletedAt) && !Boolean(current?.deletedAt);
}

function getTableQueryRawData(payload: any): any {
  return payload?.rawData ?? payload;
}

function getTableQueryItems(payload: any): TableQueryRow[] {
  const rawData = getTableQueryRawData(payload);
  if (rawData?.tableMeta?.deletedAt) return [];
  const liveItems = Array.isArray(rawData?.items) ? rawData.items : [];
  const deletedItems = Array.isArray(rawData?.deletedItems) ? rawData.deletedItems : [];
  return [...liveItems, ...deletedItems].filter((item) => item && typeof item === "object");
}

function isLatestTableMetaDeleted(payloads: any[]): boolean {
  let latestMeta: TableQueryRow | null = null;
  for (const payload of payloads) {
    const tableMeta = getTableQueryRawData(payload)?.tableMeta;
    if (!tableMeta || typeof tableMeta !== "object") continue;
    if (!latestMeta || shouldReplaceTableRecord(tableMeta, latestMeta)) {
      latestMeta = tableMeta;
    }
  }
  return Boolean(latestMeta?.deletedAt);
}

export async function runTableListCommand(args: string[], deps: TableCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    output.write(listUsage());
    return 0;
  }

  let outputMode: OutputMode;
  try {
    outputMode = parseOutputMode(readOption(args, "--output") || "items");
  } catch (error) {
    output.write(`[nolo] table list failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const authToken = resolveAuthToken(args, env);
  const userId = resolveUserId(args, env, authToken);
  if (!userId) {
    output.write("[nolo] table list failed: user id is required. Pass --tenant-id or use a login token.\n");
    return 1;
  }
  if (!authToken) {
    output.write("[nolo] table list failed: AUTH_TOKEN is required.\n");
    return 1;
  }

  const resultLimit = resolveResultLimit(args, DEFAULT_TABLE_LIST_LIMIT);
  const limit = resultLimit.unlimited
    ? UNBOUNDED_CLIENT_CAP
    : Math.max(1, resultLimit.limit ?? DEFAULT_TABLE_LIST_LIMIT);
  const titleQuery = readOption(args, "--title-query").trim().toLowerCase();
  const purpose = readOption(args, "--purpose").trim();
  const spaceId = normalizeSpaceInput(readOption(args, "--space") || readOption(args, "--space-id"));
  const scanLimit = titleQuery || purpose ? Math.max(limit * 5, 200) : limit;
  const serverUrl = resolveServerUrl(args, env);

  let records: any[];
  try {
    records = spaceId
      ? await fetchSpaceTableRecords({
          authToken,
          fetchImpl,
          serverUrl,
          spaceId,
        })
      : await fetchUserTableRecords({
          authToken,
          fetchImpl,
          limit: Math.min(scanLimit, resultLimit.unlimited ? UNBOUNDED_CLIENT_CAP : 500),
          serverUrl,
          userId,
        });
  } catch (error) {
    output.write(`[nolo] table list failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const filtered = records
    .filter((table: any) => table && typeof table === "object" && !table.deletedAt)
    .filter((table: any) => !titleQuery || String(table.displayName ?? table.name ?? table.title ?? "").toLowerCase().includes(titleQuery))
    .filter((table: any) => !purpose || tableHasPurpose(table, purpose))
    .sort((left: any, right: any) => getComparableUpdatedAt(right) - getComparableUpdatedAt(left));
  const hitLimit = !resultLimit.unlimited && filtered.length > limit;
  const tables = filtered.slice(0, limit).map((table: any) => ({
      dbKey: table.dbKey ?? null,
      tableId: table.tableId ?? null,
      displayName: table.displayName ?? table.name ?? table.title ?? "(untitled)",
      spaceId: table.spaceId ?? null,
      tenantId: table.tenantId ?? null,
      columnCount: Array.isArray(table.columns) ? table.columns.length : 0,
      createdAt: table.createdAt ?? null,
      updatedAt: table.updatedAt ?? table.updated_at ?? null,
    }));

  const envelope = {
    success: true,
    userId,
    ...(spaceId ? { space: spaceId } : {}),
    total: tables.length,
    ...(hitLimit ? { limit, truncated: true, nextOffset: limit } : {}),
    tables,
  };
  writeTableOutput(output, {
    mode: outputMode,
    envelope,
    // list raw/items/jsonl historically print the tables array (not { items })
    rawData: tables,
  });
  return 0;
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    if (!response.ok) throw new Error(text || response.statusText);
    return text;
  }
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error ?? response.statusText);
  }
  return payload;
}

async function fetchUserTableRecords(args: {
  authToken: string;
  fetchImpl: CliFetchImpl;
  limit: number;
  serverUrl: string;
  userId: string;
}) {
  const response = await args.fetchImpl(
    `${args.serverUrl}/api/v1/db/query/${encodeURIComponent(args.userId)}?limit=${args.limit}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "table" }),
    }
  );
  const payload = await readJsonResponse(response);
  return Array.isArray(payload?.data?.data)
    ? payload.data.data
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
}

async function fetchSpaceTableRecords(args: {
  authToken: string;
  fetchImpl: CliFetchImpl;
  serverUrl: string;
  spaceId: string;
}) {
  const readRecord = async (dbKey: string) => {
    const response = await args.fetchImpl(
      `${args.serverUrl}/api/v1/db/read/${encodeURIComponent(dbKey)}`,
      { headers: { Authorization: `Bearer ${args.authToken}` } }
    );
    const payload = await readJsonResponse(response);
    return payload?.data ?? payload;
  };
  const space = await readRecord(`space-${args.spaceId}`);
  const tableKeys = [...getSpaceContentKeys(space)].filter((key) => key.startsWith("meta-"));
  const records = await Promise.all(
    tableKeys.map(async (key) => {
      try {
        return await readRecord(key);
      } catch {
        return null;
      }
    })
  );
  return records.filter(Boolean);
}

export async function runTableQueryCommand(args: string[], deps: TableCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    output.write(usage());
    return 0;
  }

  let outputMode: OutputMode;
  let columns: string[] | undefined;
  let filters: Record<string, unknown> | undefined;
  try {
    outputMode = parseOutputMode(readOption(args, "--output"));
    columns = parseJsonOption<string[]>(args, "--columns");
    filters = mergeQueryShortcutFilters(
      args,
      parseJsonOptionAlias<Record<string, unknown>>(args, "--filters", "--filter")
    );
  } catch (error) {
    output.write(`[nolo] table query failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const tableArg = parseTableArg(readOption(args, "--table"));
  const authToken = resolveAuthToken(args, env);
  const tenantId = readOption(args, "--tenant-id") || tableArg.tenantId || resolveUserId(args, env, authToken);
  const tableId = tableArg.tableId;
  const hasSingleRowShortcut = Boolean(readOption(args, "--row") || readOption(args, "--row-id") || readOption(args, "--row-dbkey"));
  if (!tenantId || !tableId) {
    output.write(usage());
    return 1;
  }
  if (!authToken) {
    output.write("[nolo] table query failed: AUTH_TOKEN is required.\n");
    return 1;
  }

  const serverUrls = resolveQueryServerUrls(args, env);
  const isMultiServer = serverUrls.length > 1;
  const defaultQueryLimit = hasSingleRowShortcut ? 1 : DEFAULT_TABLE_QUERY_LIMIT;
  const resultLimit = resolveResultLimit(args, defaultQueryLimit);
  const requestedLimit = resultLimit.unlimited
    ? UNBOUNDED_CLIENT_CAP
    : Math.max(1, resultLimit.limit ?? defaultQueryLimit);
  const requestedOffset = Math.max(0, Math.floor(Number(readOption(args, "--offset") || 0) || 0));
  const sortBy = readOption(args, "--sort-by") || "updatedAt";
  const sortOrder = readOption(args, "--sort-order") === "asc" ? "asc" : "desc";

  const requestBody: Record<string, unknown> = {
    tenantId,
    tableId,
    filters: filters ?? {},
    columns: resolveQueryColumns(columns, hasFlag(args, "--include-activity")),
    includeBaseFields: !hasFlag(args, "--no-base-fields"),
    sortBy,
    sortOrder,
    includeDeleted: true,
    envelope: "table-sync-v1",
  };

  if (isMultiServer) {
    // Avoid server-side truncation before merge; apply limit/offset after merging.
    requestBody.limit = MULTI_SERVER_FETCH_LIMIT;
  } else {
    requestBody.limit = requestedLimit;
    requestBody.offset = requestedOffset;
  }

  const results = await Promise.all(
    serverUrls.map((serverUrl) =>
      fetchTableRowsFromServer(serverUrl, requestBody, authToken, fetchImpl)
    )
  );

  const multiServerWarnings: string[] = [];
  const failedServers = results.filter((r) => !r.ok);
  if (failedServers.length === results.length) {
    const errors = failedServers.map((r) => `${r.serverUrl}: ${r.error}`).join("; ");
    output.write(`[nolo] table query failed: ${errors}\n`);
    return 1;
  }
  if (failedServers.length > 0) {
    const errors = failedServers.map((r) => `${r.serverUrl}: ${r.error}`).join("; ");
    multiServerWarnings.push(`partial server failures: ${errors}`);
  }

  let mergedItems: TableQueryRow[] = [];
  let fetchedBeforeSlice = 0;
  if (isMultiServer) {
    const itemMap = new Map<string, TableQueryRow>();
    const tableDeleted = isLatestTableMetaDeleted(
      results.filter((result) => result.ok && result.payload).map((result) => result.payload)
    );
    for (const result of results) {
      if (!result.ok || !result.payload) continue;
      const items = tableDeleted ? [] : getTableQueryItems(result.payload);
      for (const item of items) {
        if (!item || typeof item.dbKey !== "string") continue;
        const existing = itemMap.get(item.dbKey);
        if (!existing || shouldReplaceTableRecord(item, existing)) {
          itemMap.set(item.dbKey, { ...item, _serverOrigin: result.serverUrl });
        }
      }
    }
    mergedItems = Array.from(itemMap.values()).filter((item) => !item.deletedAt);
    mergedItems.sort((a, b) => {
      const diff = getComparableUpdatedAt(b) - getComparableUpdatedAt(a);
      return sortOrder === "asc" ? -diff : diff;
    });
    fetchedBeforeSlice = mergedItems.length;
    mergedItems = resultLimit.unlimited
      ? mergedItems.slice(requestedOffset, requestedOffset + UNBOUNDED_CLIENT_CAP)
      : mergedItems.slice(requestedOffset, requestedOffset + requestedLimit);
  } else {
    const result = results[0];
    if (!result || !result.ok || !result.payload) {
      output.write(`[nolo] table query failed: ${result?.error ?? "unknown error"}\n`);
      return 1;
    }
    // Client-side cap even if the server over-returns (defense in depth / mock safety).
    const live = getTableQueryItems(result.payload).filter((item) => !item.deletedAt);
    fetchedBeforeSlice = live.length;
    mergedItems = resultLimit.unlimited
      ? live.slice(0, UNBOUNDED_CLIENT_CAP)
      : live.slice(0, requestedLimit);
  }

  // Treat as truncated when the server/merge returned more than we emit, or when we filled
  // the exact limit (more may exist server-side). Metadata is only attached on hit to keep
  // small-result JSON shapes stable for existing scripts/tests.
  const hitLimit =
    !resultLimit.unlimited &&
    (fetchedBeforeSlice > mergedItems.length ||
      (mergedItems.length >= requestedLimit && requestedLimit > 0));

  const truncationFields = hitLimit
    ? {
        limit: requestedLimit,
        offset: requestedOffset,
        truncated: true as const,
        nextOffset: requestedOffset + mergedItems.length,
      }
    : {};

  const singleRawData = !isMultiServer ? getTableQueryRawData(results[0].payload) : null;
  const rawData = isMultiServer
    ? {
        items: mergedItems,
        ...truncationFields,
      }
    : singleRawData && typeof singleRawData === "object"
      ? {
          ...singleRawData,
          items: mergedItems,
          ...truncationFields,
        }
      : { items: mergedItems, ...truncationFields };
  const envelope = isMultiServer
    ? {
        rawData: { items: mergedItems, ...truncationFields },
        _multiServerOrigins: serverUrls,
        _multiServerWarnings: multiServerWarnings,
        ...truncationFields,
      }
    : results[0].payload && typeof results[0].payload === "object"
      ? {
          ...results[0].payload,
          rawData,
          ...truncationFields,
        }
      : { rawData, ...truncationFields };

  writeTableOutput(output, {
    envelope,
    rawData,
    mode: outputMode,
  });
  return 0;
}
export async function runTableDeleteRowsCommand(args: string[], deps: TableCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    output.write(deleteRowsUsage());
    return 0;
  }

  const tableArg = parseTableArg(readOption(args, "--table"));
  const authToken = resolveAuthToken(args, env);
  const tenantId = readOption(args, "--tenant-id") || tableArg.tenantId || resolveUserId(args, env, authToken);
  const tableId = tableArg.tableId;
  if (!tenantId || !tableId) {
    output.write(deleteRowsUsage());
    return 1;
  }
  if (!authToken) {
    output.write("[nolo] table delete-rows failed: AUTH_TOKEN is required.\n");
    return 1;
  }

  const deletionSources = [
    hasFlag(args, "--row-ids") ? "--row-ids" : undefined,
    hasFlag(args, "--row-dbkeys") ? "--row-dbkeys" : undefined,
    hasFlag(args, "--filters") || hasFlag(args, "--filter") ? "--filters" : undefined,
  ].filter(Boolean) as string[];
  if (deletionSources.length > 1) {
    output.write(`[nolo] table delete-rows failed: only one deletion source allowed; got ${deletionSources.join(", ")}.\n`);
    return 1;
  }

  let deletionSpec: Array<{ dbKey: string; source: string }> | undefined;
  try {
    const rowIds = parseJsonOption<string[]>(args, "--row-ids");
    if (rowIds !== undefined) {
      if (!Array.isArray(rowIds) || rowIds.length === 0 || !rowIds.every((id) => typeof id === "string")) {
        throw new Error("--row-ids must be a non-empty JSON array of strings.");
      }
      deletionSpec = rowIds.map((rowId) => ({
        dbKey: `row-${tenantId}-${tableId}-${rowId}`,
        source: `--row-ids:${rowId}`,
      }));
    }
  } catch (error) {
    output.write(`[nolo] table delete-rows failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (!deletionSpec) {
    try {
      const rowDbKeys = parseJsonOption<string[]>(args, "--row-dbkeys");
      if (rowDbKeys !== undefined) {
        if (!Array.isArray(rowDbKeys) || rowDbKeys.length === 0 || !rowDbKeys.every((k) => typeof k === "string")) {
          throw new Error("--row-dbkeys must be a non-empty JSON array of strings.");
        }
        deletionSpec = rowDbKeys.map((dbKey) => ({ dbKey, source: "--row-dbkeys" }));
      }
    } catch (error) {
      output.write(`[nolo] table delete-rows failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const serverUrl = resolveServerUrl(args, env);

  if (!deletionSpec) {
    const filtersRaw = parseJsonOptionAlias<Record<string, unknown>>(args, "--filters", "--filter");
    if (filtersRaw !== undefined) {
      const queryLimit = DELETE_ROWS_QUERY_PAGE_SIZE;
      const matchedRows: TableQueryRow[] = [];
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;

      while (offset < total) {
        const response = await fetchImpl(`${serverUrl}/api/table/query-rows`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            tenantId,
            tableId,
            filters: filtersRaw,
            limit: queryLimit,
            offset,
            includeDeleted: true,
            envelope: "table-sync-v1",
          }),
        });
        if (!response.ok) {
          output.write(`[nolo] table delete-rows failed: query rows failed: ${response.statusText}\n`);
          return 1;
        }
        const payload = await response.json();
        if (payload && typeof payload === "object" && "error" in payload) {
          output.write(`[nolo] table delete-rows failed: query rows failed: ${(payload as { error?: string }).error ?? "unknown error"}\n`);
          return 1;
        }
        const rawData = getTableQueryRawData(payload);
        const items = getTableQueryItems(payload).filter((item) => !item.deletedAt);
        matchedRows.push(...items);
        const nextTotal = Number(rawData?.total);
        total = Number.isFinite(nextTotal) && nextTotal >= 0
          ? nextTotal
          : offset + items.length;
        if (items.length === 0) break;
        offset += items.length;
      }

      deletionSpec = matchedRows
        .filter((item): item is TableQueryRow & { dbKey: string } => typeof item?.dbKey === "string")
        .map((item) => ({ dbKey: item.dbKey, source: "--filters" }));
      if (deletionSpec.length === 0) {
        output.write(`${JSON.stringify({ ok: true, deleted: 0, results: [] })}\n`);
        return 0;
      }
      if (!hasFlag(args, "--yes")) {
        output.write(`${JSON.stringify({ ok: true, dryRun: true, wouldDelete: deletionSpec.length, dbKeys: deletionSpec.map((s) => s.dbKey) })}\n`);
        output.write("Dry-run only. Re-run with --yes to delete these rows.\n");
        return 0;
      }
    }
  }

  if (!deletionSpec || deletionSpec.length === 0) {
    output.write(`[nolo] table delete-rows failed: nothing to delete; provide --row-ids, --row-dbkeys, or --filters.\n`);
    output.write(deleteRowsUsage());
    return 1;
  }

  const results: Array<{ dbKey: string; ok: boolean; source: string; error?: string }> = [];
  try {
    const response = await fetchImpl(`${serverUrl}/api/table/delete-rows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        tenantId,
        tableId,
        dbKeys: deletionSpec.map((item) => item.dbKey),
      }),
    });
    if (response.ok) {
      const payload = await response.json().catch(() => ({}));
      const responseResults = Array.isArray(payload?.rawData?.results)
        ? payload.rawData.results
        : Array.isArray(payload?.results)
          ? payload.results
          : [];
      if (responseResults.length > 0) {
        const resultByKey = new Map(
          responseResults
            .filter((item: any) => typeof item?.dbKey === "string")
            .map((item: any) => [item.dbKey, item])
        );
        results.push(
          ...deletionSpec.map(({ dbKey, source }) => {
            const result = resultByKey.get(dbKey) as any;
            if (!result) return { dbKey, source, ok: false, error: "missing delete result" };
            return {
              dbKey,
              source,
              ok: result.ok === true,
              ...(result.ok === true ? {} : { error: String(result.error ?? "delete failed") }),
            };
          })
        );
      } else {
        results.push(...deletionSpec.map(({ dbKey, source }) => ({ dbKey, source, ok: true })));
      }
    } else {
      const error = await readTableCommandError(response);
      results.push(...deletionSpec.map(({ dbKey, source }) => ({ dbKey, source, ok: false, error })));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push(...deletionSpec.map(({ dbKey, source }) => ({ dbKey, source, ok: false, error: message })));
  }

  output.write(`${JSON.stringify({ ok: true, deleted: results.filter((r) => r.ok).length, results })}\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseValuesObject(flag: string, raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${flag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${flag} must be a JSON object`);
  }
  return parsed;
}

function parseRowsArray(flag: string, raw: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${flag} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${flag} must be a non-empty JSON array`);
  }
  if (!parsed.every(isPlainObject)) {
    throw new Error(`${flag} must be an array of JSON objects`);
  }
  return parsed as Array<Record<string, unknown>>;
}

function parseUpdatesArray(flag: string, raw: string): Array<Record<string, unknown>> {
  const updates = parseRowsArray(flag, raw);
  for (const update of updates) {
    if (typeof update.rowId !== "string" && typeof update.rowDbKey !== "string") {
      throw new Error(`${flag}[*] must include rowId or rowDbKey`);
    }
    if (!isPlainObject(update.changes)) {
      throw new Error(`${flag}[*].changes must be a JSON object`);
    }
  }
  return updates;
}

function resolveRowTarget(raw: string | undefined): { rowId?: string; rowDbKey?: string } {
  if (!raw) return {};
  const trimmed = raw.trim();
  if (trimmed.startsWith("row-")) return { rowDbKey: trimmed };
  return { rowId: trimmed };
}

function resolveTableContext(args: string[], env: EnvLike, output: OutputLike):
  | { ok: true; authToken: string; tenantId: string; tableId: string; serverUrl: string; tableArg: { tenantId?: string; tableId?: string } }
  | { ok: false } {
  const tableArg = parseTableArg(readOption(args, "--table"));
  const authToken = resolveAuthToken(args, env);
  const tenantId = readOption(args, "--tenant-id") || tableArg.tenantId || resolveUserId(args, env, authToken);
  const tableId = tableArg.tableId;
  if (!tenantId || !tableId) {
    output.write("Usage:\n  nolo table <action> --table <tableId|metaKey> [action-specific flags]\n\n");
    return { ok: false };
  }
  if (!authToken) {
    output.write("[nolo] table failed: AUTH_TOKEN is required.\n");
    return { ok: false };
  }
  return { ok: true, authToken, tenantId, tableId, serverUrl: resolveServerUrl(args, env), tableArg };
}

async function postTableJson(
  deps: TableCommandDeps,
  ctx: { authToken: string; serverUrl: string },
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: true; payload: unknown } | { ok: false; message: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${ctx.serverUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.authToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return { ok: false, message: await readTableCommandError(response) };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { ok: true, payload };
}

const TABLE_ADD_COLUMN_USAGE = "Usage:\n  nolo table add-column --table <tableId|metaKey> --name <columnName> [--label <label>] [--type <text|number|boolean|date|datetime|select|multi_select>] [--options <json-array>]\n\n";
const TABLE_ADD_ROW_USAGE = "Usage:\n  nolo table add-row --table <tableId|metaKey> --values <json-object>\n\n";
const TABLE_ADD_ROWS_USAGE = "Usage:\n  nolo table add-rows --table <tableId|metaKey> --rows <non-empty-json-array>\n\n";
const TABLE_UPDATE_ROW_USAGE = "Usage:\n  nolo table update-row --table <tableId|metaKey> --row <rowId|rowDbKey> --changes <json-object>\n\n";
const TABLE_UPDATE_ROWS_USAGE = "Usage:\n  nolo table update-rows --table <tableId|metaKey> --updates <non-empty-json-array>\n\n";
const TABLE_DELETE_ROW_USAGE = "Usage:\n  nolo table delete-row --table <tableId|metaKey> --row <rowId|rowDbKey>\n\n";

export async function runTableAddColumnCommand(args: string[], deps: TableCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    output.write(TABLE_ADD_COLUMN_USAGE);
    return 0;
  }
  const ctx = resolveTableContext(args, env, output);
  if (!ctx.ok) {
    output.write(TABLE_ADD_COLUMN_USAGE);
    return 1;
  }
  const name = readOption(args, "--name").trim();
  if (!name) {
    output.write(`[nolo] table add-column failed: --name is required.\n${TABLE_ADD_COLUMN_USAGE}`);
    return 1;
  }
  const body: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    tableId: ctx.tableId,
    name,
  };
  const label = readOption(args, "--label").trim();
  if (label) body.label = label;
  const type = readOption(args, "--type").trim();
  if (type) body.type = type;
  const optionsRaw = readOption(args, "--options");
  if (optionsRaw) {
    let optionsParsed: unknown;
    try {
      optionsParsed = JSON.parse(optionsRaw);
    } catch (error) {
      output.write(`[nolo] table add-column failed: --options must be valid JSON: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    if (!Array.isArray(optionsParsed)) {
      output.write(`[nolo] table add-column failed: --options must be a JSON array.\n`);
      return 1;
    }
    body.options = optionsParsed;
  }
  const result = await postTableJson(deps, ctx, "/api/table/add-column", body);
  if (!result.ok) {
    output.write(`[nolo] table add-column failed: ${result.message}\n`);
    return 1;
  }
  output.write(`${JSON.stringify({ ok: true, action: "add-column", result: result.payload })}\n`);
  return 0;
}

export async function runTableAddRowCommand(args: string[], deps: TableCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    output.write(TABLE_ADD_ROW_USAGE);
    return 0;
  }
  const ctx = resolveTableContext(args, env, output);
  if (!ctx.ok) {
    output.write(TABLE_ADD_ROW_USAGE);
    return 1;
  }
  const valuesRaw = readOption(args, "--values");
  if (!valuesRaw) {
    output.write(`[nolo] table add-row failed: --values is required.\n${TABLE_ADD_ROW_USAGE}`);
    return 1;
  }
  let values: Record<string, unknown>;
  try {
    values = parseValuesObject("--values", valuesRaw);
  } catch (error) {
    output.write(`[nolo] table add-row failed: ${error instanceof Error ? error.message : String(error)}\n${TABLE_ADD_ROW_USAGE}`);
    return 1;
  }
  const result = await postTableJson(deps, ctx, "/api/table/add-row", { tenantId: ctx.tenantId, tableId: ctx.tableId, values });
  if (!result.ok) {
    output.write(`[nolo] table add-row failed: ${result.message}\n`);
    return 1;
  }
  output.write(`${JSON.stringify({ ok: true, action: "add-row", result: result.payload })}\n`);
  return 0;
}

export async function runTableAddRowsCommand(args: string[], deps: TableCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    output.write(TABLE_ADD_ROWS_USAGE);
    return 0;
  }
  const ctx = resolveTableContext(args, env, output);
  if (!ctx.ok) {
    output.write(TABLE_ADD_ROWS_USAGE);
    return 1;
  }
  const rowsRaw = readOption(args, "--rows");
  if (!rowsRaw) {
    output.write(`[nolo] table add-rows failed: --rows is required.\n${TABLE_ADD_ROWS_USAGE}`);
    return 1;
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = parseRowsArray("--rows", rowsRaw);
  } catch (error) {
    output.write(`[nolo] table add-rows failed: ${error instanceof Error ? error.message : String(error)}\n${TABLE_ADD_ROWS_USAGE}`);
    return 1;
  }
  const result = await postTableJson(deps, ctx, "/api/table/add-rows", { tenantId: ctx.tenantId, tableId: ctx.tableId, rows });
  if (!result.ok) {
    output.write(`[nolo] table add-rows failed: ${result.message}\n`);
    return 1;
  }
  output.write(`${JSON.stringify({ ok: true, action: "add-rows", result: result.payload })}\n`);
  return 0;
}

export async function runTableUpdateRowCommand(args: string[], deps: TableCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    output.write(TABLE_UPDATE_ROW_USAGE);
    return 0;
  }
  const ctx = resolveTableContext(args, env, output);
  if (!ctx.ok) {
    output.write(TABLE_UPDATE_ROW_USAGE);
    return 1;
  }
  const rowRaw = readOption(args, "--row");
  const target = resolveRowTarget(rowRaw);
  if (!target.rowId && !target.rowDbKey) {
    output.write(`[nolo] table update-row failed: --row is required (rowId or row dbKey).\n${TABLE_UPDATE_ROW_USAGE}`);
    return 1;
  }
  const changesRaw = readOption(args, "--changes");
  if (!changesRaw) {
    output.write(`[nolo] table update-row failed: --changes is required.\n${TABLE_UPDATE_ROW_USAGE}`);
    return 1;
  }
  let changes: Record<string, unknown>;
  try {
    changes = parseValuesObject("--changes", changesRaw);
  } catch (error) {
    output.write(`[nolo] table update-row failed: ${error instanceof Error ? error.message : String(error)}\n${TABLE_UPDATE_ROW_USAGE}`);
    return 1;
  }
  const result = await postTableJson(deps, ctx, "/api/table/update-row", { tenantId: ctx.tenantId, tableId: ctx.tableId, ...target, changes });
  if (!result.ok) {
    output.write(`[nolo] table update-row failed: ${result.message}\n`);
    return 1;
  }
  output.write(`${JSON.stringify({ ok: true, action: "update-row", result: result.payload })}\n`);
  return 0;
}

export async function runTableUpdateRowsCommand(args: string[], deps: TableCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    output.write(TABLE_UPDATE_ROWS_USAGE);
    return 0;
  }
  const ctx = resolveTableContext(args, env, output);
  if (!ctx.ok) {
    output.write(TABLE_UPDATE_ROWS_USAGE);
    return 1;
  }
  const updatesRaw = readOption(args, "--updates");
  if (!updatesRaw) {
    output.write(`[nolo] table update-rows failed: --updates is required.\n${TABLE_UPDATE_ROWS_USAGE}`);
    return 1;
  }
  let updates: Array<Record<string, unknown>>;
  try {
    updates = parseUpdatesArray("--updates", updatesRaw);
  } catch (error) {
    output.write(`[nolo] table update-rows failed: ${error instanceof Error ? error.message : String(error)}\n${TABLE_UPDATE_ROWS_USAGE}`);
    return 1;
  }
  const result = await postTableJson(deps, ctx, "/api/table/update-rows", { tenantId: ctx.tenantId, tableId: ctx.tableId, updates });
  if (!result.ok) {
    output.write(`[nolo] table update-rows failed: ${result.message}\n`);
    return 1;
  }
  output.write(`${JSON.stringify({ ok: true, action: "update-rows", result: result.payload })}\n`);
  return 0;
}

export async function runTableDeleteRowCommand(args: string[], deps: TableCommandDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    output.write(TABLE_DELETE_ROW_USAGE);
    return 0;
  }
  const ctx = resolveTableContext(args, env, output);
  if (!ctx.ok) {
    output.write(TABLE_DELETE_ROW_USAGE);
    return 1;
  }
  const rowRaw = readOption(args, "--row");
  const target = resolveRowTarget(rowRaw);
  if (!target.rowId && !target.rowDbKey) {
    output.write(`[nolo] table delete-row failed: --row is required (rowId or row dbKey).\n${TABLE_DELETE_ROW_USAGE}`);
    return 1;
  }
  const result = await postTableJson(deps, ctx, "/api/table/delete-row", { tenantId: ctx.tenantId, tableId: ctx.tableId, ...target });
  if (!result.ok) {
    output.write(`[nolo] table delete-row failed: ${result.message}\n`);
    return 1;
  }
  output.write(`${JSON.stringify({ ok: true, action: "delete-row", result: result.payload })}\n`);
  return 0;
}
