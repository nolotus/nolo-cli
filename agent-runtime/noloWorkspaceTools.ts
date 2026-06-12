export const NOLO_WORKSPACE_TOOL_NAMES = [
  "listDialogs",
  "readDialog",
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
  "Nolo workspace tools are available for Nolo data: use listDialogs/readDialog, listAgents/readAgent, listSpaces/readSpace, readDoc/readSkillDoc, listTables/queryTableRows, cliWhoami, and cliDoctor when the user asks to inspect Nolo workspace data. Prefer tools over guessing, and combine tool results when the user asks for summaries or analysis.";

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
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseNoloWorkspaceToolArguments(raw: string) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
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
      const contentKey = (value as any).contentKey;
      if (typeof contentKey === "string" && contentKey.trim()) {
        keys.add(contentKey.trim());
      }
    }
  }
  return keys;
}

export function getNoloComparableUpdatedAt(record: any) {
  const raw = record?.updatedAt ?? record?.updated_at ?? record?.createdAt ?? record?.created;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") return Date.parse(raw) || 0;
  return 0;
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
    ...(args.filters && typeof args.filters === "object" ? args.filters : {}),
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
  cliEntrypoint: string;
  env?: Record<string, string | undefined>;
  metadataKind?: string;
  processExecPath?: string;
  spawn?: NoloSpawn;
}) {
  const cliArgs = buildNoloWorkspaceCommandArgs(call);
  const spawn = args.spawn ?? (globalThis as any).Bun?.spawn;
  if (typeof spawn !== "function") {
    throw new Error("Nolo workspace CLI tools require a Bun-compatible spawn runtime.");
  }
  const proc = spawn({
    cmd: [args.processExecPath ?? process.execPath, args.cliEntrypoint, ...cliArgs],
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
  cliEntrypoint: string;
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
