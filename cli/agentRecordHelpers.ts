import { readFileSync } from "node:fs";
import { DataType } from "../create/types";
import { createAgentKey } from "../database/keys";
import { resolveCliAgentKeyInput } from "./agentAliases";
import type { CliKvDb } from "./client/hybridRecordStore";
import { buildLocalAgentLookupKeys, shouldReadAgentKeyRemotely } from "./client/localAgentRecords";
import {
  parseUserIdFromAuthToken,
  readOption,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
  type EnvLike,
} from "./cliEnvHelpers";
import { readPipeText, spawnProcess } from "./processSpawn";

const PROVIDER_COPY_FIELDS = [
  "apiSource",
  "provider",
  "cliProvider",
  "model",
  "customProviderUrl",
  "apiKey",
  "useServerProxy",
  "inputPrice",
  "outputPrice",
] as const;

function readRepeatedOption(args: string[], flag: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag || !args[index + 1]) continue;
    values.push(args[index + 1]);
    index += 1;
  }
  return values;
}

function parseJsonishValue(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeAgentHandle(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase().replace(/\s+/g, " ")
    : undefined;
}

function recordHasAgentHandle(record: unknown, handle: string) {
  if (!record || typeof record !== "object") return false;
  const normalized = normalizeAgentHandle(handle);
  if (!normalized) return false;
  return normalizeAgentHandle((record as any).handle) === normalized;
}

async function findLocalAgentRecordByHandle(args: {
  handle: string;
  db: CliKvDb;
}) {
  const normalized = normalizeAgentHandle(args.handle);
  if (!normalized) return null;
  try {
    const iterator = args.db.iterator({ gte: "agent-", lte: "agent-\uffff" });
    for await (const [key, record] of iterator) {
      if (!recordHasAgentHandle(record, normalized)) continue;
      return { key, record };
    }
  } catch {
    // local handle scan unavailable
  }
  return null;
}

async function findRemoteAgentRecordByHandle(args: {
  handle: string;
  authToken: string;
  fallbackFetchImpl?: typeof fetch;
  fetchImpl: typeof fetch;
  serverUrl: string;
  userId: string;
}) {
  const normalized = normalizeAgentHandle(args.handle);
  if (!normalized) return null;
  const records = await queryUserRecords({
    authToken: args.authToken,
    fallbackFetchImpl: args.fallbackFetchImpl,
    fetchImpl: args.fetchImpl,
    limit: 200,
    serverUrl: args.serverUrl,
    userId: args.userId,
    type: DataType.AGENT,
  });
  return records.find((record) => recordHasAgentHandle(record, normalized)) ?? null;
}

function parsePositiveIntegerOption(raw: string | undefined, flag: string) {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return value;
}

function parseIsoTimestampOption(raw: string | undefined, flag: string) {
  if (!raw) return undefined;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) {
    throw new Error(`${flag} must be an ISO timestamp.`);
  }
  return new Date(time).toISOString();
}

async function curlFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers ?? {});
  const command = ["curl", "-sS", "-L", "-X", method];

  headers.forEach((value, key) => {
    command.push("-H", `${key}: ${value}`);
  });

  if (typeof init?.body === "string" && init.body.length > 0) {
    command.push("--data", init.body);
  }

  command.push("-w", "\n__NOLO_STATUS__:%{http_code}", url);
  const proc = spawnProcess({ cmd: command, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    readPipeText(proc.stdout),
    readPipeText(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `curl failed for ${url}`);
  }

  const marker = "\n__NOLO_STATUS__:";
  const markerIndex = stdout.lastIndexOf(marker);
  const body = markerIndex >= 0 ? stdout.slice(0, markerIndex) : stdout;
  const statusText = markerIndex >= 0 ? stdout.slice(markerIndex + marker.length).trim() : "0";
  const status = Number(statusText);
  return new Response(body, {
    status: Number.isFinite(status) ? status : 0,
    headers: { "Content-Type": headers.get("Content-Type") ?? "application/json" },
  });
}

function shouldUseCurlTransportFallback(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Unable to connect|ConnectionRefused|ECONNREFUSED|Failed to connect|Was there a typo|timed out|Timeout|handshake|certificate|ECONNRESET|socket|network/i.test(message);
}

async function fetchWithTransportFallback(
  url: string,
  init: RequestInit,
  options: { fallbackFetchImpl?: typeof fetch; fetchImpl: typeof fetch }
): Promise<Response> {
  try {
    return await options.fetchImpl(url, init);
  } catch (error) {
    if (!shouldUseCurlTransportFallback(error)) throw error;
    if (options.fallbackFetchImpl) {
      return options.fallbackFetchImpl(url, init);
    }
    if (options.fetchImpl !== fetch) throw error;
    return curlFetch(url, init);
  }
}

export async function readAgentRecord(args: {
  agentKey: string;
  authToken: string;
  fallbackFetchImpl?: typeof fetch;
  fetchImpl: typeof fetch;
  serverUrl: string;
}) {
  const res = await fetchWithTransportFallback(
    `${args.serverUrl}/api/v1/db/read/${encodeURIComponent(args.agentKey)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${args.authToken}` },
    },
    args
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`read failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data?.data ?? data;
}

export async function readDbRecord(args: {
  dbKey: string;
  authToken: string;
  fallbackFetchImpl?: typeof fetch;
  fetchImpl: typeof fetch;
  includeDeleted?: boolean;
  serverUrl: string;
}) {
  const query = args.includeDeleted ? "?includeDeleted=true" : "";
  const res = await fetchWithTransportFallback(
    `${args.serverUrl}/api/v1/db/read/${encodeURIComponent(args.dbKey)}${query}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${args.authToken}` },
    },
    args
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`read failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data?.data ?? data;
}

export async function queryUserRecords(args: {
  authToken: string;
  fallbackFetchImpl?: typeof fetch;
  fetchImpl: typeof fetch;
  limit?: number;
  serverUrl: string;
  summary?: boolean;
  includeDeleted?: boolean;
  userId: string;
  type: string | string[];
}): Promise<any[]> {
  const query = typeof args.limit === "number" && args.limit > 0
    ? `?limit=${Math.floor(args.limit)}`
    : "";
  const res = await fetchWithTransportFallback(
    `${args.serverUrl}/api/v1/db/query/${encodeURIComponent(args.userId)}${query}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: args.type,
        ...(args.includeDeleted ? { includeDeleted: true } : {}),
        ...(args.summary ? { summary: true } : {}),
      }),
    },
    args
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`query failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return Array.isArray(data?.data?.data)
    ? data.data.data
    : Array.isArray(data?.data)
      ? data.data
      : [];
}

export async function deleteDbRecord(args: {
  dbKey: string;
  deleteOptions?: { type?: "single" | "table" | "messages" };
  authToken: string;
  fallbackFetchImpl?: typeof fetch;
  fetchImpl: typeof fetch;
  serverUrl: string;
}) {
  const type = args.deleteOptions?.type;
  const query =
    type && type !== "single"
      ? `?type=${encodeURIComponent(type)}`
      : "";
  const res = await fetchWithTransportFallback(
    `${args.serverUrl}/api/v1/db/delete/${encodeURIComponent(args.dbKey)}${query}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${args.authToken}` },
    },
    args
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`delete failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

export async function writeAgentRecord(args: {
  agentKey: string;
  authToken: string;
  fallbackFetchImpl?: typeof fetch;
  fetchImpl: typeof fetch;
  serverUrl: string;
  userId: string;
  record: Record<string, any>;
}) {
  const res = await fetchWithTransportFallback(`${args.serverUrl}/api/v1/db/write/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customKey: args.agentKey,
      userId: args.userId,
      data: {
        ...args.record,
        dbKey: args.agentKey,
      },
    }),
  }, args);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`write failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
}

export async function resolveAgentRecordFromHybridStore(args: {
  agentInput: string;
  cliArgs?: string[];
  env: EnvLike;
  db: CliKvDb;
  fetchImpl: typeof fetch;
  fallbackFetchImpl?: typeof fetch;
}) {
  const agentKey = resolveCliAgentKeyInput(args.agentInput);
  const authToken = args.cliArgs
    ? resolveAuthToken(args.cliArgs, args.env)
    : resolveAuthToken(args.env);
  const defaultServerUrl = args.cliArgs
    ? resolveServerUrl(args.cliArgs, args.env)
    : resolveServerUrl(args.env);
  const userId = parseUserIdFromAuthToken(authToken) || "local";

  for (const key of buildLocalAgentLookupKeys({
    agentRef: agentKey,
    userId,
  })) {
    try {
      const record = await args.db.get(key);
      if (record && typeof record === "object") {
        return {
          agentKey: key,
          record,
          source: record?.serverOrigin ? "remote-cache" : "local-cache",
        } as const;
      }
    } catch {
      // local miss
    }

    if (!shouldReadAgentKeyRemotely(key)) continue;
    for (const serverUrl of (
      args.cliArgs
        ? resolveServerCandidates(args.cliArgs, args.env, defaultServerUrl)
        : resolveServerCandidates(args.env, defaultServerUrl)
    )) {
      try {
        const remoteRecord = await readAgentRecord({
          agentKey: key,
          authToken,
          fallbackFetchImpl: args.fallbackFetchImpl,
          fetchImpl: args.fetchImpl,
          serverUrl,
        });
        const cached = { ...remoteRecord, dbKey: key, serverOrigin: serverUrl };
        await args.db.put(key, cached);
        return {
          agentKey: key,
          record: cached,
          source: "remote-cache",
        } as const;
      } catch {
        // try next
      }
    }
  }

  const localHandleRecord = await findLocalAgentRecordByHandle({
    handle: args.agentInput,
    db: args.db,
  });
  if (localHandleRecord) {
    return {
      agentKey: localHandleRecord.key,
      record: localHandleRecord.record,
      source: localHandleRecord.record?.serverOrigin ? "remote-cache" : "local-cache",
    } as const;
  }

  if (authToken && userId !== "local") {
    for (const serverUrl of (
      args.cliArgs
        ? resolveServerCandidates(args.cliArgs, args.env, defaultServerUrl)
        : resolveServerCandidates(args.env, defaultServerUrl)
    )) {
      try {
        const remoteRecord = await findRemoteAgentRecordByHandle({
          handle: args.agentInput,
          authToken,
          fallbackFetchImpl: args.fallbackFetchImpl,
          fetchImpl: args.fetchImpl,
          serverUrl,
          userId,
        });
        if (!remoteRecord || typeof remoteRecord !== "object") continue;
        const key = typeof remoteRecord.dbKey === "string" && remoteRecord.dbKey
          ? remoteRecord.dbKey
          : typeof remoteRecord.key === "string" && remoteRecord.key
            ? remoteRecord.key
            : "";
        if (!key) continue;
        const cached = { ...remoteRecord, dbKey: key, serverOrigin: serverUrl };
        await args.db.put(key, cached);
        return {
          agentKey: key,
          record: cached,
          source: "remote-cache",
        } as const;
      } catch {
        // try next
      }
    }
  }

  return null;
}

export function normalizeAgentRecordForOutput(agentKey: string, authToken: string, agent: any) {
  return {
    agentKey,
    baseUrl: agent?.serverOrigin ?? null,
    name: agent?.name,
    greeting: agent?.greeting,
    model: agent?.model,
    provider: agent?.provider ?? agent?.apiSource ?? null,
    cliProvider: agent?.cliProvider ?? null,
    customProviderUrl: agent?.customProviderUrl ?? null,
    tools: agent?.tools ?? [],
    isPublic: agent?.isPublic,
    authUserId: parseUserIdFromAuthToken(authToken),
    userId: agent?.userId,
    record: agent,
  };
}

export function parseAgentUpdateArgs(args: string[]) {
  const agentInput = readOption(args, "--agent") ?? readOption(args, "--id") ?? args[0]?.trim();
  if (!agentInput || agentInput === "--help" || agentInput === "-h") return null;

  const updates: Record<string, unknown> = {};
  const model = readOption(args, "--model");
  const cliProvider = readOption(args, "--cli-provider");
  const apiSource = readOption(args, "--api-source");
  const provider = readOption(args, "--provider");
  const prompt = readOption(args, "--prompt");
  const promptFile = readOption(args, "--prompt-file");
  const promptDoc = readOption(args, "--prompt-doc");
  const tools = readOption(args, "--tools");
  const copyProviderFrom = readOption(args, "--copy-provider-from");
  const name = readOption(args, "--name");
  const customProviderUrl = readOption(args, "--custom-provider-url");
  const apiKey = readOption(args, "--api-key");
  const maxConcurrent = parsePositiveIntegerOption(
    readOption(args, "--max-concurrent"),
    "--max-concurrent",
  );
  const expiresAt = parseIsoTimestampOption(readOption(args, "--expires-at"), "--expires-at");
  const handle = readOption(args, "--handle")?.trim();

  const promptSources = [prompt, promptFile, promptDoc].filter(Boolean);
  if (promptSources.length > 1) {
    throw new Error("--prompt / --prompt-file / --prompt-doc are mutually exclusive.");
  }

  if (model) updates.model = model;
  if (cliProvider) updates.cliProvider = cliProvider;
  if (apiSource) updates.apiSource = apiSource;
  if (provider) updates.provider = provider;
  if (prompt) updates.prompt = prompt;
  if (promptFile) updates.prompt = readFileSync(promptFile, "utf8");
  if (tools) updates.tools = parseJsonishValue(tools);
  if (name) updates.name = name;
  if (customProviderUrl) updates.customProviderUrl = customProviderUrl;
  if (apiKey) updates.apiKey = apiKey;
  if (maxConcurrent != null) updates.admission = { maxConcurrent };
  if (expiresAt) {
    updates.scheduling = { expiresAt };
  }
  if (handle) updates.handle = handle;

  for (const entry of readRepeatedOption(args, "--field")) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      throw new Error(`--field must use key=value, received ${JSON.stringify(entry)}`);
    }
    updates[entry.slice(0, index)] = parseJsonishValue(entry.slice(index + 1));
  }

  if (Object.keys(updates).length === 0) {
    if (!promptDoc && !copyProviderFrom) {
      throw new Error("No updates provided. Use --model / --cli-provider / --api-source / --field key=value.");
    }
  }

  return { agentInput, updates, promptDoc, copyProviderFrom };
}

export async function buildCreatedAgentRecord(args: {
  cliArgs?: string[];
  parsed: NonNullable<ReturnType<typeof parseAgentUpdateArgs>>;
  env: EnvLike;
  db: CliKvDb;
  fetchImpl: typeof fetch;
  fallbackFetchImpl?: typeof fetch;
  authToken: string;
}) {
  const serverUrl = args.cliArgs ? resolveServerUrl(args.cliArgs, args.env) : resolveServerUrl(args.env);
  const userId = parseUserIdFromAuthToken(args.authToken);
  const resolvedAgentInput = resolveCliAgentKeyInput(args.parsed.agentInput);
  const agentKey = resolvedAgentInput.startsWith("agent-")
    ? resolvedAgentInput
    : createAgentKey.private(userId || "local", resolvedAgentInput);

  if (args.parsed.copyProviderFrom) {
    const providerSource = await resolveAgentRecordFromHybridStore({
      agentInput: args.parsed.copyProviderFrom,
      cliArgs: args.cliArgs,
      env: args.env,
      db: args.db,
      fetchImpl: args.fetchImpl,
      fallbackFetchImpl: args.fallbackFetchImpl,
    });
    if (!providerSource) {
      throw new Error(`provider source agent not found: ${args.parsed.copyProviderFrom}`);
    }
    for (const field of PROVIDER_COPY_FIELDS) {
      if (field in providerSource.record) {
        args.parsed.updates[field] = providerSource.record[field];
      }
    }
  }

  if (args.parsed.promptDoc) {
    const promptDoc = await readDbRecord({
      dbKey: args.parsed.promptDoc,
      authToken: args.authToken,
      fallbackFetchImpl: args.fallbackFetchImpl,
      fetchImpl: args.fetchImpl,
      serverUrl,
    });
    const promptBody = typeof promptDoc?.content === "string" ? promptDoc.content : "";
    if (!promptBody.trim()) {
      throw new Error(`prompt doc is empty or unreadable: ${args.parsed.promptDoc}`);
    }
    args.parsed.updates.prompt = promptBody;
  }

  const nextRecord = {
    ...args.parsed.updates,
    dbKey: agentKey,
    key: agentKey,
    type: DataType.AGENT,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    userId,
  };

  return {
    agentKey,
    serverUrl,
    nextRecord,
    updates: args.parsed.updates,
  };
}

export async function buildUpdatedAgentRecord(args: {
  cliArgs?: string[];
  parsed: NonNullable<ReturnType<typeof parseAgentUpdateArgs>>;
  env: EnvLike;
  db: CliKvDb;
  fetchImpl: typeof fetch;
  fallbackFetchImpl?: typeof fetch;
  authToken: string;
}) {
  const cached = await resolveAgentRecordFromHybridStore({
    agentInput: args.parsed.agentInput,
    cliArgs: args.cliArgs,
    env: args.env,
    db: args.db,
    fetchImpl: args.fetchImpl,
    fallbackFetchImpl: args.fallbackFetchImpl,
  });
  const agentKey = cached?.agentKey ?? resolveCliAgentKeyInput(args.parsed.agentInput);
  const explicitServerUrl = args.cliArgs
    ? readOption(args.cliArgs, "--server-url") || readOption(args.cliArgs, "--server")
    : undefined;
  const envServerUrl = args.env.NOLO_SERVER || args.env.BASE_URL || args.env.NOLO_SERVER_URL;
  const requestedServerUrl = explicitServerUrl || envServerUrl
    ? (args.cliArgs ? resolveServerUrl(args.cliArgs, args.env) : resolveServerUrl(args.env))
    : undefined;
  const serverUrl = requestedServerUrl || cached?.record?.serverOrigin || resolveServerUrl(args.env);
  const currentRecord = await readAgentRecord({
    agentKey,
    authToken: args.authToken,
    fallbackFetchImpl: args.fallbackFetchImpl,
    fetchImpl: args.fetchImpl,
    serverUrl,
  });

  if (args.parsed.copyProviderFrom) {
    const providerSource = await resolveAgentRecordFromHybridStore({
      agentInput: args.parsed.copyProviderFrom,
      cliArgs: args.cliArgs,
      env: args.env,
      db: args.db,
      fetchImpl: args.fetchImpl,
      fallbackFetchImpl: args.fallbackFetchImpl,
    });
    if (!providerSource) {
      throw new Error(`provider source agent not found: ${args.parsed.copyProviderFrom}`);
    }
    for (const field of PROVIDER_COPY_FIELDS) {
      if (field in providerSource.record) {
        args.parsed.updates[field] = providerSource.record[field];
      }
    }
  }

  if (args.parsed.promptDoc) {
    const promptDoc = await readDbRecord({
      dbKey: args.parsed.promptDoc,
      authToken: args.authToken,
      fallbackFetchImpl: args.fallbackFetchImpl,
      fetchImpl: args.fetchImpl,
      serverUrl,
    });
    const promptBody = typeof promptDoc?.content === "string" ? promptDoc.content : "";
    if (!promptBody.trim()) {
      throw new Error(`prompt doc is empty or unreadable: ${args.parsed.promptDoc}`);
    }
    args.parsed.updates.prompt = promptBody;
  }

  const nextRecord = {
    ...currentRecord,
    ...args.parsed.updates,
    updatedAt: Date.now(),
  };

  return {
    agentKey,
    serverUrl,
    nextRecord,
    updates: args.parsed.updates,
  };
}
