import type { AgentCommandDeps } from "./agentCommandSupport";
import type { CliFetchImpl } from "./cliFetch";
import { buildSpaceLookup, getSpaceContentKeys } from "./cliSpaceHelpers";
import {
  parseUserIdFromAuthToken,
  readOption,
  resolveAuthToken,
  resolveDeleteServerCandidates,
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
import { toErrorMessage } from "../core/errorMessage";
import { isRecord } from "../core/isRecord";
import { asOptionalTrimmedString } from "../core/optionalString";
import { parsePositiveFiniteNumberOrFallback } from "../core/positiveFiniteNumberOrFallback";
import { parsePositiveIntegerOrFallback } from "../core/positiveIntegerOrFallback";
import { asRecordOrEmpty } from "../core/recordOrEmpty";
import {
  asNonEmptyStringArray,
  asTrimmedNonEmptyStringArray,
} from "../core/stringArray";
import { asTrimmedString } from "../core/trimmedString";

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
const DEFAULT_DIALOG_LIST_LIMIT = 50;
const DEFAULT_DIALOG_QUERY_LIMIT = 50;
const UNBOUNDED_DIALOG_CAP = 100_000;
const VALUE_FLAGS = new Set([
  "--limit",
  "--offset",
  "--exclude-dialog",
  "--row-dbkey",
  "--server",
  "--server-url",
  "--space",
  "--space-id",
  "--subject-id",
  "--subject-kind",
  "--subject-role",
  "--token",
  "--machine-key",
  "--user",
]);

type ResultLimit = {
  limit: number | null;
  unlimited: boolean;
  fromDefault: boolean;
};

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

/**
 * Resolve list/query result limit.
 * - default: fallback
 * - --all or --limit 0: unlimited
 * - --limit N (N>0): N
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

function readOffset(args: string[]) {
  const raw = readOption(args, "--offset");
  if (!raw) return 0;
  return Math.floor(parsePositiveFiniteNumberOrFallback(raw, 0));
}

/** Stream pretty JSON without one intermediate stringify of huge nested arrays when possible. */
function writeJsonStream(output: { write(chunk: string): unknown }, value: unknown): void {
  if (Array.isArray(value)) {
    output.write("[\n");
    for (let i = 0; i < value.length; i++) {
      const pretty = JSON.stringify(value[i], null, 2);
      const indented = pretty
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      output.write(i === 0 ? indented : `,\n${indented}`);
    }
    output.write("\n]\n");
    return;
  }
  if (isRecord(value)) {
    const record = value;
    // Stream large dialogs/items arrays field-by-field to avoid one giant intermediate string.
    const largeArrayKey = ["dialogs", "items", "messages"].find((key) => Array.isArray(record[key]));
    if (largeArrayKey && Array.isArray(record[largeArrayKey]) && (record[largeArrayKey] as unknown[]).length > 32) {
      const items = record[largeArrayKey] as unknown[];
      output.write("{\n");
      let wrote = false;
      for (const [key, fieldValue] of Object.entries(record)) {
        if (key === largeArrayKey) continue;
        const pretty = JSON.stringify(fieldValue, null, 2)
          .split("\n")
          .map((line, idx) => (idx === 0 ? line : `  ${line}`))
          .join("\n");
        output.write(`${wrote ? ",\n" : ""}  ${JSON.stringify(key)}: ${pretty}`);
        wrote = true;
      }
      output.write(`${wrote ? ",\n" : ""}  ${JSON.stringify(largeArrayKey)}: [\n`);
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
  }
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonlStream(output: { write(chunk: string): unknown }, items: unknown[]): void {
  for (const item of items) {
    output.write(`${JSON.stringify(item)}\n`);
  }
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
  const dbKey = asOptionalTrimmedString(record?.dbKey) ?? fallbackDbKey ?? "";
  const id =
    asOptionalTrimmedString(record?.id) ??
    (dbKey ? getDialogIdFromKey(dbKey) : "");
  if (!dbKey || !id) return null;

  return {
    id,
    dbKey,
    title:
      asOptionalTrimmedString(record?.title) ??
      asOptionalTrimmedString(record?.taskLabel) ??
      "(untitled)",
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
  return (
    record.triggerType === "automation_run" ||
    record.triggerType === "scheduled_run" ||
    Boolean((record as { parentAutomationKey?: unknown }).parentAutomationKey) ||
    Boolean((record as { parentTaskKey?: unknown }).parentTaskKey)
  );
}

function printListUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo dialog list [--space <spaceId|spaceUrl>] [--limit ${DEFAULT_DIALOG_LIST_LIMIT}] [--offset <n>] [--all] [--json] [--jsonl] [--ids-only]

Options:
  --space <space>       List current user's dialogs attached to one space.
  --limit <n>           Maximum dialogs to return. Default: ${DEFAULT_DIALOG_LIST_LIMIT}. Use 0 or --all for full dump.
  --offset <n>          Skip first n dialogs after sort/filter (paging).
  --all                 Full dump (same as --limit 0). Prefer --jsonl for large results.
  --include-scheduled   Include scheduled automation run dialogs.
  --json                Print machine-readable JSON object.
  --jsonl               Stream one dialog JSON object per line (lowest memory).
  --ids-only            Print only dialog ids.
  --server <url>        Override NOLO_SERVER/BASE_URL.
  --token <jwt>         Override AUTH_TOKEN.

Lists merge global server candidates and ignore newer tombstones.
Human default is a short summary; use --json/--jsonl for automation.
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

function printQueryUsage(output: { write(chunk: string): unknown }) {
  output.write(`Usage:
  nolo dialog query --subject-kind <kind> --subject-id <id> [--subject-role <role>]
  nolo dialog query --row-dbkey <rowDbKey>

Options:
  --row-dbkey <dbKey>       Convenience target for table-row task subject refs.
  --subject-kind <kind>     Generic subject ref kind. Defaults to table-row with --row-dbkey.
  --subject-id <id>         Generic subject ref id. Defaults to --row-dbkey.
  --subject-role <role>     Optional role included in the query payload.
  --limit <n>               Query limit. Default: ${DEFAULT_DIALOG_QUERY_LIMIT}. Use 0 or --all for full dump.
  --all                     Full dump (same as --limit 0). Prefer --jsonl for large results.
  --exclude-dialog <id>     Exclude one dialog id or dbKey from evidence results.
  --allow-empty             Exit 0 when no dialogs match.
  --json                    Print machine-readable JSON object.
  --jsonl                   Stream one dialog JSON object per line.
  --server <url>            Target server. Defaults to NOLO_SERVER/BASE_URL/profile.
  --token <jwt>             Override AUTH_TOKEN.

Reads dialog evidence by dialog.subjectRefs through the server query endpoint.
It is read-only and does not write task rows, row-side evidence caches, or retired orchestration metadata.
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
  return parsePositiveIntegerOrFallback(raw, fallback);
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
  return asTrimmedString(value);
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
      const normalized = asTrimmedString(candidate);
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
  fetchImpl: CliFetchImpl;
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
  fetchImpl: CliFetchImpl;
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
        message: toErrorMessage(error),
      });
    }
  }
  throw Object.assign(new Error("All HTTP dialog reads failed"), { attempts });
}

async function readDialogFromLocalDb(dialogKey: string, dialogId: string, limit: number) {
  const { readDialogFromLocalDb: readLocalDialog } = await import("../agent-runtime/localDialogRead");
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
  fetchImpl: CliFetchImpl;
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
  const text = asTrimmedString(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalizeNonEmptyString(value: unknown) {
  return asOptionalTrimmedString(value) ?? null;
}

type DialogSubjectRef = {
  kind: string;
  id: string;
  role?: string;
};

function normalizeSubjectKind(kind: string) {
  return kind === "tableRow" ? "table-row" : kind;
}

function normalizeDialogSubjectRef(value: unknown): DialogSubjectRef | null {
  if (!isRecord(value)) return null;
  const kindRaw = asOptionalTrimmedString(value.kind);
  const kind = kindRaw ? normalizeSubjectKind(kindRaw) : "";
  const id = asOptionalTrimmedString(value.id) ?? "";
  if (!kind || !id) return null;
  const role = asOptionalTrimmedString(value.role) ?? "";
  return {
    kind,
    id,
    ...(role ? { role } : {}),
  };
}

function extractDialogSubjectRefs(dialog: unknown): DialogSubjectRef[] {
  if (!isRecord(dialog) || !Array.isArray(dialog.subjectRefs)) return [];
  return dialog.subjectRefs
    .map(normalizeDialogSubjectRef)
    .filter((ref): ref is DialogSubjectRef => Boolean(ref));
}

function dialogMatchesSubjectRef(dialog: unknown, target: DialogSubjectRef) {
  const normalizedTarget = normalizeDialogSubjectRef(target);
  if (!normalizedTarget) return false;
  return extractDialogSubjectRefs(dialog).some(
    (ref) => ref.kind === normalizedTarget.kind && ref.id === normalizedTarget.id
  );
}

function hasArtifactEvidence(value: unknown) {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function artifactEvidenceCount(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length > 0 ? 1 : 0;
  return value ? 1 : 0;
}

function summarizeDialogEvidence(dialog: any, target: DialogSubjectRef) {
  const dialogKey = asOptionalTrimmedString(dialog?.dbKey) ?? "";
  const checkpoint = asRecordOrEmpty(dialog?.runtimeCheckpoint);
  const matchedSubjectRefs = extractDialogSubjectRefs(dialog).filter(
    (ref) => ref.kind === normalizeSubjectKind(target.kind) && ref.id === target.id
  );
  const lastToolNames = asNonEmptyStringArray(checkpoint.lastToolNames);

  return {
    dialogId:
      asOptionalTrimmedString(dialog?.dialogId) ??
      asOptionalTrimmedString(dialog?.id) ??
      (dialogKey ? getDialogIdFromKey(dialogKey) : null),
    dialogKey: dialogKey || null,
    title: asOptionalTrimmedString(dialog?.title) ?? null,
    status: asOptionalTrimmedString(dialog?.status) ?? null,
    checkpointStatus: asOptionalTrimmedString(checkpoint.status) ?? null,
    updatedAt:
      typeof dialog?.updatedAt === "string" || typeof dialog?.updatedAt === "number"
        ? dialog.updatedAt
        : null,
    hasArtifacts: hasArtifactEvidence(dialog?.artifacts),
    artifactCount: artifactEvidenceCount(dialog?.artifacts),
    subjectRefs: matchedSubjectRefs,
    lastToolNames,
  };
}

function verifyDialogSubjectQuery(dialogs: any[], target: DialogSubjectRef, allowEmpty: boolean) {
  const unmatchedDialogs = dialogs
    .filter((dialog) => !dialogMatchesSubjectRef(dialog, target))
    .map((dialog) => ({
      dialogId:
        asOptionalTrimmedString(dialog?.dialogId) ??
        asOptionalTrimmedString(dialog?.id) ??
        (typeof dialog?.dbKey === "string"
          ? getDialogIdFromKey(dialog.dbKey)
          : null),
      dialogKey: asOptionalTrimmedString(dialog?.dbKey) ?? null,
      subjectRefs: extractDialogSubjectRefs(dialog),
    }));
  const reason =
    unmatchedDialogs.length > 0
      ? "unmatched_results"
      : dialogs.length === 0 && !allowEmpty
        ? "empty_results"
        : "ok";
  return {
    ok: reason === "ok",
    reason,
    target,
    returnedCount: dialogs.length,
    matchedCount: dialogs.length - unmatchedDialogs.length,
    unmatchedCount: unmatchedDialogs.length,
    unmatchedDialogs,
  };
}

function normalizeExcludedDialogIds(value: unknown) {
  const rawValues = Array.isArray(value) ? value : [value];
  const ids = new Set<string>();
  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") continue;
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    ids.add(trimmed);
    if (trimmed.startsWith("dialog-")) {
      ids.add(getDialogIdFromKey(trimmed));
    }
  }
  return [...ids];
}

function getDialogIdentityValues(dialog: unknown) {
  if (!isRecord(dialog)) return [];
  const values = new Set<string>();
  for (const rawValue of [dialog.dialogId, dialog.id, dialog.dbKey]) {
    if (typeof rawValue !== "string") continue;
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    values.add(trimmed);
    if (trimmed.startsWith("dialog-")) {
      values.add(getDialogIdFromKey(trimmed));
    }
  }
  return [...values];
}

function excludeDialogsById(dialogs: any[], excludeDialogIds: string[]) {
  if (excludeDialogIds.length === 0) return dialogs;
  const excluded = new Set(excludeDialogIds);
  return dialogs.filter((dialog) =>
    getDialogIdentityValues(dialog).every((value) => !excluded.has(value))
  );
}

async function queryDialogEvidenceBySubjectRef(args: {
  authToken: string;
  fetchImpl: CliFetchImpl;
  limit: number;
  serverUrl: string;
  subjectRef: DialogSubjectRef;
  userId: string;
}) {
  const res = await args.fetchImpl(
    `${args.serverUrl}/api/v1/db/query/${encodeURIComponent(args.userId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "dialog",
        limit: args.limit,
        subjectRef: args.subjectRef,
      }),
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`dialog subject query failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  return Array.isArray(data?.data?.data)
    ? data.data.data
    : Array.isArray(data?.data)
      ? data.data
      : [];
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
  const tools = (
    Array.isArray(snapshot.toolsUsed)
      ? asNonEmptyStringArray(snapshot.toolsUsed)
      : asNonEmptyStringArray(checkpoint.lastToolNames)
  ).slice(0, 8);
  const artifactFiles =
    snapshot.artifacts && typeof snapshot.artifacts === "object"
      ? (snapshot.artifacts.changedFiles ??
        snapshot.artifacts.writtenFiles ??
        snapshot.artifacts.files)
      : undefined;
  const files = (
    Array.isArray(snapshot.writtenFiles) && snapshot.writtenFiles.length
      ? asNonEmptyStringArray(snapshot.writtenFiles)
      : asNonEmptyStringArray(artifactFiles)
  ).slice(0, 8);
  const subjectRefs = Array.isArray(snapshot.subjectRefs)
    ? snapshot.subjectRefs
      .map((ref: any) => {
        const kind = asTrimmedString(ref?.kind);
        const id = asTrimmedString(ref?.id);
        if (!kind || !id) return "";
        const rolePart = asOptionalTrimmedString(ref?.role);
        const role = rolePart ? `#${rolePart}` : "";
        return `${kind}:${id}${role}`;
      })
      .filter(Boolean)
      .slice(0, 8)
    : [];
  const runtimeContext = asRecordOrEmpty(snapshot.runtimeContext);
  const runtimeFieldLines = [
    ["triggerType", snapshot.triggerType],
    ["executionMode", snapshot.executionMode],
    ["threadKind", snapshot.threadKind],
    ["presentationIntent", snapshot.presentationIntent],
    ["parentThreadId", snapshot.parentThreadId],
    ["rootThreadId", snapshot.rootThreadId],
    ["runtimeEntrypoint", runtimeContext.entrypoint ?? checkpoint.runtimeContext?.entrypoint],
    ["parentWakeStatus", snapshot.parentWake?.terminalStatus],
    ["parentWakeAt", snapshot.parentWake?.terminalNotifiedAt],
  ]
    .map(([label, value]) => {
      const normalized = typeof value === "number" ? String(value) : normalizeNonEmptyString(value);
      return normalized ? `${label}: ${normalized}` : "";
    })
    .filter(Boolean);
  const toolErrors = asNonEmptyStringArray(snapshot.toolErrors).slice(0, 8);
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
    ...runtimeFieldLines,
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
  fetchImpl: CliFetchImpl;
  fallbackFetchImpl?: CliFetchImpl;
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
    output.write(`[nolo] dialog read failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
  if (!target) {
    printReadUsage(output);
    return 1;
  }

  try {
    // Default full message dump so multi-turn tool dialogs are not truncated.
    const limit = readDialogLimitArg(args, 0);
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
      ? uniq(asTrimmedNonEmptyStringArray(read.meta.writtenFiles))
      : deriveWrittenFiles(toolMessages);
    const toolErrors = Array.isArray(read.meta?.toolErrors) && read.meta.toolErrors.length > 0
      ? uniq(asTrimmedNonEmptyStringArray(read.meta.toolErrors))
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
      triggerType: read.meta?.triggerType ?? null,
      executionMode: read.meta?.executionMode ?? null,
      threadKind: read.meta?.threadKind ?? null,
      presentationIntent: read.meta?.presentationIntent ?? null,
      parentThreadId: read.meta?.parentThreadId ?? null,
      rootThreadId: read.meta?.rootThreadId ?? null,
      runtimeBinding: read.meta?.runtimeBinding ?? null,
      runtimeContext: read.meta?.runtimeContext ?? null,
      parentWake: read.meta?.parentWake ?? null,
      subjectRefs: Array.isArray(read.meta?.subjectRefs) ? read.meta.subjectRefs : [],
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
    output.write(`[nolo] dialog read failed: ${toErrorMessage(error)}\n`);
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
    output.write(`[nolo] dialog status failed: ${toErrorMessage(error)}\n`);
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
    output.write(`[nolo] dialog status failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
}

export async function runDialogQueryCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printQueryUsage(output);
    return 0;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] dialog query requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }
  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write("[nolo] dialog query could not read userId from AUTH_TOKEN.\n");
    return 1;
  }

  const rowDbKey = readOption(args, "--row-dbkey") ?? env.TASK_ROW_DBKEY;
  const subjectKind = readOption(args, "--subject-kind") ?? (rowDbKey ? "table-row" : "");
  const subjectId = readOption(args, "--subject-id") ?? rowDbKey ?? "";
  const subjectRole = readOption(args, "--subject-role") ?? (rowDbKey ? "task" : "");
  if (!subjectKind || !subjectId) {
    printQueryUsage(output);
    return 1;
  }

  const subjectRef: DialogSubjectRef = {
    kind: normalizeSubjectKind(subjectKind),
    id: subjectId,
    ...(subjectRole ? { role: subjectRole } : {}),
  };
  const serverUrl = resolveServerUrl(args, env);
  const resultLimit = resolveResultLimit(args, DEFAULT_DIALOG_QUERY_LIMIT);
  const limit = resultLimit.unlimited
    ? UNBOUNDED_DIALOG_CAP
    : Math.max(1, resultLimit.limit ?? DEFAULT_DIALOG_QUERY_LIMIT);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const excludeDialogIds = normalizeExcludedDialogIds(readOption(args, "--exclude-dialog"));

  try {
    const rawRecords = await queryDialogEvidenceBySubjectRef({
      authToken,
      fetchImpl,
      limit,
      serverUrl,
      subjectRef,
      userId,
    });
    const records = excludeDialogsById(rawRecords, excludeDialogIds);
    const strict = verifyDialogSubjectQuery(records, subjectRef, hasFlag(args, "--allow-empty"));
    const allDialogs = records
      .filter((record) => dialogMatchesSubjectRef(record, subjectRef))
      .map((record) => summarizeDialogEvidence(record, subjectRef));
    // Client-side cap if server over-returns.
    const hitLimit = !resultLimit.unlimited && allDialogs.length > limit;
    const dialogs = hitLimit ? allDialogs.slice(0, limit) : allDialogs;

    if (hasFlag(args, "--jsonl")) {
      writeJsonlStream(output, dialogs);
    } else if (hasFlag(args, "--json")) {
      writeJsonStream(output, {
        source: "db.query.subjectRef",
        readOnly: true,
        server: serverUrl,
        userId,
        ...(rowDbKey ? { rowDbKey } : {}),
        target: subjectRef,
        ...(excludeDialogIds.length ? { excludedDialogIds: excludeDialogIds } : {}),
        strict,
        total: dialogs.length,
        ...(hitLimit
          ? { limit, truncated: true, nextOffset: dialogs.length }
          : {}),
        dialogs,
      });
    } else {
      output.write(`source: db.query.subjectRef\n`);
      output.write(`server: ${serverUrl}\n`);
      output.write(`subject: ${subjectRef.kind}:${subjectRef.id}${subjectRef.role ? `#${subjectRef.role}` : ""}\n`);
      if (excludeDialogIds.length) output.write(`excluded dialogs: ${excludeDialogIds.join(", ")}\n`);
      output.write(`strict: ${strict.ok ? "ok" : strict.reason}\n`);
      output.write(`total dialogs: ${dialogs.length}\n`);
      if (hitLimit) {
        output.write(
          `truncated: showing ${dialogs.length}; use --all or --limit 0 for full dump\n`
        );
      }
      for (const dialog of dialogs) {
        output.write(
          `\n${dialog.title ?? "(untitled)"}\nid=${dialog.dialogId ?? "-"}\nstatus=${dialog.status ?? "-"}\ncheckpoint=${dialog.checkpointStatus ?? "-"}\nartifacts=${dialog.artifactCount}\nupdatedAt=${dialog.updatedAt ?? "-"}\ndbKey=${dialog.dialogKey ?? "-"}\n`
        );
      }
    }

    return strict.ok ? 0 : 1;
  } catch (error) {
    output.write(`[nolo] dialog query failed: ${toErrorMessage(error)}\n`);
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
  const resultLimit = resolveResultLimit(args, DEFAULT_DIALOG_LIST_LIMIT);
  const limit = resultLimit.unlimited
    ? UNBOUNDED_DIALOG_CAP
    : Math.max(1, resultLimit.limit ?? DEFAULT_DIALOG_LIST_LIMIT);
  const offset = readOffset(args);
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

    const sorted = sortDialogs(
      records
        .map((record) => normalizeDialogRecord(record))
        .filter((dialog): dialog is ListedDialog => dialog != null)
        .filter((dialog) => includeScheduled || !isScheduledDialog(dialog))
    );
    const window = resultLimit.unlimited
      ? sorted.slice(offset, offset + UNBOUNDED_DIALOG_CAP)
      : sorted.slice(offset, offset + limit);
    const hitLimit = !resultLimit.unlimited && sorted.length > offset + window.length;
    const dialogs = window;

    if (hasFlag(args, "--ids-only")) {
      output.write(`${dialogs.map((dialog) => dialog.id).join("\n")}\n`);
      return 0;
    }

    if (hasFlag(args, "--jsonl")) {
      writeJsonlStream(output, dialogs);
      return 0;
    }

    if (hasFlag(args, "--json")) {
      writeJsonStream(output, {
        userId,
        ...(resolvedSpaceId ? { spaceId: resolvedSpaceId } : {}),
        source,
        targetServers: serverUrls,
        ...(queryFailures.length ? { serverFailures: queryFailures } : {}),
        total: dialogs.length,
        ...(hitLimit
          ? {
              limit,
              offset,
              truncated: true,
              nextOffset: offset + dialogs.length,
            }
          : {}),
        dialogs,
      });
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
    if (hitLimit) {
      output.write(
        `truncated: showing ${dialogs.length} (offset ${offset}); use --offset ${offset + dialogs.length} --limit ${limit}, or --all / --limit 0 for full dump\n`
      );
    }
    for (const dialog of dialogs) {
      output.write(
        `\n${dialog.title}\nid=${dialog.id}\nstatus=${dialog.status ?? "-"}\nupdatedAt=${dialog.updatedAt ?? "-"}\ndbKey=${dialog.dbKey}\n`
      );
    }
    return 0;
  } catch (error) {
    output.write(
      `[nolo] dialog list failed: ${
        toErrorMessage(error)
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
  const serverUrls = resolveDeleteServerCandidates(args, env, serverUrl);
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
      const errorMsg = toErrorMessage(error);
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
