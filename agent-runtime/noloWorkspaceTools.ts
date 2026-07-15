import { isRecord } from "../core/isRecord";
import { asOptionalFiniteNumber } from "../core/optionalNumber";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asRecordOrEmpty } from "../core/recordOrEmpty";
import { asNonEmptyStringArray } from "../core/stringArray";
import { spawnToWebStreams } from "./runtimeCompat";

export const NOLO_WORKSPACE_TOOL_NAMES = [
  "listDialogs",
  "readDialog",
  "queryDialogsBySubjectRef",
  "deleteDialogs",
  "listAgents",
  "readAgent",
  "listSpaces",
  "readSpace",
  "readDoc",
  "readSkillDoc",
  "listTables",
  "queryTableRows",
  "cliWhoami",
  "cliDoctor",
] as const;

export type NoloWorkspaceToolName = typeof NOLO_WORKSPACE_TOOL_NAMES[number];

export const NOLO_WORKSPACE_TOOL_PROMPT =
  "Nolo workspace tools are available for Nolo data: use listDialogs/readDialog/queryDialogsBySubjectRef, listAgents/readAgent, listSpaces/readSpace, readDoc/readSkillDoc, listTables/queryTableRows, cliWhoami, and cliDoctor when the user asks to inspect Nolo workspace data. Use deleteDialogs only when the user explicitly asks to delete dialogs; it must preview matches and wait for user confirmation before deleting. Prefer tools over guessing, and combine tool results when the user asks for summaries or analysis.";

const NOLO_WORKSPACE_TOOL_NAME_SET = new Set<string>(NOLO_WORKSPACE_TOOL_NAMES);
const DIALOG_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const DIALOG_PATH_RE = /^\/(?:space\/([^/]+)\/)?dialog-(.+)-([0-9A-HJKMNP-TV-Z]{26})\/?$/i;

function stringToolParam(description: string) {
  return { type: "string", description };
}

export function isNoloWorkspaceToolName(toolName: unknown): toolName is NoloWorkspaceToolName {
  return typeof toolName === "string" && NOLO_WORKSPACE_TOOL_NAME_SET.has(toolName);
}

export function filterNoloWorkspaceToolNames(toolNames?: string[]) {
  return (toolNames ?? []).filter(isNoloWorkspaceToolName);
}

export function buildNoloWorkspaceOpenAiTools(args: { toolNames?: string[] }) {
  const toolNames = new Set(args.toolNames ?? []);
  const tools: Array<Record<string, unknown>> = [];
  function add(name: NoloWorkspaceToolName, description: string, properties: Record<string, unknown>, required: string[] = []) {
    if (!toolNames.has(name)) return;
    tools.push({
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties,
          ...(required.length ? { required } : {}),
        },
      },
    });
  }

  add("listDialogs", "List the current user's dialogs in the Nolo workspace.", {
    limit: { type: "integer", description: "Maximum dialogs to return." },
    space: stringToolParam("Optional space id or URL."),
  });
  add("readDialog", "Read one persisted dialog in the Nolo workspace.", {
    dialog: stringToolParam("Dialog id, dialog db key, or dialog URL."),
    limit: { type: "integer", description: "Optional message limit." },
  }, ["dialog"]);
  add("queryDialogsBySubjectRef", "Query persisted dialog evidence by a generic dialog.subjectRefs target.", {
    rowDbKey: stringToolParam("Optional convenience alias for subjectKind=table-row, subjectId=<rowDbKey>, subjectRole=task."),
    subjectKind: stringToolParam("Generic subject ref kind, for example table-row, page, file, commit, or artifact."),
    subjectId: stringToolParam("Generic subject ref id."),
    subjectRole: stringToolParam("Optional subject ref role."),
    limit: { type: "integer", description: "Maximum matching dialog summaries to return." },
    status: stringToolParam("Optional dialog status filter, for example running, done, or failed."),
    checkpointStatus: stringToolParam("Optional runtimeCheckpoint.status filter."),
    hasArtifacts: { type: "boolean", description: "When true, only return dialogs with artifact evidence." },
    excludeDialogId: stringToolParam("Optional dialog id or dialog dbKey to exclude from evidence results, typically the current caller dialog."),
  });
  add("deleteDialogs", "Find and delete the current user's dialogs by title/id/dbKey. This is destructive: preview matches first and wait for explicit user confirmation before deleting.", {
    query: stringToolParam("Dialog title/id/dbKey search text, for example 中医评测 or a dialog id."),
    matchMode: {
      type: "string",
      enum: ["contains", "exact", "prefix", "dialogId"],
      description: "Matching mode. Default contains.",
    },
    confirmedDialogIds: {
      type: "array",
      items: { type: "string" },
      description: "Confirmed dialog ids or dbKeys to delete.",
    },
  }, ["query"]);
  add("listAgents", "List the current user's agents in the Nolo workspace.", {
    space: stringToolParam("Optional space id or URL."),
    publicOnly: { type: "boolean", description: "Only show public agents." },
  });
  add("readAgent", "Read one agent config in the Nolo workspace.", {
    agent: stringToolParam("Agent key, id, alias, or URL."),
  }, ["agent"]);
  add("listSpaces", "List joined spaces in the Nolo workspace.", {});
  add("readSpace", "Read one space in the Nolo workspace.", {
    space: stringToolParam("Space id or URL."),
    contentKey: stringToolParam("Optional content key inside the space."),
    brief: { type: "boolean", description: "Return brief output when supported." },
  }, ["space"]);
  add("readDoc", "Read one normal doc/page in the Nolo workspace.", {
    doc: stringToolParam("Doc/page key."),
  }, ["doc"]);
  add("readSkillDoc", "Read one skill doc in the Nolo workspace.", {
    doc: stringToolParam("Skill doc/page key."),
  }, ["doc"]);
  add("listTables", "List tables in the current user scope or an optional space scope.", {
    limit: { type: "integer", description: "Maximum tables to return." },
    space: stringToolParam("Optional space id or URL."),
    titleQuery: stringToolParam("Optional case-insensitive title substring."),
    purpose: stringToolParam("Optional purpose value such as agent_eval_workbench."),
  });
  add("queryTableRows", "Query rows from a Nolo table.", {
    table: stringToolParam("Table id or meta key."),
    limit: { type: "integer", description: "Optional row limit." },
    row: stringToolParam("Optional row id or row db key."),
    output: stringToolParam("Optional output format such as json, jsonl, or items."),
  }, ["table"]);
  add("cliWhoami", "Show the current Nolo CLI login state.", {});
  add("cliDoctor", "Show Nolo CLI doctor diagnostics.", {});
  return tools;
}

export function noloPositiveIntegerString(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : null;
}

export function noloStringArg(value: unknown) {
  return asOptionalTrimmedString(value) ?? null;
}

export function parseNoloWorkspaceToolArguments(raw: string) {
  try {
    return asRecordOrEmpty(JSON.parse(raw || "{}") as unknown);
  } catch {
    return {};
  }
}

export function clampNoloPositiveInteger(value: unknown, fallback: number, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function getNoloDialogIdFromKey(dbKey: string) {
  const index = dbKey.lastIndexOf("-");
  return index >= 0 ? dbKey.slice(index + 1) : dbKey;
}

export function resolveNoloDialogInput(rawInput: string, userId: string) {
  const raw = rawInput.trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const url = new URL(raw);
    const match = url.pathname.match(DIALOG_PATH_RE);
    if (!match) throw new Error(`Unsupported dialog URL path: ${url.pathname}`);
    const [, spaceId, ownerId, dialogId] = match;
    return {
      dbKey: `dialog-${ownerId}-${dialogId}`,
      dialogId,
      ownerId,
      spaceId: spaceId ? decodeURIComponent(spaceId) : null,
    };
  }
  if (raw.startsWith("dialog-")) {
    const dialogId = getNoloDialogIdFromKey(raw);
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

export function normalizeNoloSpaceInput(raw: string) {
  const value = raw.trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    const match = new URL(value).pathname.match(/^\/space\/([^/]+)/);
    return match?.[1] ? decodeURIComponent(match[1]).replace(/^space-/, "") : "";
  }
  return value.replace(/^space-/, "");
}

export function getNoloSpaceContentKeys(spaceRecord: any) {
  const keys = new Set<string>();
  const contents = spaceRecord?.contents;
  if (!contents || typeof contents !== "object") return keys;
  for (const [entryKey, value] of Object.entries(contents)) {
    keys.add(entryKey);
    if (value && typeof value === "object") {
      const contentKey = asOptionalTrimmedString((value as any).contentKey);
      if (contentKey) {
        keys.add(contentKey);
      }
    }
  }
  return keys;
}

export function getNoloComparableUpdatedAt(record: any) {
  const raw = record?.updatedAt ?? record?.updated_at ?? record?.createdAt ?? record?.created;
  const asNumber = asOptionalFiniteNumber(raw);
  if (asNumber !== undefined) return asNumber;
  if (typeof raw === "string") return Date.parse(raw) || 0;
  return 0;
}

export type NoloSubjectRef = {
  kind: string;
  id: string;
  role?: string;
};

function normalizeNoloSubjectKind(kind: string) {
  return kind === "tableRow" ? "table-row" : kind;
}

function normalizeNoloSubjectRef(value: unknown): NoloSubjectRef | null {
  if (!isRecord(value)) return null;
  const kindRaw = asOptionalTrimmedString(value.kind);
  const kind = kindRaw ? normalizeNoloSubjectKind(kindRaw) : "";
  const id = asOptionalTrimmedString(value.id) ?? "";
  if (!kind || !id) return null;
  const role = asOptionalTrimmedString(value.role) ?? "";
  return {
    kind,
    id,
    ...(role ? { role } : {}),
  };
}

export function buildNoloSubjectRefQueryTarget(args: Record<string, any>): NoloSubjectRef | null {
  const rowDbKey = noloStringArg(args.rowDbKey ?? args.row ?? args.taskRowDbKey);
  const subjectKind = noloStringArg(args.subjectKind ?? args.kind) ?? (rowDbKey ? "table-row" : null);
  const subjectId = noloStringArg(args.subjectId ?? args.id) ?? rowDbKey;
  const subjectRole = noloStringArg(args.subjectRole ?? args.role) ?? (rowDbKey ? "task" : null);
  if (!subjectKind || !subjectId) return null;
  return {
    kind: normalizeNoloSubjectKind(subjectKind),
    id: subjectId,
    ...(subjectRole ? { role: subjectRole } : {}),
  };
}
function extractNoloDialogSubjectRefs(dialog: unknown): NoloSubjectRef[] {
  if (!isRecord(dialog) || !Array.isArray(dialog.subjectRefs)) return [];
  return dialog.subjectRefs
    .map(normalizeNoloSubjectRef)
    .filter((ref): ref is NoloSubjectRef => Boolean(ref));
}

function noloDialogMatchesSubjectRef(dialog: unknown, target: NoloSubjectRef) {
  const normalizedTarget = normalizeNoloSubjectRef(target);
  if (!normalizedTarget) return false;
  return extractNoloDialogSubjectRefs(dialog).some(
    (ref) => ref.kind === normalizedTarget.kind && ref.id === normalizedTarget.id
  );
}

function noloArtifactCount(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length > 0 ? 1 : 0;
  return value ? 1 : 0;
}

function summarizeNoloDialogSubjectRefEvidence(dialog: any, target: NoloSubjectRef) {
  const dialogKey = asOptionalTrimmedString(dialog?.dbKey) ?? "";
  const checkpoint = asRecordOrEmpty(dialog?.runtimeCheckpoint);
  const matchedSubjectRefs = extractNoloDialogSubjectRefs(dialog).filter(
    (ref) => ref.kind === normalizeNoloSubjectKind(target.kind) && ref.id === target.id
  );
  const lastToolNames = asNonEmptyStringArray(checkpoint.lastToolNames);
  const artifactCount = noloArtifactCount(dialog?.artifacts);

  return {
    dialogId:
      asOptionalTrimmedString(dialog?.dialogId) ??
      asOptionalTrimmedString(dialog?.id) ??
      (dialogKey ? getNoloDialogIdFromKey(dialogKey) : null),
    dialogKey: dialogKey || null,
    title: asOptionalTrimmedString(dialog?.title) ?? null,
    status: asOptionalTrimmedString(dialog?.status) ?? null,
    checkpointStatus: asOptionalTrimmedString(checkpoint.status) ?? null,
    updatedAt:
      typeof dialog?.updatedAt === "string" || typeof dialog?.updatedAt === "number"
        ? dialog.updatedAt
        : null,
    hasArtifacts: artifactCount > 0,
    artifactCount,
    subjectRefs: matchedSubjectRefs,
    lastToolNames,
  };
}

export function normalizeNoloExcludeDialogIds(value: unknown) {
  const rawValues = Array.isArray(value) ? value : [value];
  const ids = new Set<string>();
  for (const rawValue of rawValues) {
    if (typeof rawValue !== "string") continue;
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    ids.add(trimmed);
    if (trimmed.startsWith("dialog-")) {
      ids.add(getNoloDialogIdFromKey(trimmed));
    }
  }
  return [...ids];
}

function getNoloDialogIdentityValues(dialog: unknown) {
  if (!isRecord(dialog)) return [];
  const values = new Set<string>();
  for (const rawValue of [dialog.dialogId, dialog.id, dialog.dbKey]) {
    if (typeof rawValue !== "string") continue;
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    values.add(trimmed);
    if (trimmed.startsWith("dialog-")) {
      values.add(getNoloDialogIdFromKey(trimmed));
    }
  }
  return [...values];
}

function filterNoloDialogsByExcludedIds(dialogs: any[], excludeDialogIds?: unknown) {
  const excluded = new Set(normalizeNoloExcludeDialogIds(excludeDialogIds));
  if (excluded.size === 0) return dialogs;
  return dialogs.filter((dialog) =>
    getNoloDialogIdentityValues(dialog).every((value) => !excluded.has(value))
  );
}

export function filterNoloDialogSubjectRefEvidence(args: {
  dialogs: any[];
  target: NoloSubjectRef;
  limit: number;
  status?: string | null;
  checkpointStatus?: string | null;
  hasArtifacts?: boolean | null;
  excludeDialogIds?: unknown;
}) {
  // Single pass: filter by excluded ids and subject ref
  const matched: any[] = [];
  for (const dialog of filterNoloDialogsByExcludedIds(args.dialogs, args.excludeDialogIds)) {
    if (noloDialogMatchesSubjectRef(dialog, args.target)) {
      matched.push(dialog);
    }
  }
  // Sort dialogs by updatedAt descending
  matched.sort((left, right) => getNoloComparableUpdatedAt(right) - getNoloComparableUpdatedAt(left));
  // Single pass: map and apply all filters
  const evidence: Array<{
    dialogId: string | null;
    dialogKey: string | null;
    title: string | null;
    status: string | null;
    checkpointStatus: string | null;
    updatedAt: string | number | null;
    hasArtifacts: boolean;
    artifactCount: number;
    subjectRefs: Array<{ kind: string; id: string; role?: string }>;
    lastToolNames: string[];
  }> = [];
  for (const dialog of matched) {
    const entry = summarizeNoloDialogSubjectRefEvidence(dialog, args.target);
    if (args.status && entry.status !== args.status) continue;
    if (args.checkpointStatus && entry.checkpointStatus !== args.checkpointStatus) continue;
    if (args.hasArtifacts != null && entry.hasArtifacts !== args.hasArtifacts) continue;
    evidence.push(entry);
  }
  return evidence.slice(0, args.limit);
}

export function verifyNoloDialogSubjectRefQuery(
  dialogs: any[],
  target: NoloSubjectRef,
  options: { excludeDialogIds?: unknown } = {},
) {
  const checkedDialogs = filterNoloDialogsByExcludedIds(dialogs, options.excludeDialogIds);
  const unmatchedDialogs: Array<{
    dialogId: string | null;
    dialogKey: string | null;
    subjectRefs: NoloSubjectRef[];
  }> = [];
  for (const dialog of checkedDialogs) {
    if (noloDialogMatchesSubjectRef(dialog, target)) continue;
    unmatchedDialogs.push({
      dialogId:
        asOptionalTrimmedString(dialog?.dialogId) ??
        asOptionalTrimmedString(dialog?.id) ??
        (typeof dialog?.dbKey === "string"
          ? getNoloDialogIdFromKey(dialog.dbKey)
          : null),
      dialogKey: asOptionalTrimmedString(dialog?.dbKey) ?? null,
      subjectRefs: extractNoloDialogSubjectRefs(dialog),
    });
  }
  const reason = unmatchedDialogs.length > 0 ? "unmatched_results" : "ok";
  return {
    ok: reason === "ok",
    reason,
    target,
    returnedCount: checkedDialogs.length,
    matchedCount: checkedDialogs.length - unmatchedDialogs.length,
    unmatchedCount: unmatchedDialogs.length,
    unmatchedDialogs,
  };
}

export function normalizeNoloDocReadArgs(args: Record<string, any>) {
  const id = args.id ?? args.doc ?? args.docKey ?? args.pageKey ?? args.key;
  return id == null ? args : { ...args, id };
}

export function buildNoloTableQueryRequest(args: Record<string, any>, currentUserId?: string | null) {
  const tableInput = noloStringArg(args.table ?? args.metaKey);
  if (!tableInput) return null;
  const tableMetaParts = tableInput.startsWith("meta-")
    ? tableInput.split("-")
    : [];
  const tenantId = args.tenantId
    ?? (tableMetaParts.length >= 3 ? tableMetaParts[1] : currentUserId);
  const tableId = args.tableId
    ?? (tableMetaParts.length >= 3 ? tableMetaParts.slice(2).join("-") : tableInput);
  const filters: Record<string, unknown> = {
    ...asRecordOrEmpty(args.filters),
  };
  const row = noloStringArg(args.row ?? args.rowId);
  if (row) {
    if (row.startsWith("row-")) filters.dbKey = row;
    else filters.rowId = row;
  }
  return {
    tenantId,
    tableId,
    filters,
    columns: args.columns,
    limit: args.limit ?? (row ? 1 : 20),
    offset: args.offset,
    includeBaseFields: args.includeBaseFields,
    sortBy: args.sortBy ?? "updatedAt",
    sortOrder: args.sortOrder === "asc" ? "asc" : "desc",
  };
}

export function buildNoloWorkspaceCommandArgs(call: { name: string; arguments: string }) {
  const args = parseNoloWorkspaceToolArguments(call.arguments);
  switch (call.name) {
    case "listDialogs": {
      const cliArgs = ["dialog", "list"];
      const limit = noloPositiveIntegerString(args.limit);
      const space = noloStringArg(args.space);
      if (limit) cliArgs.push("--limit", limit);
      if (space) cliArgs.push("--space", space);
      return cliArgs;
    }
    case "readDialog": {
      const dialog = noloStringArg(args.dialog ?? args.dialogId ?? args.id);
      if (!dialog) throw new Error("readDialog requires dialog.");
      const cliArgs = ["dialog", "read", dialog];
      const limit = noloPositiveIntegerString(args.limit);
      if (limit) cliArgs.push(limit);
      return cliArgs;
    }
    case "queryDialogsBySubjectRef": {
      const target = buildNoloSubjectRefQueryTarget(args);
      if (!target) throw new Error("queryDialogsBySubjectRef requires rowDbKey or subjectKind plus subjectId.");
      const cliArgs = ["dialog", "query"];
      const rowDbKey = noloStringArg(args.rowDbKey ?? args.row ?? args.taskRowDbKey);
      if (rowDbKey && target.kind === "table-row" && target.id === rowDbKey) {
        cliArgs.push("--row-dbkey", rowDbKey);
      } else {
        cliArgs.push("--subject-kind", target.kind, "--subject-id", target.id);
        if (target.role) cliArgs.push("--subject-role", target.role);
      }
      const limit = noloPositiveIntegerString(args.limit);
      if (limit) cliArgs.push("--limit", limit);
      const excludeDialogId = noloStringArg(args.excludeDialogId ?? args.excludeDialog);
      if (excludeDialogId) cliArgs.push("--exclude-dialog", excludeDialogId);
      cliArgs.push("--json");
      return cliArgs;
    }
    case "listAgents": {
      const cliArgs = ["agent", "list"];
      const space = noloStringArg(args.space);
      if (space) cliArgs.push("--space", space);
      if (args.publicOnly === true) cliArgs.push("--public-only");
      return cliArgs;
    }
    case "readAgent": {
      const agent = noloStringArg(args.agent ?? args.agentKey ?? args.id);
      if (!agent) throw new Error("readAgent requires agent.");
      return ["agent", "read", agent];
    }
    case "listSpaces":
      return ["space", "list"];
    case "readSpace": {
      const space = noloStringArg(args.space ?? args.spaceId ?? args.id);
      if (!space) throw new Error("readSpace requires space.");
      const cliArgs = ["space", "read", space];
      const contentKey = noloStringArg(args.contentKey);
      if (contentKey) cliArgs.push("--content-key", contentKey);
      if (args.brief === true) cliArgs.push("--brief");
      return cliArgs;
    }
    case "readDoc": {
      const doc = noloStringArg(args.doc ?? args.docKey ?? args.pageKey ?? args.key);
      if (!doc) throw new Error("readDoc requires doc.");
      return ["doc", "read", doc];
    }
    case "readSkillDoc": {
      const doc = noloStringArg(args.doc ?? args.docKey ?? args.pageKey ?? args.key);
      if (!doc) throw new Error("readSkillDoc requires doc.");
      return ["skill-doc", "read", doc];
    }
    case "listTables": {
      const cliArgs = ["table", "list"];
      const limit = noloPositiveIntegerString(args.limit);
      const space = noloStringArg(args.space ?? args.spaceId);
      const titleQuery = noloStringArg(args.titleQuery);
      const purpose = noloStringArg(args.purpose);
      if (limit) cliArgs.push("--limit", limit);
      if (space) cliArgs.push("--space", space);
      if (titleQuery) cliArgs.push("--title-query", titleQuery);
      if (purpose) cliArgs.push("--purpose", purpose);
      return cliArgs;
    }
    case "queryTableRows": {
      const table = noloStringArg(args.table ?? args.tableId ?? args.metaKey);
      if (!table) throw new Error("queryTableRows requires table.");
      const cliArgs = ["table", "query", "--table", table];
      const limit = noloPositiveIntegerString(args.limit);
      const row = noloStringArg(args.row ?? args.rowId);
      const output = noloStringArg(args.output);
      if (limit) cliArgs.push("--limit", limit);
      if (row) cliArgs.push("--row", row);
      if (output) cliArgs.push("--output", output);
      return cliArgs;
    }
    case "cliWhoami":
      return ["whoami"];
    case "cliDoctor":
      return ["doctor"];
    default:
      throw new Error(`Unsupported Nolo workspace tool: ${call.name}`);
  }
}

async function readNoloProcessStream(readable: ReadableStream<Uint8Array> | null) {
  if (!readable) return "";
  return new Response(readable).text();
}

type NoloSpawnProcess = {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
};

type NoloSpawn = (options: {
  cmd: string[];
  stdout: "pipe";
  stderr: "pipe";
  env?: Record<string, string | undefined>;
}) => NoloSpawnProcess;

export async function runNoloWorkspaceCliTool(call: {
  name: string;
  arguments: string;
}, args: {
  cliEntrypoint?: string;
  env?: Record<string, string | undefined>;
  metadataKind?: string;
  processExecPath?: string;
  spawn?: NoloSpawn;
}) {
  const cliArgs = buildNoloWorkspaceCommandArgs(call);
  const bunSpawn = (globalThis as { Bun?: { spawn?: unknown } }).Bun?.spawn;
  const spawn: NoloSpawn = args.spawn
    ?? (typeof bunSpawn === "function"
      ? (bunSpawn as NoloSpawn)
      : nodeSpawnFallback);
  const execPath = args.processExecPath ?? process.execPath;
  const entrypoint = args.cliEntrypoint;
  // When the CLI is a standalone compiled binary, the executable itself is the
  // entrypoint; passing it again would make the binary interpret its own path
  // as a subcommand.
  const cmd = entrypoint && entrypoint !== execPath
    ? [execPath, entrypoint, ...cliArgs]
    : [execPath, ...cliArgs];
  const proc = spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    env: args.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readNoloProcessStream(proc.stdout),
    readNoloProcessStream(proc.stderr),
    proc.exited,
  ]);
  const content = `${stdout}${stderr}`;
  if (exitCode !== 0) {
    throw new Error(content.trim() || `nolo ${cliArgs.join(" ")} exited ${exitCode}`);
  }
  return {
    content,
    metadata: {
      [args.metadataKind ?? "noloWorkspaceTool"]: true,
      command: ["nolo", ...cliArgs].join(" "),
      exitCode,
    },
  };
}

export function buildNoloWorkspaceCliToolExecutors(args: {
  cliEntrypoint?: string;
  env?: Record<string, string | undefined>;
  metadataKind?: string;
  processExecPath?: string;
  spawn?: NoloSpawn;
}) {
  const executors: Record<string, (call: { name: string; arguments: string }) => Promise<{
    content: string;
    metadata?: Record<string, unknown>;
  }>> = {};
  for (const toolName of NOLO_WORKSPACE_TOOL_NAMES) {
    executors[toolName] = (call) => runNoloWorkspaceCliTool(call, args);
  }
  return executors;
}

const nodeSpawnFallback: NoloSpawn = (options) => {
  return spawnToWebStreams({ cmd: options.cmd, env: options.env });
};
