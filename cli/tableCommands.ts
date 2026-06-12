import { DEFAULT_NOLO_SERVER_URL } from "./defaultServer";
import { includeTableActivityColumns } from "../render/table/activityColumns";

type EnvLike = Record<string, string | undefined>;
type OutputLike = { write(chunk: string): unknown };

type TableCommandDeps = {
  env?: EnvLike;
  output?: OutputLike;
  fetchImpl?: typeof fetch;
};

type OutputMode = "full" | "raw" | "items" | "jsonl";

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

function formatOutput(input: { envelope: any; rawData: any; mode: OutputMode }): string {
  if (input.mode === "full") return JSON.stringify(input.envelope, null, 2);
  if (input.mode === "raw") return JSON.stringify(input.rawData, null, 2);
  const items = Array.isArray(input.rawData?.items) ? input.rawData.items : input.rawData;
  if (input.mode === "items") return JSON.stringify(items, null, 2);
  return Array.isArray(items) ? items.map((item) => JSON.stringify(item)).join("\n") : JSON.stringify(items);
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
    "  nolo table query --table <tableId|metaKey> [--tenant-id <userId>] [--filters <json>|--filter <json>] [--row <rowId|rowDbKey>] [--columns <json-array>] [--include-activity] [--no-base-fields] [--output full|raw|items|json|jsonl]",
    "",
  ].join("\n");
}

function listUsage(): string {
  return [
    "Usage:",
    "  nolo table list [--limit <n>] [--title-query <text>] [--purpose <purpose>] [--output full|raw|items|json|jsonl]",
    "",
  ].join("\n");
}

function tableHasPurpose(table: any, purpose: string): boolean {
  return typeof table?.purpose === "string" && table.purpose.toLowerCase() === purpose.toLowerCase();
}

function getComparableUpdatedAt(record: any): number {
  const raw = record?.updatedAt ?? record?.updated_at ?? record?.createdAt ?? record?.created;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") return Date.parse(raw) || 0;
  return 0;
}

function formatTableListOutput(args: {
  mode: OutputMode;
  tables: any[];
  envelope: any;
}) {
  if (args.mode === "full") return JSON.stringify(args.envelope, null, 2);
  if (args.mode === "raw") return JSON.stringify(args.tables, null, 2);
  if (args.mode === "items") return JSON.stringify(args.tables, null, 2);
  return args.tables.map((item) => JSON.stringify(item)).join("\n");
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

  const limit = Math.max(1, Math.min(Number(readOption(args, "--limit") || 50), 200));
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
          limit: Math.min(scanLimit, 500),
          serverUrl,
          userId,
        });
  } catch (error) {
    output.write(`[nolo] table list failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const tables = records
    .filter((table: any) => table && typeof table === "object" && !table.deletedAt)
    .filter((table: any) => !titleQuery || String(table.displayName ?? table.name ?? table.title ?? "").toLowerCase().includes(titleQuery))
    .filter((table: any) => !purpose || tableHasPurpose(table, purpose))
    .sort((left: any, right: any) => getComparableUpdatedAt(right) - getComparableUpdatedAt(left))
    .slice(0, limit)
    .map((table: any) => ({
      dbKey: table.dbKey ?? null,
      tableId: table.tableId ?? null,
      displayName: table.displayName ?? table.name ?? table.title ?? "(untitled)",
      spaceId: table.spaceId ?? null,
      tenantId: table.tenantId ?? null,
      columnCount: Array.isArray(table.columns) ? table.columns.length : 0,
      createdAt: table.createdAt ?? null,
      updatedAt: table.updatedAt ?? table.updated_at ?? null,
    }));

  const envelope = { success: true, userId, ...(spaceId ? { space: spaceId } : {}), total: tables.length, tables };
  output.write(`${formatTableListOutput({ mode: outputMode, tables, envelope })}\n`);
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
  fetchImpl: typeof fetch;
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
  fetchImpl: typeof fetch;
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

  const serverUrl = resolveServerUrl(args, env);
  let response: Response;
  try {
    response = await fetchImpl(`${serverUrl}/api/table/query-rows`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tenantId,
        tableId,
        filters: filters ?? {},
        columns: resolveQueryColumns(columns, hasFlag(args, "--include-activity")),
        includeBaseFields: !hasFlag(args, "--no-base-fields"),
        limit: Number(readOption(args, "--limit") || (hasSingleRowShortcut ? 1 : 20)),
        offset: Number(readOption(args, "--offset") || 0),
        sortBy: readOption(args, "--sort-by") || "updatedAt",
        sortOrder: readOption(args, "--sort-order") === "asc" ? "asc" : "desc",
      }),
    });
  } catch (error) {
    output.write(`[nolo] table query failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const text = await response.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    output.write(text ? `${text}\n` : "");
    return response.ok ? 0 : 1;
  }
  if (!response.ok || payload?.error) {
    output.write(`[nolo] table query failed: ${payload?.error ?? response.statusText}\n`);
    return 1;
  }

  const rawData = payload.rawData ?? payload;
  output.write(`${formatOutput({ envelope: payload, rawData, mode: outputMode })}\n`);
  return 0;
}
