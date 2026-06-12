import type { AgentCommandDeps } from "./agentCommandSupport";
import { buildSpaceLookup, getSpaceContentKeys } from "./cliSpaceHelpers";
import {
  parseUserIdFromAuthToken,
  readOption,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
} from "./cliEnvHelpers";
import {
  deleteDbRecordOnServers,
  listUserRecordsFromServers,
  readDbRecordFromServers,
  readLiveDbRecordAfterTombstoneMerge,
} from "./globalRecordOperations";
import {
  deleteDialogAttachmentCandidates,
  planDialogAttachmentCleanup,
} from "./dialogAttachmentCleanup";

type ReadSource = "http" | "local-db-fallback";

type HttpAttempt = {
  base: string;
  ok: boolean;
  status?: number;
  message?: string;
};

type ListedDialog = {
  id: string;
  dbKey: string;
  title: string;
  status: string | null;
  updatedAt: string | number | null;
  createdAt: string | number | null;
  spaceId: string | null;
  triggerType: string | null;
  primaryAgentKey: string | null;
  cybots: string[];
};

const DIALOG_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const DIALOG_PATH_RE = /^\/(?:space\/([^/]+)\/)?dialog-(.+)-([0-9A-HJKMNP-TV-Z]{26})\/?$/i;
const VALUE_FLAGS = new Set([
  "--limit",
  "--server",
  "--server-url",
  "--space",
  "--space-id",
  "--token",
  "--machine-key",
  "--user",
]);

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function readFirstPositional(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (VALUE_FLAGS.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) return value;
  }
  return undefined;
}

function readAllPositional(args: string[]) {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (VALUE_FLAGS.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) {
      positionals.push(value);
    }
  }
  return positionals;
}

function readLimit(args: string[], fallback: number) {
  const raw = readOption(args, "--limit");
  const parsed = raw ? Number(raw) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getDialogIdFromKey(dbKey: string) {
  const index = dbKey.lastIndexOf("-");
  return index >= 0 ? dbKey.slice(index + 1) : dbKey;
}

function resolveDialogInput(rawInput: string, userId: string) {
  const raw = rawInput.trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const url = new URL(raw);
    const match = url.pathname.match(DIALOG_PATH_RE);
    if (!match) {
      throw new Error(`Unsupported dialog URL path: ${url.pathname}`);
    }
    const [, spaceId, ownerId, dialogId] = match;
    return {
      dbKey: `dialog-${ownerId}-${dialogId}`,
      dialogId,
      ownerId,
      spaceId: spaceId ? decodeURIComponent(spaceId) : null,
    };
  }

  if (raw.startsWith("dialog-")) {
    const dialogId = getDialogIdFromKey(raw);
    return {
      dbKey: raw,
      dialogId,
      ownerId: raw.slice("dialog-".length, Math.max("dialog-".length, raw.length - dialogId.length - 1)),
      spaceId: null,
    };
  }

  if (!DIALOG_ID_RE.test(raw)) {
    throw new Error(`Unsupported dialog id: ${raw}`);
  }

  return {
    dbKey: `dialog-${userId}-${raw}`,
    dialogId: raw,
    ownerId: userId,
    spaceId: null,
  };
}

function normalizeDialogRecord(record: any, fallbackDbKey?: string): ListedDialog | null {
  const dbKey =
    typeof record?.dbKey === "string" && record.dbKey.trim()
      ? record.dbKey.trim()
      : fallbackDbKey ?? "";
  const id =
    typeof record?.id === "string" && record.id.trim()
      ? record.id.trim()
      : dbKey
        ? getDialogIdFromKey(dbKey)
        : "";
  if (!dbKey || !id) return null;

  return {
    id,
    dbKey,
    title:
      typeof record?.title === "string" && record.title.trim()
        ? record.title.trim()
        : typeof record?.taskLabel === "string" && record.taskLabel.trim()
          ? record.taskLabel.trim()
          : "(untitled)",
    status: typeof record?.status === "string" ? record.status : null,
    updatedAt:
      typeof record?.updatedAt === "string" || typeof record?.updatedAt === "number"
        ? record.updatedAt
        : typeof record?.updated_at === "string" || typeof record?.updated_at === "number"
          ? record.updated_at
          : null,
    createdAt:
      typeof record?.createdAt === "string" || typeof record?.createdAt === "number"
        ? record.createdAt
        : typeof record?.created === "string" || typeof record?.created === "number"
          ? record.created
          : null,
    spaceId: typeof record?.spaceId === "string" && record.spaceId.trim() ? record.spaceId : null,
    triggerType: typeof record?.triggerType === "string" ? record.triggerType : null,
    primaryAgentKey:
      typeof record?.primaryAgentKey === "string" && record.primaryAgentKey.trim()
        ? record.primaryAgentKey
        : null,
    cybots: Array.isArray(record?.cybots)
      ? record.cybots.filter((agent: unknown): agent is string => typeof agent === "string")
      : [],
  };
}

function sortDialogs(dialogs: ListedDialog[]) {
  return dialogs.sort((a, b) => {
    const ta = a.updatedAt ?? a.createdAt ?? 0;
    const tb = b.updatedAt ?? b.createdAt ?? 0;
    const left = typeof ta === "number" ? ta : Date.parse(String(ta)) || 0;
    const right = typeof tb === "number" ? tb : Date.parse(String(tb)) || 0;
    return right - left;
  });
}

function isScheduledDialog(record: ListedDialog) {
  return record.triggerType === "scheduled_run";
}

function printListUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo dialog list [--space <spaceId|spaceUrl>] [--limit 100] [--json] [--ids-only]

Options:
  --space <space>       List current user's dialogs attached to one space.
  --limit <n>           Maximum dialogs to return. Default: 100.
  --include-scheduled   Include scheduled automation run dialogs.
  --json                Print machine-readable JSON.
  --ids-only            Print only dialog ids.
  --server <url>        Override NOLO_SERVER/BASE_URL.
  --token <jwt>         Override AUTH_TOKEN.

Lists merge global server candidates and ignore newer tombstones.
`);
}

function printDeleteUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo dialog delete <dialogId|dialogKey|dialogUrl...> [--yes] [--include-attachments] [--include-referenced-attachments] [--json]

Options:
  --yes                  Actually delete. Without this, the command is a dry-run.
  --include-attachments  Also delete files explicitly owned by this dialog/messages.
  --include-referenced-attachments
                         Also delete same-account user-owned files referenced by this dialog.
  --json                 Print machine-readable JSON.
  --server <url>         Prefer this server and include it in global deletion.
  --token <jwt>          Override AUTH_TOKEN.

Deletes are global across the selected/profile server plus known Nolo cluster peers.
Attachment cleanup is conservative by default. Use --include-referenced-attachments only
when you intentionally want to remove user-owned files referenced by the dialog too.
`);
}

function printReadUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo dialog read <dialogId|dialogKey|dialogUrl> [limit]

Options:
  --server <url>  Prefer this server when reading by raw dialog id.
  --token <jwt>   Override AUTH_TOKEN.
  --user <userId> Override dialog owner for raw dialog ids.

Reads dialog metadata and messages as JSON.
`);
}

function printStatusUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo dialog status <dialogId|dialogKey|dialogUrl>

Options:
  --server <url>  Prefer this server when reading by raw dialog id.
  --token <jwt>   Override AUTH_TOKEN.
  --user <userId> Override dialog owner for raw dialog ids.

Prints compact dialog run status and next-step hints.
`);
}

function isHelpArg(value?: string) {
  return value === "-h" || value === "--help";
}

function readDialogLimitArg(args: string[], fallback: number) {
  const explicit = readOption(args, "--limit");
  const positional = args.find((value, index) =>
    index > 0 && /^\d+$/.test(value) && args[index - 1] !== "--limit"
  );
  const raw = explicit ?? positional;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readDialogOwnerId(args: string[], env: Record<string, string | undefined>, authToken: string) {
  return readOption(args, "--user") ??
    env.USER_ID ??
    parseUserIdFromAuthToken(authToken) ??
    "";
}

function resolveDialogReadTarget(args: string[], env: Record<string, string | undefined>, authToken: string) {
  const rawInput = readFirstPositional(args);
  if (!rawInput) return null;
  const preferredServer = readOption(args, "--server") ?? readOption(args, "--server-url");
  const ownerFallback = readDialogOwnerId(args, env, authToken);

  const raw = rawInput.trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const url = new URL(raw);
    const match = url.pathname.match(DIALOG_PATH_RE);
    if (!match) throw new Error(`Unsupported dialog URL path: ${url.pathname}`);
    const [, spaceId, ownerId, dialogId] = match;
    const base = preferredServer ?? env.READ_DIALOG_BASE ?? url.origin;
    return {
      base,
      dialogId,
      dialogKey: `dialog-${ownerId}-${dialogId}`,
      userId: ownerId,
      spaceId: spaceId ? decodeURIComponent(spaceId) : undefined,
    };
  }

  if (raw.startsWith("dialog-")) {
    const dialogId = getDialogIdFromKey(raw);
    const ownerId = raw.slice("dialog-".length, Math.max("dialog-".length, raw.length - dialogId.length - 1));
    return {
      base: preferredServer ?? env.READ_DIALOG_BASE ?? resolveServerUrl(args, env),
      dialogId,
      dialogKey: raw,
      userId: ownerId || ownerFallback,
    };
  }

  if (!DIALOG_ID_RE.test(raw)) {
    throw new Error(`Unsupported dialog id: ${raw}`);
  }

  if (!ownerFallback) {
    throw new Error("raw dialog ids require an auth token userId or --user");
  }
  return {
    base: preferredServer ?? env.READ_DIALOG_BASE ?? resolveServerUrl(args, env),
    dialogId: raw,
    dialogKey: `dialog-${ownerFallback}-${raw}`,
    userId: ownerFallback,
  };
}

function toToolName(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function countByName(values: string[]) {
  return values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function uniq(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function parseJsonObject(raw: unknown): Record<string, any> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function deriveWrittenFiles(toolMessages: any[]) {
  const writeToolNames = new Set(["applyEdit", "applyLineEdits", "writeFile", "createDoc", "updateDoc"]);
  const files: string[] = [];
  for (const message of toolMessages) {
    const toolName = toToolName(message?.toolName ?? message?.name);
    if (!writeToolNames.has(toolName)) continue;
    const payload = message?.toolPayload ?? {};
    const content = parseJsonObject(message?.content);
    for (const candidate of [payload?.input?.filePath, payload?.response?.filePath, content?.filePath]) {
      const normalized = typeof candidate === "string" ? candidate.trim() : "";
      if (normalized) files.push(normalized);
    }
  }
  return uniq(files);
}

function deriveToolErrors(toolMessages: any[]) {
  const errors: string[] = [];
  for (const message of toolMessages) {
    const toolName = toToolName(message?.toolName ?? message?.name);
    const payload = message?.toolPayload ?? {};
    const content = parseJsonObject(message?.content);
    if (payload?.status === "failed" || content?.ok === false || content?.applied === false || content?.success === false) {
      errors.push(toolName || "unknown-tool");
    }
  }
  return uniq(errors);
}

function isLocalBaseUrl(base: string) {
  try {
    const url = new URL(base);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

async function readDialogOverHttp(args: {
  base: string;
  dialogKey: string;
  dialogId: string;
  limit: number;
  authToken: string;
  fetchImpl: typeof fetch;
}) {
  const authHeaders = {
    Authorization: `Bearer ${args.authToken}`,
    "Content-Type": "application/json",
  };
  const readViaBridge = async () => {
    const bridgeRes = await args.fetchImpl(`${args.base}/api/dialog-read`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        dialogKey: args.dialogKey,
        dialogId: args.dialogId,
        limit: args.limit,
      }),
    });
    if (!bridgeRes.ok) {
      throw Object.assign(new Error(`dialog read bridge failed: HTTP ${bridgeRes.status}`), {
        status: bridgeRes.status,
        base: args.base,
      });
    }
    const payload = await bridgeRes.json();
    if (!payload?.ok) {
      throw Object.assign(new Error(`dialog read bridge failed: ${payload?.error ?? "unknown error"}`), {
        status: 500,
        base: args.base,
      });
    }
    return {
      meta: payload.meta,
      msgs: payload.msgs,
      source: "http" as ReadSource,
    };
  };

  const metaRes = await args.fetchImpl(
    `${args.base}/api/v1/db/read/${encodeURIComponent(args.dialogKey)}`,
    { headers: { Authorization: `Bearer ${args.authToken}` } }
  );
  if (!metaRes.ok) {
    if (metaRes.status === 401 || metaRes.status === 403) return readViaBridge();
    throw Object.assign(new Error(`read dialog meta failed: HTTP ${metaRes.status}`), {
      status: metaRes.status,
      base: args.base,
    });
  }
  const meta = await metaRes.json();

  const msgsRes = await args.fetchImpl(`${args.base}/rpc/getConvMsgs`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ dialogId: args.dialogId, limit: args.limit }),
  });
  if (!msgsRes.ok) {
    if (msgsRes.status === 401 || msgsRes.status === 403) return readViaBridge();
    throw Object.assign(new Error(`read dialog messages failed: HTTP ${msgsRes.status}`), {
      status: msgsRes.status,
      base: args.base,
    });
  }
  return {
    meta,
    msgs: await msgsRes.json(),
    source: "http" as ReadSource,
  };
}

async function tryHttpDialogCandidates(args: {
  bases: string[];
  dialogKey: string;
  dialogId: string;
  limit: number;
  authToken: string;
  fetchImpl: typeof fetch;
}) {
  const attempts: HttpAttempt[] = [];
  for (const base of args.bases) {
    try {
      const result = await readDialogOverHttp({ ...args, base });
      attempts.push({ base, ok: true });
      return { ...result, resolvedBase: base, attempts };
    } catch (error) {
      attempts.push({
        base,
        ok: false,
        status:
          typeof error === "object" && error !== null && "status" in error
            ? Number((error as any).status)
            : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw Object.assign(new Error("All HTTP dialog reads failed"), { attempts });
}

async function readDialogFromLocalDb(dialogKey: string, dialogId: string, limit: number) {
  const { readDialogFromLocalDb: readLocalDialog } = await import("./agent-runtime/localDialogRead");
  const result = await readLocalDialog({ dialogKey, dialogId, limit });
  return {
    ...result,
    source: "local-db-fallback" as ReadSource,
  };
}

async function readDialogSnapshot(args: {
  authToken: string;
  base: string;
  dialogId: string;
  dialogKey: string;
  fetchImpl: typeof fetch;
  limit: number;
}) {
  const candidateBases = resolveServerCandidates({ NOLO_SERVER: args.base }, args.base);
  let attempts: HttpAttempt[] = [];
  try {
    const result = await tryHttpDialogCandidates({
      bases: candidateBases,
      dialogKey: args.dialogKey,
      dialogId: args.dialogId,
      limit: args.limit,
      authToken: args.authToken,
      fetchImpl: args.fetchImpl,
    });
    return { ...result, candidateBases };
  } catch (error) {
    attempts =
      typeof error === "object" && error !== null && "attempts" in error
        ? ((error as any).attempts as HttpAttempt[])
        : attempts;
    const statuses = attempts.map((attempt) => attempt.status).filter((status): status is number => typeof status === "number");
    const all404 = attempts.length > 0 && statuses.length === attempts.length && statuses.every((status) => status === 404);
    const localhostCandidate = candidateBases.find(isLocalBaseUrl);
    if (!localhostCandidate || all404) {
      throw Object.assign(new Error(
        all404
          ? `dialog not found on tried servers: ${candidateBases.join(", ")}`
          : `read dialog failed across candidates: ${attempts.map((attempt) => `${attempt.base} -> ${attempt.status ?? attempt.message}`).join("; ")}`
      ), { attempts });
    }
    const fallback = await readDialogFromLocalDb(args.dialogKey, args.dialogId, args.limit);
    return {
      ...fallback,
      resolvedBase: localhostCandidate,
      attempts,
      candidateBases,
    };
  }
}

function compact(value: unknown, max = 180) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function renderCompactDialogStatus(snapshot: any) {
  const checkpoint = snapshot.runtimeCheckpoint ?? {};
  const checkpointStatus = typeof checkpoint.status === "string" ? checkpoint.status : null;
  const status = snapshot.status ?? checkpointStatus ?? "unknown";
  const state =
    checkpointStatus === "done" || checkpointStatus === "completed" || status === "done" || status === "completed"
      ? "done"
      : checkpointStatus === "failed" || checkpointStatus === "error" || status === "failed" || status === "error"
        ? "failed"
        : status === "running" || status === "pending" || status === "queued"
          ? "active"
          : "unknown";
  const tools = Array.isArray(snapshot.toolsUsed)
    ? snapshot.toolsUsed.filter((tool: unknown): tool is string => typeof tool === "string" && tool.trim()).slice(0, 8)
    : Array.isArray(checkpoint.lastToolNames)
      ? checkpoint.lastToolNames.filter((tool: unknown): tool is string => typeof tool === "string" && tool.trim()).slice(0, 8)
      : [];
  const files = Array.isArray(snapshot.writtenFiles) && snapshot.writtenFiles.length
    ? snapshot.writtenFiles.filter((file: unknown): file is string => typeof file === "string" && file.trim()).slice(0, 8)
    : snapshot.artifacts && typeof snapshot.artifacts === "object" && Array.isArray(snapshot.artifacts.changedFiles ?? snapshot.artifacts.writtenFiles ?? snapshot.artifacts.files)
      ? (snapshot.artifacts.changedFiles ?? snapshot.artifacts.writtenFiles ?? snapshot.artifacts.files)
        .filter((file: unknown): file is string => typeof file === "string" && file.trim())
        .slice(0, 8)
      : [];
  const subjectRefs = Array.isArray(snapshot.subjectRefs)
    ? snapshot.subjectRefs
      .map((ref: any) => {
        const kind = typeof ref?.kind === "string" ? ref.kind.trim() : "";
        const id = typeof ref?.id === "string" ? ref.id.trim() : "";
        if (!kind || !id) return "";
        const role = typeof ref?.role === "string" && ref.role.trim() ? `#${ref.role.trim()}` : "";
        return `${kind}:${id}${role}`;
      })
      .filter(Boolean)
      .slice(0, 8)
    : [];
  const toolErrors = Array.isArray(snapshot.toolErrors)
    ? snapshot.toolErrors.filter((tool: unknown): tool is string => typeof tool === "string" && tool.trim()).slice(0, 8)
    : [];
  const checkpointUpdatedAt = typeof checkpoint.updatedAt === "number" || typeof checkpoint.updatedAt === "string"
    ? Date.parse(String(checkpoint.updatedAt))
    : NaN;
  const activeHealth = state !== "active"
    ? ""
    : !snapshot.runtimeCheckpoint
      ? "no-checkpoint"
      : !Number.isFinite(checkpointUpdatedAt)
        ? "checkpoint-without-updatedAt"
        : Date.now() - checkpointUpdatedAt > 5 * 60_000
          ? "stale-running"
          : "running";
  const errorMessage = compact(checkpoint.errorMessage ?? snapshot.errorMessage);
  const lines = [
    `dialog: ${snapshot.dialogId}`,
    ...(snapshot.base ? [`base: ${snapshot.base}`] : []),
    ...(snapshot.title ? [`title: ${snapshot.title}`] : []),
    ...(snapshot.parentDialogId ? [`parentDialogId: ${snapshot.parentDialogId}`] : []),
    ...(snapshot.rootDialogId ? [`rootDialogId: ${snapshot.rootDialogId}`] : []),
    `status: ${status}`,
    ...(checkpointStatus ? [`checkpoint: ${checkpointStatus}`] : []),
    `state: ${state}`,
    ...(activeHealth ? [`activeHealth: ${activeHealth}`] : []),
    ...(typeof snapshot.durationMs === "number" ? [`durationMs: ${snapshot.durationMs}`] : []),
    ...(snapshot.updatedAt ? [`updatedAt: ${snapshot.updatedAt}`] : []),
    ...(snapshot.finishedAt ? [`finishedAt: ${snapshot.finishedAt}`] : []),
    ...(compact(checkpoint.lastUserInput) ? [`lastUserInput: ${compact(checkpoint.lastUserInput)}`] : []),
    ...(compact(checkpoint.lastAssistantText) ? [`lastAssistantText: ${compact(checkpoint.lastAssistantText)}`] : []),
    ...(errorMessage ? [`error: ${errorMessage}`] : []),
    ...(tools.length ? [`tools: ${tools.join(", ")}`] : []),
    ...(files.length ? [`files: ${files.join(", ")}`] : []),
    ...(subjectRefs.length ? [`subjects: ${subjectRefs.join(", ")}`] : []),
    ...(toolErrors.length ? [`toolErrors: ${toolErrors.join(", ")}`] : []),
    "",
    "next:",
    `- read full dialog: nolo dialog read ${snapshot.dialogId} 120`,
  ];
  if (state === "active") lines.push(`- poll again: nolo dialog status ${snapshot.dialogId}`);
  else if (state === "failed") lines.push(`- inspect failure and rerun/continue with: nolo agent run <agent> --continue ${snapshot.dialogId} --msg "..."`);
  else if (state === "done") lines.push("- use artifacts/files above for review, handoff, or alpha integration.");
  else lines.push("- inspect meta/messages before deciding whether to continue or rerun.");
  return `${lines.join("\n")}\n`;
}

async function readSpaceDialogRecords(args: {
  authToken: string;
  fetchImpl: typeof fetch;
  fallbackFetchImpl?: typeof fetch;
  serverUrls: string[];
  spaceInput: string;
  userId: string;
}) {
  const { spaceId, spaceKey } = buildSpaceLookup(args.spaceInput);
  const spaceRead = await readLiveDbRecordAfterTombstoneMerge({
    authToken: args.authToken,
    dbKey: spaceKey,
    fallbackFetchImpl: args.fallbackFetchImpl,
    fetchImpl: args.fetchImpl,
    label: "space record",
    serverUrls: args.serverUrls,
  });
  const contentKeys = [...getSpaceContentKeys(spaceRead.record)]
    .filter((key) => key.startsWith(`dialog-${args.userId}-`));
  const contentKeySet = new Set(contentKeys);
  const dialogResult = await listUserRecordsFromServers({
    authToken: args.authToken,
    fallbackFetchImpl: args.fallbackFetchImpl,
    fetchImpl: args.fetchImpl,
    label: "dialog query",
    serverUrls: args.serverUrls,
    type: "dialog",
    userId: args.userId,
  });
  const records = dialogResult.records.filter((record) =>
    typeof record?.dbKey === "string" && contentKeySet.has(record.dbKey)
  );
  const failures = [...spaceRead.failures, ...dialogResult.failures];
  return { spaceId, records, failures };
}

export async function runDialogReadCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (isHelpArg(args[0])) {
    printReadUsage(output);
    return 0;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] dialog read requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  let target: ReturnType<typeof resolveDialogReadTarget>;
  try {
    target = resolveDialogReadTarget(args, env, authToken);
  } catch (error) {
    output.write(`[nolo] dialog read failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!target) {
    printReadUsage(output);
    return 1;
  }

  try {
    const limit = readDialogLimitArg(args, 50);
    const read = await readDialogSnapshot({
      authToken,
      base: target.base,
      dialogId: target.dialogId,
      dialogKey: target.dialogKey,
      fetchImpl: deps.fetchImpl ?? fetch,
      limit,
    });
    const orderedMsgs = Array.isArray(read.msgs) ? [...read.msgs].reverse() : read.msgs;
    const lastAssistantMessage = Array.isArray(orderedMsgs)
      ? [...orderedMsgs].reverse().find((message) => message?.role === "assistant" || message?.authorRole === "assistant")
      : null;
    const toolMessages = Array.isArray(orderedMsgs)
      ? orderedMsgs.filter((message) => message?.role === "tool" || message?.authorRole === "tool")
      : [];
    const toolNamesFromMessages = toolMessages
      .map((message) => toToolName(message?.toolName ?? message?.name))
      .filter(Boolean);
    const toolsUsed = Array.isArray(read.meta?.toolsUsed) && read.meta.toolsUsed.length > 0
      ? read.meta.toolsUsed.map((tool: unknown) => toToolName(tool)).filter(Boolean)
      : uniq(toolNamesFromMessages);
    const writtenFiles = Array.isArray(read.meta?.writtenFiles) && read.meta.writtenFiles.length > 0
      ? uniq(read.meta.writtenFiles.map((value: unknown) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))
      : deriveWrittenFiles(toolMessages);
    const toolErrors = Array.isArray(read.meta?.toolErrors) && read.meta.toolErrors.length > 0
      ? uniq(read.meta.toolErrors.map((value: unknown) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))
      : deriveToolErrors(toolMessages);

    output.write(JSON.stringify({
      source: read.source as ReadSource,
      base: read.resolvedBase,
      triedBases: read.candidateBases,
      httpAttempts: read.attempts,
      spaceId: target.spaceId,
      dialogId: target.dialogId,
      dialogKey: target.dialogKey,
      userId: target.userId,
      title: read.meta?.title ?? null,
      cybots: Array.isArray(read.meta?.cybots) ? read.meta.cybots : [],
      category: read.meta?.category ?? null,
      inheritedFromDialogKey: read.meta?.inheritedFromDialogKey ?? null,
      inheritedFromDialogTitle: read.meta?.inheritedFromDialogTitle ?? null,
      parentDialogId: read.meta?.parentDialogId ?? null,
      rootDialogId: read.meta?.rootDialogId ?? null,
      status: read.meta?.status,
      errorMessage: read.meta?.errorMessage ?? null,
      runtimeCheckpoint: read.meta?.runtimeCheckpoint ?? null,
      durationMs: read.meta?.durationMs,
      finishedAt: read.meta?.finishedAt,
      createdAt: read.meta?.createdAt,
      updatedAt: read.meta?.updatedAt,
      artifacts: read.meta?.artifacts ?? null,
      writtenFiles,
      toolsUsed,
      toolErrors,
      toolSummary: {
        metaToolsCount: toolsUsed.length,
        metaToolsUnique: [...new Set(toolsUsed)],
        toolMessageCount: toolMessages.length,
        toolNamesFromMessages: [...new Set(toolNamesFromMessages)],
        toolMessageCountsByName: countByName(toolNamesFromMessages),
      },
      agentReply: read.meta?.agentReply ?? null,
      messagesCount: Array.isArray(orderedMsgs) ? orderedMsgs.length : 0,
      lastAssistantMessage,
      messages: orderedMsgs,
    }, null, 2));
    output.write("\n");
    return 0;
  } catch (error) {
    output.write(`[nolo] dialog read failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runDialogStatusCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (isHelpArg(args[0])) {
    printStatusUsage(output);
    return 0;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] dialog status requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  let target: ReturnType<typeof resolveDialogReadTarget>;
  try {
    target = resolveDialogReadTarget(args, env, authToken);
  } catch (error) {
    output.write(`[nolo] dialog status failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!target) {
    printStatusUsage(output);
    return 1;
  }

  try {
    const read = await readDialogSnapshot({
      authToken,
      base: target.base,
      dialogId: target.dialogId,
      dialogKey: target.dialogKey,
      fetchImpl: deps.fetchImpl ?? fetch,
      limit: 1,
    });
    output.write(renderCompactDialogStatus({
      ...(read.meta ?? {}),
      dialogId: target.dialogId,
      dialogKey: target.dialogKey,
      base: read.resolvedBase,
    }));
    return 0;
  } catch (error) {
    output.write(`[nolo] dialog status failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function runDialogListCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printListUsage(output);
    return 0;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] dialog list requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }
  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write("[nolo] dialog list could not read userId from AUTH_TOKEN.\n");
    return 1;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;
  const serverUrl = resolveServerUrl(args, env);
  const serverUrls = resolveServerCandidates(args, env, serverUrl);
  const limit = readLimit(args, 100);
  const spaceInput = readOption(args, "--space") ?? readOption(args, "--space-id");
  const includeScheduled = hasFlag(args, "--include-scheduled");

  try {
    let source: "user-data" | "space" = "user-data";
    let resolvedSpaceId: string | null = null;
    let queryFailures: Array<{ serverUrl: string; error: string }> = [];
    let records: any[];
    if (spaceInput) {
      source = "space";
      const result = await readSpaceDialogRecords({
        authToken,
        fallbackFetchImpl,
        fetchImpl,
        serverUrls,
        spaceInput,
        userId,
      });
      resolvedSpaceId = result.spaceId;
      records = result.records;
      queryFailures = result.failures;
    } else {
      const result = await listUserRecordsFromServers({
        authToken,
        fallbackFetchImpl,
        fetchImpl,
        label: "dialog query",
        serverUrls,
        type: "dialog",
        userId,
      });
      records = result.records;
      queryFailures = result.failures;
    }

    const dialogs = sortDialogs(
      records
        .map((record) => normalizeDialogRecord(record))
        .filter((dialog): dialog is ListedDialog => dialog != null)
        .filter((dialog) => includeScheduled || !isScheduledDialog(dialog))
    ).slice(0, limit);

    if (hasFlag(args, "--ids-only")) {
      output.write(`${dialogs.map((dialog) => dialog.id).join("\n")}\n`);
      return 0;
    }

    if (hasFlag(args, "--json")) {
      output.write(JSON.stringify({
        userId,
        ...(resolvedSpaceId ? { spaceId: resolvedSpaceId } : {}),
        source,
        targetServers: serverUrls,
        ...(queryFailures.length ? { serverFailures: queryFailures } : {}),
        total: dialogs.length,
        dialogs,
      }, null, 2));
      output.write("\n");
      return 0;
    }

    output.write(`userId: ${userId}\n`);
    if (resolvedSpaceId) output.write(`spaceId: ${resolvedSpaceId}\n`);
    output.write(`source: ${source}\n`);
    output.write(`targetServers: ${serverUrls.join(", ")}\n`);
    if (queryFailures.length) {
      output.write(`serverFailures: ${queryFailures.length}\n`);
    }
    output.write(`total dialogs: ${dialogs.length}\n`);
    for (const dialog of dialogs) {
      output.write(
        `\n${dialog.title}\nid=${dialog.id}\nstatus=${dialog.status ?? "-"}\nupdatedAt=${dialog.updatedAt ?? "-"}\ndbKey=${dialog.dbKey}\n`
      );
    }
    return 0;
  } catch (error) {
    output.write(
      `[nolo] dialog list failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 1;
  }
}

export async function runDialogDeleteCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printDeleteUsage(output);
    return 0;
  }

  const rawDialogs = readAllPositional(args);
  if (rawDialogs.length === 0) {
    printDeleteUsage(output);
    return 1;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] dialog delete requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }
  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write("[nolo] dialog delete could not read userId from AUTH_TOKEN.\n");
    return 1;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;
  const serverUrl = resolveServerUrl(args, env);
  const serverUrls = resolveServerCandidates(args, env, serverUrl);
  const shouldDelete = hasFlag(args, "--yes");
  const includeReferencedAttachments = hasFlag(args, "--include-referenced-attachments");
  const includeAttachments = hasFlag(args, "--include-attachments") || includeReferencedAttachments;

  let hasErrors = false;
  const payloads: any[] = [];

  for (const rawDialog of rawDialogs) {
    try {
      const resolved = resolveDialogInput(rawDialog, userId);
      const readResult = await readDbRecordFromServers({
        authToken,
        dbKey: resolved.dbKey,
        fallbackFetchImpl,
        fetchImpl,
        label: "dialog record",
        serverUrls,
      });
      const dialog = normalizeDialogRecord(readResult.record, resolved.dbKey);
      if (!dialog) {
        throw new Error(`dialog record is unreadable: ${resolved.dbKey}`);
      }

      const attachmentPlan = includeAttachments
        ? await planDialogAttachmentCleanup({
            authToken,
            dialogId: resolved.dialogId,
            ownerId: resolved.ownerId,
            includeUserOwnedReferenced: includeReferencedAttachments,
            fallbackFetchImpl,
            fetchImpl,
            serverUrl: readResult.serverUrl,
            serverUrls,
          })
        : null;

      const attachmentDeleteResults =
        includeAttachments && shouldDelete && attachmentPlan
          ? await deleteDialogAttachmentCandidates({
              authToken,
              candidates: attachmentPlan.deleteCandidates,
              fallbackFetchImpl,
              fetchImpl,
              serverUrls,
            })
          : [];

      let deleteResults: Awaited<ReturnType<typeof deleteDbRecordOnServers>> = [];
      if (shouldDelete) {
        deleteResults = await deleteDbRecordOnServers({
          authToken,
          dbKey: resolved.dbKey,
          fallbackFetchImpl,
          fetchImpl,
          serverUrls,
        });
      }
      const failedDeletes = deleteResults.filter((result) => !result.ok);
      const failedAttachmentDeletes = attachmentDeleteResults.flatMap((result) =>
        result.deleteResults
          .filter((deleteResult) => !deleteResult.ok)
          .map((deleteResult) => ({
            fileId: result.fileId,
            fileDbKey: result.fileDbKey,
            ...deleteResult,
          }))
      );

      if (failedDeletes.length > 0 || failedAttachmentDeletes.length > 0) {
        hasErrors = true;
      }

      const payload = {
        dbKey: resolved.dbKey,
        dialogId: resolved.dialogId,
        title: dialog.title,
        readServerUrl: readResult.serverUrl,
        targetServers: serverUrls,
        dryRun: !shouldDelete,
        deleted: shouldDelete,
        includeAttachments,
        includeReferencedAttachments,
        ...(attachmentPlan ? { attachmentPlan } : {}),
        ...(readResult.failures.length ? { readFailures: readResult.failures } : {}),
        ...(shouldDelete ? { deleteResults } : {}),
        ...(attachmentDeleteResults.length ? { attachmentDeleteResults } : {}),
      };
      payloads.push(payload);

      if (!hasFlag(args, "--json")) {
        output.write(`dialog: ${dialog.title}\n`);
        output.write(`dbKey: ${resolved.dbKey}\n`);
        output.write(`readServer: ${readResult.serverUrl}\n`);
        output.write(`targetServers: ${serverUrls.join(", ")}\n`);
        if (attachmentPlan) {
          output.write(
            `attachments: ${attachmentPlan.deleteCandidates.length} delete candidates, ${attachmentPlan.retainedCandidates.length} retained, ${attachmentPlan.bytesToDelete} bytes planned\n`
          );
          for (const candidate of attachmentPlan.retainedCandidates) {
            output.write(`retained attachment: ${candidate.fileId} (${candidate.reason})\n`);
          }
        }
        output.write(
          shouldDelete
            ? failedDeletes.length > 0
              ? `Deleted dialog on ${deleteResults.length - failedDeletes.length}/${deleteResults.length} servers. Failed: ${failedDeletes.map((result) => `${result.serverUrl} (${result.error})`).join(", ")}\n`
              : "Deleted dialog on all target servers. Server-side delete cascades dialog messages.\n"
            : includeAttachments
              ? "Dry-run only. Add --yes to delete this dialog, its messages, and delete-candidate attachments.\n"
              : "Dry-run only. Add --yes to delete this dialog and its messages.\n"
        );
        if (failedAttachmentDeletes.length > 0) {
          output.write(
            `Attachment delete failures: ${failedAttachmentDeletes.map((result) => `${result.fileDbKey}@${result.serverUrl} (${result.error})`).join(", ")}\n`
          );
        }
        if (rawDialogs.length > 1) {
          output.write("\n");
        }
      }
    } catch (error) {
      hasErrors = true;
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (hasFlag(args, "--json")) {
        payloads.push({
          rawDialog,
          error: errorMsg,
        });
      } else {
        output.write(`[nolo] dialog delete failed for ${rawDialog}: ${errorMsg}\n`);
        if (rawDialogs.length > 1) {
          output.write("\n");
        }
      }
    }
  }

  if (hasFlag(args, "--json")) {
    const finalPayload = rawDialogs.length === 1 ? payloads[0] : payloads;
    output.write(JSON.stringify(finalPayload, null, 2));
    output.write("\n");
  }

  return hasErrors ? 1 : 0;
}
