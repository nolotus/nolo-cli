import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { spawn as spawnChildProcess } from "node:child_process";

import type {
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "./hostAdapter";
import { createGlob, resolveExecutableOnPath } from "./runtimeCompat";

type LocalWorkspaceToolArgs = {
  workspaceRoot: string;
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  commandPrefix?: string[];
};

export type ActivityRef =
  | { type: "file"; path: string }
  | { type: "terminal"; id?: string; label?: string }
  | { type: "url"; url: string; label?: string };

export type ToolActivityAction = {
  title: string;
  kind?: string;
  detail?: string;
  refs?: ActivityRef[];
};

export type ToolActivityPhase = {
  id: string;
  title: string;
  index?: number;
  total?: number;
  status?: "pending" | "running" | "success" | "failed";
};

export type ActivityPlan = {
  title?: string;
  phases: Array<{
    id: string;
    title: string;
    index?: number;
    status?: "pending" | "running" | "success" | "failed";
  }>;
};

export type ToolActivity = Partial<ToolActivityAction> & {
  phase?: ToolActivityPhase;
  action?: ToolActivityAction;
  plan?: ActivityPlan;
};

type WorkspaceFileArgs = {
  path?: unknown;
  file_path?: unknown;
  filePath?: unknown;
  filename?: unknown;
  file?: unknown;
  content?: unknown;
  oldText?: unknown;
  newText?: unknown;
  expectedReplacements?: unknown;
  maxDepth?: unknown;
  entryType?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  maxLines?: unknown;
  tailLines?: unknown;
  query?: unknown;
  pattern?: unknown;
  glob?: unknown;
  exclude?: unknown;
  maxResults?: unknown;
  includeIgnored?: unknown;
  literal?: unknown;
  caseSensitive?: unknown;
  contextLines?: unknown;
  command?: unknown;
  cmd?: unknown;
  branch?: unknown;
  paths?: unknown;
  message?: unknown;
  staged?: unknown;
  baseUrl?: unknown;
  base?: unknown;
  waitSelector?: unknown;
  scrollSelector?: unknown;
  focusSelector?: unknown;
  expectText?: unknown;
  screenshotPath?: unknown;
  metricsPath?: unknown;
  shell?: unknown;
  _activity?: unknown;
};

type OpenAiCompatibleTool = Record<string, unknown> & {
  function?: Record<string, unknown> & { name?: string };
};

export type GlobFilesDescriptionVariant = "brief" | "strategy" | "workflow" | "antiShell";
export type GlobFilesParameterVariant = "minimal" | "scoped" | "rich";
export type SearchFilesDescriptionVariant = "brief" | "strategy" | "workflow" | "antiShell";
export type SearchFilesParameterVariant = "minimal" | "scoped" | "rich";
export type ReadFileDescriptionVariant = "brief" | "strategy" | "workflow" | "antiShell";
export type ReadFileParameterVariant = "minimal" | "scoped" | "rich";
export type ListFilesDescriptionVariant = "brief" | "strategy" | "workflow" | "antiShell";
export type ListFilesParameterVariant = "minimal" | "scoped" | "rich";

const WORKSPACE_TOOL_NAMES = [
  "listFiles",
  "readFile",
  "writeFile",
  "editFile",
  "globFiles",
  "searchFiles",
  "startPreview",
  "getPreviewStatus",
  "stopPreview",
  "releasePreview",
  "captureVisualState",
  "execShell",
] as const;

const DEFAULT_LOCAL_CODING_TOOL_NAMES = [
  "listFiles",
  "readFile",
  "writeFile",
  "editFile",
  "globFiles",
  "searchFiles",
] as const;

const SHELL_TOOL_NAMES = ["execShell"] as const;
const WORKSPACE_TOOL_NAME_SET = new Set<string>(WORKSPACE_TOOL_NAMES);
const REMOVED_WORKSPACE_TOOL_NAMES = new Set([
  "gitStatus",
  "gitDiff",
  "gitCreateBranch",
  "gitAdd",
  "gitCommit",
  "commitWorkspace",
]);

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractActivityRefs(rawRefs: unknown): ActivityRef[] | undefined {
  if (!Array.isArray(rawRefs)) return undefined;
  const refs = rawRefs.flatMap((entry): ActivityRef[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const ref = entry as Record<string, unknown>;
    if (ref.type === "file") {
      const path = readTrimmedString(ref.path);
      return path ? [{ type: "file", path }] : [];
    }
    if (ref.type === "terminal") {
      const id = readTrimmedString(ref.id);
      const label = readTrimmedString(ref.label);
      return id || label
        ? [{ type: "terminal", ...(id ? { id } : {}), ...(label ? { label } : {}) }]
        : [];
    }
    if (ref.type === "url") {
      const url = readTrimmedString(ref.url);
      const label = readTrimmedString(ref.label);
      return url ? [{ type: "url", url, ...(label ? { label } : {}) }] : [];
    }
    return [];
  });
  return refs.length ? refs : undefined;
}

function extractActivityAction(rawAction: unknown): ToolActivityAction | undefined {
  if (!rawAction || typeof rawAction !== "object" || Array.isArray(rawAction)) return undefined;
  const obj = rawAction as Record<string, unknown>;
  const title = readTrimmedString(obj.title);
  if (!title) return undefined;
  const kind = readTrimmedString(obj.kind);
  const detail = readTrimmedString(obj.detail);
  const refs = extractActivityRefs(obj.refs);
  return {
    title,
    ...(kind ? { kind } : {}),
    ...(detail ? { detail } : {}),
    ...(refs ? { refs } : {}),
  };
}

function extractActivityPhase(rawPhase: unknown): ToolActivityPhase | undefined {
  if (!rawPhase || typeof rawPhase !== "object" || Array.isArray(rawPhase)) return undefined;
  const obj = rawPhase as Record<string, unknown>;
  const title = readTrimmedString(obj.title);
  if (!title) return undefined;
  const id = readTrimmedString(obj.id) || title.toLowerCase().replace(/\s+/g, "-");
  const index = readFiniteNumber(obj.index);
  const total = readFiniteNumber(obj.total);
  const status =
    obj.status === "pending" ||
    obj.status === "running" ||
    obj.status === "success" ||
    obj.status === "failed"
      ? obj.status
      : undefined;
  return {
    id,
    title,
    ...(index !== undefined ? { index } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(status ? { status } : {}),
  };
}

function extractActivityPlan(rawPlan: unknown): ActivityPlan | undefined {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) return undefined;
  const obj = rawPlan as Record<string, unknown>;
  if (!Array.isArray(obj.phases)) return undefined;
  const phases = obj.phases.flatMap((entry, index): ActivityPlan["phases"] => {
    const phase = extractActivityPhase(entry);
    if (!phase) return [];
    return [{
      id: phase.id,
      title: phase.title,
      index: phase.index ?? index + 1,
      ...(phase.status ? { status: phase.status } : {}),
    }];
  });
  if (phases.length === 0) return undefined;
  const title = readTrimmedString(obj.title);
  return {
    ...(title ? { title } : {}),
    phases,
  };
}

function extractActivity(parsed: WorkspaceFileArgs): ToolActivity | undefined {
  const raw = parsed._activity;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const nestedAction = extractActivityAction(obj.action);
  const legacyAction = extractActivityAction(obj);
  const action = nestedAction || legacyAction;
  const phase = extractActivityPhase(obj.phase);
  const plan = extractActivityPlan(obj.plan);
  if (!action && !plan) return undefined;
  return {
    ...(action ? action : {}),
    ...(phase ? { phase } : {}),
    ...(nestedAction ? { action: nestedAction } : {}),
    ...(plan ? { plan } : {}),
  };
}

function buildWorkspacePathProperty() {
  return {
    type: "string",
    description: "Path relative to the workspace root.",
  };
}

function buildListWorkspaceDescription(variant?: ListFilesDescriptionVariant) {
  if (variant === "brief") {
    return "List files and directories inside a workspace directory.";
  }
  if (variant === "workflow") {
    return "List a bounded directory overview inside the workspace. Use first when you need to understand nearby structure, choose a subdirectory, or inspect a non-code project. Then use globFiles for path-pattern discovery, searchFiles for text/content discovery, and readFile only for the specific files or line ranges you need.";
  }
  if (variant === "antiShell") {
    return "List a bounded directory overview inside the workspace. Do not use execShell with ls/find/tree for normal directory overviews when listFiles can show the needed depth and limit. Use globFiles for path-pattern discovery and searchFiles for content search.";
  }
  return "List a bounded directory overview inside the workspace. Use for scanning nearby structure, not for path-pattern discovery across the repo. Prefer globFiles for finding files by name/extension and searchFiles for text inside files.";
}

function buildListWorkspaceParameters(variant?: ListFilesParameterVariant) {
  const path = buildWorkspacePathProperty();
  const maxDepth = {
    type: "integer",
    description: "Maximum directory depth to include. Defaults to 1 for the requested directory only.",
  };
  const maxResults = {
    type: "integer",
    description: "Maximum number of entries to return. Use a small value for large directories.",
  };
  const entryType = {
    type: "string",
    enum: ["all", "files", "directories"],
    description: "Filter returned entries. Defaults to all.",
  };
  if (variant === "minimal") {
    return {
      type: "object",
      properties: { path },
    };
  }
  if (variant === "rich") {
    return {
      type: "object",
      properties: {
        path,
        maxDepth,
        maxResults,
        entryType,
      },
    };
  }
  return {
    type: "object",
    properties: {
      path,
      maxResults,
    },
  };
}

function buildListWorkspaceFilesTool(args?: {
  descriptionVariant?: ListFilesDescriptionVariant;
  parameterVariant?: ListFilesParameterVariant;
}): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "listFiles",
      description: buildListWorkspaceDescription(args?.descriptionVariant),
      parameters: buildListWorkspaceParameters(args?.parameterVariant),
    },
  };
}

function buildReadWorkspaceDescription(variant?: ReadFileDescriptionVariant) {
  if (variant === "brief") {
    return "Read a UTF-8 text file inside the workspace.";
  }
  if (variant === "workflow") {
    return "Read a UTF-8 text file inside the workspace after listFiles, globFiles, or searchFiles has narrowed the target. Use line ranges from searchFiles matches and tailLines for logs or generated output. Read the whole file only when the task truly needs all content or exact edit context.";
  }
  if (variant === "antiShell") {
    return "Read a UTF-8 text file inside the workspace. Do not use execShell with cat/sed/head/tail for normal text reads when readFile can return the needed file or line range. Use searchFiles first for content search, then readFile only the relevant lines when possible.";
  }
  return "Read a UTF-8 text file inside the workspace. Read before editing when you need exact text for editFile. For discovery or classification tasks, avoid batch-reading every candidate; report candidate paths first, or read only one to three representative files with maxLines or focused line ranges. Use line ranges for large code, docs, data, configs, and logs after searchFiles returns line numbers. Read the whole file only when the task truly needs all content or exact edit context.";
}

function buildReadWorkspaceParameters(variant?: ReadFileParameterVariant) {
  const path = buildWorkspacePathProperty();
  const startLine = {
    type: "integer",
    description: "1-based first line to return. Use with endLine or maxLines after searchFiles gives a line number.",
  };
  const endLine = {
    type: "integer",
    description: "1-based last line to return, inclusive.",
  };
  const maxLines = {
    type: "integer",
    description: "Maximum number of lines to return starting at startLine, or from the start of the file when startLine is omitted. Use for lightweight previews of candidate configs, docs, data, and logs instead of reading many whole files. When the user gives a read/preview budget, each readFile preview consumes one budget slot.",
  };
  const tailLines = {
    type: "integer",
    description: "Return only the last N lines, useful for logs and generated text.",
  };
  if (variant === "minimal") {
    return {
      type: "object",
      properties: { path },
      required: ["path"],
    };
  }
  if (variant === "rich") {
    return {
      type: "object",
      properties: {
        path,
        startLine,
        endLine,
        maxLines,
        tailLines,
      },
      required: ["path"],
    };
  }
  return {
    type: "object",
    properties: {
      path,
      startLine,
      endLine,
      maxLines,
    },
    required: ["path"],
  };
}

function buildReadWorkspaceFileTool(args?: {
  descriptionVariant?: ReadFileDescriptionVariant;
  parameterVariant?: ReadFileParameterVariant;
}): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "readFile",
      description: buildReadWorkspaceDescription(args?.descriptionVariant),
      parameters: buildReadWorkspaceParameters(args?.parameterVariant),
    },
  };
}

function buildWriteWorkspaceFileTool(): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "writeFile",
      description:
        "Write full UTF-8 file content inside the workspace. For new files or deliberate whole-file rewrites only. For existing files, prefer editFile for targeted edits. Warn that whole-file rewrites can cause line-ending churn.",
      parameters: {
        type: "object",
        properties: {
          path: buildWorkspacePathProperty(),
          content: {
            type: "string",
            description: "Full UTF-8 file content to write.",
          },
        },
        required: ["path", "content"],
      },
    },
  };
}

function buildReplaceWorkspaceTextTool(): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "editFile",
      description:
        "Use for small, exact edits in one workspace file without constructing a patch. Read the file first when you need the exact oldText; set expectedReplacements to avoid accidental broad edits. When expected replacement count fails, report a blocker instead of falling back to a full-file rewrite.",
      parameters: {
        type: "object",
        properties: {
          path: buildWorkspacePathProperty(),
          oldText: {
            type: "string",
            description: "Exact text currently present in the file.",
          },
          newText: {
            type: "string",
            description: "Replacement text to write in place of oldText.",
          },
          expectedReplacements: {
            type: "integer",
            description: "Expected replacement count. Defaults to 1.",
          },
        },
        required: ["path", "oldText", "newText"],
      },
    },
  };
}

function buildSearchWorkspaceDescription(variant?: SearchFilesDescriptionVariant) {
  if (variant === "brief") {
    return "Search workspace file contents.";
  }
  if (variant === "workflow") {
    return "Search file contents inside the current workspace after listFiles or globFiles has scoped the likely area, or directly when the task names text to find. Use for code, docs, data, configs, logs, and other text files. Return line numbers, then use readFile with focused ranges for interpretation or editing.";
  }
  if (variant === "antiShell") {
    return "Search text inside workspace files for code, docs, data, configs, logs, or other text-like assets. Do not use execShell for content search when searchFiles can directly find matching lines. Use globFiles instead for path-only discovery, then readFile for exact surrounding content when needed.";
  }
  return "Search file contents inside the current workspace using ripgrep when available. Use for grep-like text or regex search across code, docs, data, configs, logs, and other text files. Use globFiles instead when you only need to find files by name or extension before readFile.";
}

function buildSearchWorkspaceParameters(variant?: SearchFilesParameterVariant) {
  const query = {
    type: "string",
    description: "Search query. Treated as a regular expression unless literal is true.",
  };
  const path = buildWorkspacePathProperty();
  const includeIgnored = {
    type: "boolean",
    description:
      "When true, search files ignored by .gitignore such as .tmp. Defaults to false; .git and node_modules remain excluded.",
  };
  const exclude = {
    type: "array",
    items: { type: "string" },
    description: "Glob patterns to exclude from content search, for example ['dist/**', 'build/**', 'exports/**', '*.log'].",
  };
  const maxResults = {
    type: "integer",
    description: "Maximum number of matching output lines to return. Use a small value when you only need candidate files or examples.",
  };
  const literal = {
    type: "boolean",
    description: "When true, search for query as literal text instead of a regular expression.",
  };
  const caseSensitive = {
    type: "boolean",
    description: "When false, search case-insensitively. Defaults to true.",
  };
  const contextLines = {
    type: "integer",
    description: "Number of surrounding context lines to include around each match. Defaults to 0.",
  };
  if (variant === "minimal") {
    return {
      type: "object",
      properties: { query },
      required: ["query"],
    };
  }
  if (variant === "rich") {
    return {
      type: "object",
      properties: {
        query,
        path,
        exclude,
        includeIgnored,
        maxResults,
        literal,
        caseSensitive,
        contextLines,
      },
      required: ["query"],
    };
  }
  return {
    type: "object",
    properties: {
      query,
      path,
      includeIgnored,
      maxResults,
    },
    required: ["query"],
  };
}

function buildSearchWorkspaceTool(args?: {
  descriptionVariant?: SearchFilesDescriptionVariant;
  parameterVariant?: SearchFilesParameterVariant;
}): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "searchFiles",
      description: buildSearchWorkspaceDescription(args?.descriptionVariant),
      parameters: buildSearchWorkspaceParameters(args?.parameterVariant),
    },
  };
}

function buildGlobWorkspaceDescription(variant?: GlobFilesDescriptionVariant) {
  if (variant === "brief") {
    return "Find workspace files by path glob without reading file contents.";
  }
  if (variant === "workflow") {
    return "Find files by glob pattern inside the current workspace without reading file contents. Use after listFiles when you know the likely area, or first when the task names a filename, extension, asset type, config, or document pattern. Then use searchFiles for text inside candidates or readFile for the specific candidate paths.";
  }
  if (variant === "antiShell") {
    return "Find workspace files by path glob without reading file contents. Use for code, docs, data, images, configs, logs, or any file discovery task. Do not use execShell or listFiles for path discovery when globFiles can directly narrow candidate files. Use before opening or reading files, and use searchFiles instead for searching text inside files.";
  }
  return "Find files by glob pattern inside the current workspace without reading file contents. Use for code, docs, data, images, configs, logs, or any file discovery task. Use one bounded glob with brace groups before repeated narrow globs when a task names several extensions or config names, for example **/*.{png,jpg,svg}, **/{package.json,bunfig.toml,tsconfig*.json}, or src/**/*.ts. Prefer searchFiles for searching text inside files, and readFile only after candidate paths are narrow enough.";
}

function buildGlobWorkspaceParameters(variant?: GlobFilesParameterVariant) {
  const pattern = {
    type: "string",
    description: "Glob pattern for files. For candidate discovery, combine related names or extensions in one brace-group pattern before making repeated narrow calls, for example '**/*.ts', 'packages/**/local*.test.ts', '**/*.{png,jpg,svg}', or '**/{package.json,bunfig.toml,tsconfig*.json}'.",
  };
  const path = buildWorkspacePathProperty();
  const includeIgnored = {
    type: "boolean",
    description:
      "When true, include files ignored by .gitignore. Defaults to false; .git and node_modules remain excluded.",
  };
  const maxResults = {
    type: "integer",
    description: "Maximum number of file paths to return. Use a small value when you only need candidate paths before readFile; if results are truncated, report that and narrow the pattern or path before reading.",
  };
  const exclude = {
    type: "array",
    items: { type: "string" },
    description: "Glob patterns to exclude from results, for example ['dist/**', 'build/**', 'exports/**', '*.tmp'].",
  };
  if (variant === "minimal") {
    return {
      type: "object",
      properties: { pattern },
      required: ["pattern"],
    };
  }
  if (variant === "rich") {
    return {
      type: "object",
      properties: {
        pattern,
        path,
        exclude,
        includeIgnored,
        maxResults,
      },
      required: ["pattern"],
    };
  }
  return {
    type: "object",
    properties: {
      pattern,
      glob: {
        type: "string",
        description: "Alias for pattern, kept for compatibility with codeSearch-style prompts.",
      },
      path,
      exclude,
      includeIgnored,
      maxResults,
    },
  };
}

function buildGlobWorkspaceFilesTool(args?: {
  descriptionVariant?: GlobFilesDescriptionVariant;
  parameterVariant?: GlobFilesParameterVariant;
}): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "globFiles",
      description: buildGlobWorkspaceDescription(args?.descriptionVariant),
      parameters: buildGlobWorkspaceParameters(args?.parameterVariant),
    },
  };
}

function buildPreviewLifecycleTool(toolName: string): OpenAiCompatibleTool {
  const descriptions: Record<string, string> = {
    startPreview: "Start the local preview stack for the current workspace.",
    getPreviewStatus: "Read local preview status, including localApiOrigin and process state.",
    stopPreview: "Stop the local preview stack for the current workspace.",
    releasePreview: "Release the local preview slot for the current workspace after stopping preview.",
  };
  return {
    type: "function",
    function: {
      name: toolName,
      description: descriptions[toolName] ?? "Run a local preview lifecycle action.",
      parameters: { type: "object", properties: {} },
    },
  };
}

function buildCaptureVisualStateTool(): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "captureVisualState",
      description: "Capture a real local app screenshot and DOM/computed-style metrics for a selected UI state.",
      parameters: {
        type: "object",
        properties: {
          baseUrl: {
            type: "string",
            description: "Optional local preview base URL. When omitted, the tool reads preview:status.",
          },
          path: {
            type: "string",
            description: "App route to open, for example / or /dialog-123. Defaults to /.",
          },
          waitSelector: {
            type: "string",
            description: "CSS selector that must become visible before capture.",
          },
          scrollSelector: {
            type: "string",
            description: "Optional CSS selector to scroll into view before capture.",
          },
          focusSelector: {
            type: "string",
            description: "Optional CSS selector for the target element whose rect/style should be reported.",
          },
          expectText: {
            type: "string",
            description: "Optional visible text expected on the page before capture.",
          },
          screenshotPath: {
            type: "string",
            description: "Workspace-relative screenshot path. Defaults under test-results/frontend-agent/.",
          },
          metricsPath: {
            type: "string",
            description: "Workspace-relative metrics JSON path. Defaults under test-results/frontend-agent/.",
          },
        },
        required: ["waitSelector"],
      },
    },
  };
}

function buildExecShellTool(toolName: string): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: toolName,
      description:
        "Run a shell command in the local workspace. Commands already execute from the workspace root; do not cd into guessed paths such as /workspace, /repo, /home/user, or /home/user/workspace. Prefer one command that performs a complete verification or related git operation instead of many tiny commands. For branch setup, prefer idempotent commands such as git switch -C <branch> when replacing or recreating a benchmark branch is acceptable. Use portable POSIX commands for macOS/BSD shells; avoid GNU-only flags such as cat -A. Do not use cat -A. Do not use brittle byte-offset commands such as xxd -s -32. For separator lines, use echo or printf '%s\\n'. For text-file content or trailing-newline checks, prefer readFile over shell byte inspection when that tool is available. Do not run repeated git status, git log, git rev-parse, or branch checks after a successful command already returned the needed clean status and commit information; use one final verification command. If a command fails, use the error output to adjust the next command rather than repeating the same shape.",
      parameters: {
        type: "object",
        properties: {
          cmd: {
            type: "string",
            description: "Shell command to run.",
          },
          command: {
            type: "string",
            description: "Shell command to run.",
          },
        },
      },
    },
  };
}

function wrapPowerShellCommand(command: string) {
  return [
    "[Console]::InputEncoding=[System.Text.Encoding]::UTF8",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$OutputEncoding=[System.Text.Encoding]::UTF8",
    "$PSStyle.OutputRendering='PlainText'",
    command,
  ].join("; ");
}

function findPowerShellExecutable() {
  return resolveExecutableOnPath("pwsh") || resolveExecutableOnPath("powershell.exe") || resolveExecutableOnPath("powershell");
}

function buildPowerShellCommand(command: string) {
  const executable = findPowerShellExecutable();
  if (!executable) throw new Error("PowerShell is not available on this machine.");
  return [
    executable,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    wrapPowerShellCommand(command),
  ];
}

function buildBashCommand(command: string) {
  const executable = resolveExecutableOnPath("bash") || resolveExecutableOnPath("sh");
  if (!executable) throw new Error("bash/sh is not available on this machine.");
  return [executable, "-lc", command];
}

function buildWorkspaceShellCommand(args: {
  toolName: string;
  command: string;
  shell?: unknown;
}) {
  if (args.shell === "powershell") return buildPowerShellCommand(args.command);
  if (args.shell === "bash") return buildBashCommand(args.command);
  return process.platform === "win32"
    ? buildPowerShellCommand(args.command)
    : buildBashCommand(args.command);
}

function buildWorkspaceToolDefinition(toolName: string, args?: {
  listFilesDescriptionVariant?: ListFilesDescriptionVariant;
  listFilesParameterVariant?: ListFilesParameterVariant;
  readFileDescriptionVariant?: ReadFileDescriptionVariant;
  readFileParameterVariant?: ReadFileParameterVariant;
  globFilesDescriptionVariant?: GlobFilesDescriptionVariant;
  globFilesParameterVariant?: GlobFilesParameterVariant;
  searchFilesDescriptionVariant?: SearchFilesDescriptionVariant;
  searchFilesParameterVariant?: SearchFilesParameterVariant;
}) {
  if (toolName === "listFiles") {
    return buildListWorkspaceFilesTool({
      descriptionVariant: args?.listFilesDescriptionVariant,
      parameterVariant: args?.listFilesParameterVariant,
    });
  }
  if (toolName === "readFile") {
    return buildReadWorkspaceFileTool({
      descriptionVariant: args?.readFileDescriptionVariant,
      parameterVariant: args?.readFileParameterVariant,
    });
  }
  if (toolName === "writeFile") {
    return buildWriteWorkspaceFileTool();
  }
  if (toolName === "editFile") {
    return buildReplaceWorkspaceTextTool();
  }
  if (toolName === "globFiles") {
    return buildGlobWorkspaceFilesTool({
      descriptionVariant: args?.globFilesDescriptionVariant,
      parameterVariant: args?.globFilesParameterVariant,
    });
  }
  if (toolName === "searchFiles") {
    return buildSearchWorkspaceTool({
      descriptionVariant: args?.searchFilesDescriptionVariant,
      parameterVariant: args?.searchFilesParameterVariant,
    });
  }
  if (toolName === "startPreview" || toolName === "getPreviewStatus" || toolName === "stopPreview" || toolName === "releasePreview") {
    return buildPreviewLifecycleTool(toolName);
  }
  if (toolName === "captureVisualState") return buildCaptureVisualStateTool();
  if (toolName === "execShell") return buildExecShellTool(toolName);
  return null;
}

function filterDeclaredWorkspaceToolNames(args: {
  toolNames?: string[];
  exposeShellTools: boolean;
}) {
  return (args.toolNames ?? []).filter((toolName) =>
    WORKSPACE_TOOL_NAME_SET.has(toolName) &&
    !REMOVED_WORKSPACE_TOOL_NAMES.has(toolName) &&
    (args.exposeShellTools || !SHELL_TOOL_NAMES.includes(toolName as any))
  );
}

export function buildLocalWorkspaceToolset(args: {
  declaredToolNames?: string[];
  exposeShellTools?: boolean;
  useDeclaredToolNamesOnly?: boolean;
}) {
  const exposeShellTools = args.exposeShellTools === true;
  if (args.useDeclaredToolNamesOnly) {
    const toolNames = new Set(filterDeclaredWorkspaceToolNames({
      toolNames: args.declaredToolNames,
      exposeShellTools,
    }));
    return {
      toolNames: [...toolNames],
      exposeShellTools,
    };
  }
  const toolNames = new Set([
    ...DEFAULT_LOCAL_CODING_TOOL_NAMES,
    ...(exposeShellTools ? SHELL_TOOL_NAMES : []),
    ...filterDeclaredWorkspaceToolNames({
      toolNames: args.declaredToolNames,
      exposeShellTools,
    }),
  ]);
  return {
    toolNames: [...toolNames],
    exposeShellTools,
  };
}

export function buildLocalWorkspacePolicyToolNames(args: {
  declaredToolNames?: string[];
  exposeShellTools?: boolean;
  useDeclaredToolNamesOnly?: boolean;
}) {
  if (args.useDeclaredToolNamesOnly) {
    return filterDeclaredWorkspaceToolNames({
      toolNames: args.declaredToolNames,
      exposeShellTools: args.exposeShellTools === true,
    });
  }
  return [...new Set([
    ...buildLocalWorkspaceToolset({
      exposeShellTools: args.exposeShellTools,
    }).toolNames,
    ...filterDeclaredWorkspaceToolNames({
      toolNames: args.declaredToolNames,
      exposeShellTools: args.exposeShellTools === true,
    }),
  ])].filter((toolName) => !REMOVED_WORKSPACE_TOOL_NAMES.has(toolName));
}

export function buildLocalWorkspaceOpenAiTools(args: {
  toolNames?: string[];
  exposeShellTools?: boolean;
  listFilesDescriptionVariant?: ListFilesDescriptionVariant;
  listFilesParameterVariant?: ListFilesParameterVariant;
  readFileDescriptionVariant?: ReadFileDescriptionVariant;
  readFileParameterVariant?: ReadFileParameterVariant;
  globFilesDescriptionVariant?: GlobFilesDescriptionVariant;
  globFilesParameterVariant?: GlobFilesParameterVariant;
  searchFilesDescriptionVariant?: SearchFilesDescriptionVariant;
  searchFilesParameterVariant?: SearchFilesParameterVariant;
}) {
  const declaredTools = new Set(args.toolNames ?? []);
  return WORKSPACE_TOOL_NAMES
    .filter((toolName) => {
      if (!declaredTools.has(toolName)) return false;
      if (!args.exposeShellTools && toolName === "execShell") {
        return false;
      }
      return true;
    })
    .map((toolName) => buildWorkspaceToolDefinition(toolName, {
      listFilesDescriptionVariant: args.listFilesDescriptionVariant,
      listFilesParameterVariant: args.listFilesParameterVariant,
      readFileDescriptionVariant: args.readFileDescriptionVariant,
      readFileParameterVariant: args.readFileParameterVariant,
      globFilesDescriptionVariant: args.globFilesDescriptionVariant,
      globFilesParameterVariant: args.globFilesParameterVariant,
      searchFilesDescriptionVariant: args.searchFilesDescriptionVariant,
      searchFilesParameterVariant: args.searchFilesParameterVariant,
    }))
    .filter((tool): tool is OpenAiCompatibleTool => Boolean(tool));
}

function parseWorkspaceToolArguments(raw: string): WorkspaceFileArgs {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed as WorkspaceFileArgs : {};
  } catch {
    return {};
  }
}

function normalizeWorkspaceRelativePath(args: {
  workspaceRoot: string;
  targetPath: string;
}) {
  const relativePath = relative(args.workspaceRoot, args.targetPath);
  return relativePath || ".";
}

function isPathInsideWorkspace(args: {
  workspaceRoot: string;
  targetPath: string;
}) {
  const relativePath = relative(args.workspaceRoot, args.targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`));
}

function requireWorkspaceToolPath(args: WorkspaceFileArgs) {
  const requestedPath = readWorkspacePathAlias(args) ?? "";
  if (!requestedPath) throw new Error("Workspace tool requires a non-empty path.");
  return requestedPath;
}

function readWorkspacePathAlias(args: WorkspaceFileArgs) {
  const path =
    args.path ??
    args.file_path ??
    args.filePath ??
    args.filename ??
    args.file;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

function requireWorkspaceFileContent(args: WorkspaceFileArgs) {
  if (typeof args.content !== "string") {
    throw new Error("writeFile requires string content.");
  }
  return args.content;
}

function requireWorkspaceOldText(args: WorkspaceFileArgs) {
  if (typeof args.oldText !== "string" || !args.oldText) {
    throw new Error("editFile requires non-empty oldText.");
  }
  return args.oldText;
}

function requireWorkspaceNewText(args: WorkspaceFileArgs) {
  if (typeof args.newText !== "string") {
    throw new Error("editFile requires string newText.");
  }
  return args.newText;
}

function readExpectedReplacementCount(args: WorkspaceFileArgs) {
  if (args.expectedReplacements === undefined) return 1;
  const value = Number(args.expectedReplacements);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("editFile expectedReplacements must be a positive integer.");
  }
  return value;
}

function readPositiveIntegerArg(args: {
  value: unknown;
  name: string;
  max?: number;
}) {
  if (args.value === undefined) return undefined;
  const value = Number(args.value);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${args.name} must be a positive integer.`);
  }
  return args.max ? Math.min(value, args.max) : value;
}

function readFileSliceArgs(args: WorkspaceFileArgs) {
  const startLine = readPositiveIntegerArg({ value: args.startLine, name: "startLine" });
  const endLine = readPositiveIntegerArg({ value: args.endLine, name: "endLine" });
  const maxLines = readPositiveIntegerArg({ value: args.maxLines, name: "maxLines", max: 2000 });
  const tailLines = readPositiveIntegerArg({ value: args.tailLines, name: "tailLines", max: 2000 });
  if (tailLines !== undefined && (startLine !== undefined || endLine !== undefined)) {
    throw new Error("tailLines cannot be combined with startLine or endLine.");
  }
  if (endLine !== undefined && startLine !== undefined && endLine < startLine) {
    throw new Error("endLine must be greater than or equal to startLine.");
  }
  return {
    startLine,
    endLine,
    maxLines,
    tailLines,
  };
}

function splitTextLines(content: string) {
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function sliceReadFileContent(args: {
  content: string;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  tailLines?: number;
}) {
  const lines = splitTextLines(args.content);
  const totalLines = lines.length;
  if (
    args.startLine === undefined &&
    args.endLine === undefined &&
    args.maxLines === undefined &&
    args.tailLines === undefined
  ) {
    return {
      content: args.content,
      startLine: 1,
      endLine: totalLines,
      totalLines,
      truncated: false,
    };
  }
  if (args.tailLines !== undefined) {
    const startIndex = Math.max(0, totalLines - args.tailLines);
    const selected = lines.slice(startIndex);
    return {
      content: selected.join("\n"),
      startLine: startIndex + 1,
      endLine: startIndex + selected.length,
      totalLines,
      truncated: startIndex > 0,
    };
  }
  const startLine = args.startLine ?? 1;
  let endLine = args.endLine ?? totalLines;
  if (args.maxLines !== undefined) {
    endLine = Math.min(endLine, startLine + args.maxLines - 1);
  }
  const startIndex = Math.min(Math.max(startLine - 1, 0), totalLines);
  const endIndex = Math.min(Math.max(endLine, 0), totalLines);
  const selected = lines.slice(startIndex, endIndex);
  const effectiveEndLine = selected.length ? startIndex + selected.length : startIndex;
  return {
    content: selected.join("\n"),
    startLine,
    endLine: effectiveEndLine,
    totalLines,
    truncated: startLine > 1 || effectiveEndLine < totalLines,
  };
}

function countExactTextOccurrences(args: {
  content: string;
  oldText: string;
}) {
  return args.content.split(args.oldText).length - 1;
}

function pluralizeReplacement(count: number) {
  return count === 1 ? "replacement" : "replacements";
}

function requireWorkspaceSearchQuery(args: WorkspaceFileArgs) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("searchFiles requires a non-empty query.");
  return query;
}

function requireWorkspaceGlobPattern(args: WorkspaceFileArgs) {
  const pattern = typeof args.pattern === "string" && args.pattern.trim()
    ? args.pattern.trim()
    : typeof args.glob === "string" && args.glob.trim()
      ? args.glob.trim()
      : "";
  if (!pattern) throw new Error("globFiles requires a non-empty pattern.");
  return pattern;
}

function readWorkspaceMaxResults(args: WorkspaceFileArgs) {
  if (args.maxResults === undefined) return undefined;
  const value = Number(args.maxResults);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("maxResults must be a positive integer.");
  }
  return Math.min(value, 500);
}

function readWorkspaceMaxDepth(args: WorkspaceFileArgs) {
  if (args.maxDepth === undefined) return 1;
  const value = Number(args.maxDepth);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("maxDepth must be a positive integer.");
  }
  return Math.min(value, 10);
}

function readWorkspaceEntryType(args: WorkspaceFileArgs) {
  if (args.entryType === undefined) return "all";
  if (args.entryType === "all" || args.entryType === "files" || args.entryType === "directories") {
    return args.entryType;
  }
  throw new Error("entryType must be one of all, files, or directories.");
}

function readWorkspaceContextLines(args: WorkspaceFileArgs) {
  if (args.contextLines === undefined) return undefined;
  const value = Number(args.contextLines);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("contextLines must be a non-negative integer.");
  }
  return Math.min(value, 20);
}

function readWorkspaceExcludeGlobs(args: WorkspaceFileArgs) {
  if (args.exclude === undefined) return [];
  if (typeof args.exclude === "string" && args.exclude.trim()) {
    return [args.exclude.trim()];
  }
  if (!Array.isArray(args.exclude)) {
    throw new Error("exclude must be a glob string or an array of glob strings.");
  }
  return args.exclude.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
}

function requireShellCommand(args: WorkspaceFileArgs, toolName: string) {
  const command = typeof args.cmd === "string"
    ? args.cmd.trim()
    : typeof args.command === "string"
      ? args.command.trim()
      : "";
  if (!command) throw new Error(`${toolName} requires a non-empty command.`);
  return command;
}

function requireVisualWaitSelector(args: WorkspaceFileArgs) {
  const selector = typeof args.waitSelector === "string" ? args.waitSelector.trim() : "";
  if (!selector) throw new Error("captureVisualState requires a non-empty waitSelector.");
  return selector;
}

function readOptionalStringArg(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readVisualStateCaptureArgs(args: WorkspaceFileArgs) {
  const baseUrl = readOptionalStringArg(args.baseUrl) ?? readOptionalStringArg(args.base);
  const path = readOptionalStringArg(args.path) ?? "/";
  const waitSelector = requireVisualWaitSelector(args);
  const scrollSelector = readOptionalStringArg(args.scrollSelector);
  const focusSelector = readOptionalStringArg(args.focusSelector);
  const expectText = readOptionalStringArg(args.expectText);
  const screenshotPath =
    readOptionalStringArg(args.screenshotPath) ?? "test-results/frontend-agent/visual-state.png";
  const metricsPath =
    readOptionalStringArg(args.metricsPath) ?? "test-results/frontend-agent/visual-state-metrics.json";
  return {
    baseUrl,
    path,
    waitSelector,
    scrollSelector,
    focusSelector,
    expectText,
    screenshotPath,
    metricsPath,
  };
}

async function readWorkspacePackageScripts(workspaceRoot: string): Promise<{
  scripts: string[];
  error?: string;
}> {
  try {
    const raw = await readFile(resolve(workspaceRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    const scripts = parsed && typeof parsed === "object" && parsed.scripts && typeof parsed.scripts === "object"
      ? Object.keys(parsed.scripts).sort()
      : [];
    return { scripts };
  } catch (error) {
    return {
      scripts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatAvailableScripts(scripts: string[]) {
  return scripts.length ? scripts.join(", ") : "(none)";
}

async function runWorkspacePackageScript(args: {
  workspaceRoot: string;
  script: string;
  extraArgs?: string[];
  commandTimeoutMs?: number;
}): Promise<AgentRuntimeToolResult> {
  const script = args.script.trim();
  if (!script) throw new Error("package script name is required.");
  const extraArgs = args.extraArgs ?? [];
  const packageScripts = await readWorkspacePackageScripts(args.workspaceRoot);
  if (!packageScripts.scripts.includes(script)) {
    return {
      content: [
        `script not found: ${script}`,
        `available scripts: ${formatAvailableScripts(packageScripts.scripts)}`,
        ...(packageScripts.error ? [`package.json read error: ${packageScripts.error}`] : []),
      ].join("\n"),
      metadata: {
        script,
        exitCode: 1,
        reason: "script-not-found",
        availableScripts: packageScripts.scripts,
        ...(packageScripts.error ? { packageJsonError: packageScripts.error } : {}),
      },
    };
  }
  const result = await runWorkspaceCommand({
    workspaceRoot: args.workspaceRoot,
    command: ["bun", "run", script, ...(extraArgs.length ? ["--", ...extraArgs] : [])],
    timeoutMs: args.commandTimeoutMs,
  });
  return {
    content: result.content,
    metadata: {
      script,
      args: extraArgs,
      exitCode: result.exitCode,
      reason: result.exitCode === 0 ? "ok" : "script-failed",
      timedOut: result.timedOut,
      stdoutTail: result.stdout.trim().slice(-4000),
      stderrTail: result.stderr.trim().slice(-4000),
    },
  };
}

function truncateToolOutput(value: string, limit = 20_000) {
  if (value.length <= limit) return value;
  const approxMarkerLen = 40;
  if (limit <= approxMarkerLen) return value.slice(0, limit);
  const remaining = limit - approxMarkerLen;
  const headSize = Math.floor(remaining * 0.3);
  const tailSize = remaining - headSize;
  const head = value.slice(0, headSize);
  const tail = value.slice(-tailSize);
  const actualRemoved = value.length - headSize - tailSize;
  return `${head}\n\n[... truncated ${actualRemoved} chars ...]\n\n${tail}`;
}

function parseLastJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    try {
      const parsed = JSON.parse(trimmed.slice(index));
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      // Try the previous opening brace.
    }
  }
  return null;
}

function readNodeStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    stream.on("error", rejectRead);
    stream.on("end", () => resolveRead(Buffer.concat(chunks).toString("utf8")));
  });
}

function waitForNodeProcessExit(proc: ReturnType<typeof spawnChildProcess>) {
  return new Promise<number>((resolveExit, rejectExit) => {
    proc.once("error", rejectExit);
    proc.once("close", (code, signal) => {
      if (typeof code === "number") {
        resolveExit(code);
        return;
      }
      resolveExit(signal ? 1 : 0);
    });
  });
}

async function runWorkspaceCommand(args: {
  workspaceRoot: string;
  command: string[];
  stdin?: string;
  timeoutMs?: number;
  outputLimit?: number;
  commandPrefix?: string[];
}) {
  const timeoutMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? args.timeoutMs
      : undefined;
  const detached = process.platform !== "win32";
  const command = [
    ...(args.commandPrefix ?? []),
    ...args.command,
  ];
  const proc = spawnChildProcess(command[0] ?? "", command.slice(1), {
    cwd: resolve(args.workspaceRoot),
    stdio: [
      args.stdin === undefined ? "ignore" : "pipe",
      "pipe",
      "pipe",
    ],
    detached,
  });
  if (args.stdin !== undefined && proc.stdin) {
    proc.stdin.write(args.stdin);
    proc.stdin.end();
  }
  const exitPromise = waitForNodeProcessExit(proc);
  const stdoutPromise = readNodeStream(proc.stdout);
  const stderrPromise = readNodeStream(proc.stderr);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = Symbol("timeout");
  const exitOrTimeout = timeoutMs
    ? await Promise.race([
        exitPromise,
        new Promise<typeof timeoutResult>((resolveTimeout) => {
          timeout = setTimeout(() => resolveTimeout(timeoutResult), timeoutMs);
        }),
      ])
    : await exitPromise;
  if (timeout) clearTimeout(timeout);
  const timedOut = exitOrTimeout === timeoutResult;
  if (timedOut) {
    const kill = (signal: NodeJS.Signals) => {
      if (detached && typeof proc.pid === "number") {
        try {
          process.kill(-proc.pid, signal);
          return;
        } catch {
          // Fall through to killing the immediate child.
        }
      }
      try {
        proc.kill(signal);
      } catch {
        // The command may have exited after the timeout won the race.
      }
    };
    kill("SIGTERM");
    await Promise.race([
      exitPromise.catch(() => 124),
      new Promise((resolveKill) => setTimeout(resolveKill, 500)),
    ]);
    kill("SIGKILL");
  }
  const [stdout, rawStderr] = await Promise.all([
    stdoutPromise,
    stderrPromise,
  ]);
  const exitCode = timedOut ? 124 : Number(exitOrTimeout);
  const stderr = timedOut
    ? `${rawStderr.trim() ? `${rawStderr.trim()}\n` : ""}command timed out after ${timeoutMs ?? "unknown"}ms\n`
    : rawStderr;
  return {
    stdout,
    stderr,
    exitCode,
    timedOut,
    content: truncateToolOutput([
      stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
      stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
      `exitCode: ${exitCode}`,
    ].filter(Boolean).join("\n\n"), args.outputLimit),
  };
}

async function runWorkspaceCommandLimitedLines(args: {
  workspaceRoot: string;
  command: string[];
  maxLines: number;
  commandPrefix?: string[];
}) {
  const command = [
    ...(args.commandPrefix ?? []),
    ...args.command,
  ];
  const proc = spawnChildProcess(command[0] ?? "", command.slice(1), {
    cwd: resolve(args.workspaceRoot),
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const exitPromise = waitForNodeProcessExit(proc);
  const stderrPromise = readNodeStream(proc.stderr);
  const lines: string[] = [];
  let pending = "";
  let limitedByMaxResults = false;
  await new Promise<void>((resolveRead, rejectRead) => {
    proc.stdout?.on("data", (chunk) => {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? "";
      for (const part of parts) {
        if (!part) continue;
        lines.push(part);
        if (lines.length >= args.maxLines) {
          limitedByMaxResults = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            // The command may already have exited.
          }
          break;
        }
      }
    });
    proc.stdout?.on("error", rejectRead);
    proc.stdout?.on("end", () => resolveRead());
  });
    if (!limitedByMaxResults && pending.trim()) lines.push(pending);
  const exitCode = limitedByMaxResults ? 0 : await exitPromise;
  const stderr = await stderrPromise;
  return {
    stdout: lines.slice(0, args.maxLines).join("\n"),
    stderr,
    exitCode,
    limitedByMaxResults,
  };
}

export function resolveLocalWorkspaceToolPath(args: {
  workspaceRoot: string;
  requestedPath: string;
}) {
  const workspaceRoot = resolve(args.workspaceRoot);
  const targetPath = resolve(workspaceRoot, args.requestedPath);
  if (!isPathInsideWorkspace({ workspaceRoot, targetPath })) {
    throw new Error(`Workspace tool path escapes workspace root: ${args.requestedPath}`);
  }
  return targetPath;
}

async function readFileTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const requestedPath = requireWorkspaceToolPath(parsed);
  const sliceArgs = readFileSliceArgs(parsed);
  const absolutePath = resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
  });
  const content = await readFile(absolutePath, "utf8");
  const activity = extractActivity(parsed);
  const sliced = sliceReadFileContent({
    content,
    ...sliceArgs,
  });
  return {
    content: sliced.content,
    metadata: {
      path: normalizeWorkspaceRelativePath({
        workspaceRoot: resolve(args.workspaceRoot),
        targetPath: absolutePath,
      }),
      bytes: Buffer.byteLength(sliced.content),
      totalBytes: Buffer.byteLength(content),
      startLine: sliced.startLine,
      endLine: sliced.endLine,
      totalLines: sliced.totalLines,
      truncated: sliced.truncated,
      ...(sliceArgs.maxLines ? { maxLines: sliceArgs.maxLines } : {}),
      ...(sliceArgs.tailLines ? { tailLines: sliceArgs.tailLines } : {}),
      ...(activity ? { activity } : {}),
    },
  };
}

async function writeFileTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
}): Promise<AgentRuntimeToolResult> {
  // TODO: Explore cheaply including diff stat/EOL warning after writeFile.
  // If implementation is larger than a small safe change, defer it.
  // Exact boundaries: writeFileTool function in localWorkspaceTools.ts.
  // Consider adding a post-write hook that runs `git diff --stat` and checks line endings.
  // Keep it optional and non-blocking.
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const requestedPath = requireWorkspaceToolPath(parsed);
  const content = requireWorkspaceFileContent(parsed);
  const absolutePath = resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
  });
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  const relativePath = normalizeWorkspaceRelativePath({
    workspaceRoot: resolve(args.workspaceRoot),
    targetPath: absolutePath,
  });
  const activity = extractActivity(parsed);
  return {
    content: `wrote ${relativePath}`,
    metadata: {
      path: relativePath,
      bytes: Buffer.byteLength(content),
      ...(activity ? { activity } : {}),
    },
  };
}

async function editFileTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const requestedPath = requireWorkspaceToolPath(parsed);
  const oldText = requireWorkspaceOldText(parsed);
  const newText = requireWorkspaceNewText(parsed);
  const expectedReplacements = readExpectedReplacementCount(parsed);
  const absolutePath = resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
  });
  const content = await readFile(absolutePath, "utf8");
  const replacementCount = countExactTextOccurrences({ content, oldText });
  if (replacementCount !== expectedReplacements) {
    throw new Error(
      `editFile expected ${expectedReplacements} ${pluralizeReplacement(expectedReplacements)} ` +
        `but found ${replacementCount} in ${requestedPath}.`
    );
  }
  const nextContent = content.split(oldText).join(newText);
  await writeFile(absolutePath, nextContent, "utf8");
  const relativePath = normalizeWorkspaceRelativePath({
    workspaceRoot: resolve(args.workspaceRoot),
    targetPath: absolutePath,
  });
  const activity = extractActivity(parsed);
  return {
    content: `replaced ${replacementCount} occurrence${replacementCount === 1 ? "" : "s"} in ${relativePath}`,
    metadata: {
      path: relativePath,
      replacements: replacementCount,
      bytes: Buffer.byteLength(nextContent),
      ...(activity ? { activity } : {}),
    },
  };
}

async function formatWorkspaceDirEntry(args: {
  workspaceRoot: string;
  dirPath: string;
  name: string;
}) {
  const absolutePath = resolve(args.dirPath, args.name);
  const info = await stat(absolutePath);
  const relativePath = normalizeWorkspaceRelativePath({
    workspaceRoot: resolve(args.workspaceRoot),
    targetPath: absolutePath,
  });
  return info.isDirectory() ? `${relativePath}/` : relativePath;
}

async function listWorkspaceEntries(args: {
  workspaceRoot: string;
  dirPath: string;
  maxDepth: number;
  entryType: "all" | "files" | "directories";
  maxResults?: number;
}) {
  const entries: string[] = [];
  let truncated = false;
  let visitedEntries = 0;
  let limitedByMaxDepth = false;
  const visit = async (dirPath: string, depth: number) => {
    if (truncated) return;
    const names = (await readdir(dirPath)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (truncated) break;
      const absolutePath = resolve(dirPath, name);
      const info = await stat(absolutePath);
      visitedEntries += 1;
      const relativePath = normalizeWorkspaceRelativePath({
        workspaceRoot: resolve(args.workspaceRoot),
        targetPath: absolutePath,
      });
      const isDirectory = info.isDirectory();
      if (
        args.entryType === "all" ||
        (args.entryType === "files" && !isDirectory) ||
        (args.entryType === "directories" && isDirectory)
      ) {
        entries.push(isDirectory ? `${relativePath}/` : relativePath);
        if (args.maxResults && entries.length >= args.maxResults) {
          truncated = true;
          break;
        }
      }
      if (isDirectory && depth < args.maxDepth) {
        await visit(absolutePath, depth + 1);
      } else if (isDirectory && depth >= args.maxDepth && !limitedByMaxDepth) {
        const childNames = await readdir(absolutePath);
        limitedByMaxDepth = childNames.length > 0;
      }
    }
  };
  await visit(args.dirPath, 1);
  return {
    entries,
    truncated,
    visitedEntries,
    limitedByMaxDepth,
  };
}

async function listFilesTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const requestedPath = readWorkspacePathAlias(parsed) ?? ".";
  const maxDepth = readWorkspaceMaxDepth(parsed);
  const maxResults = readWorkspaceMaxResults(parsed);
  const entryType = readWorkspaceEntryType(parsed);
  const dirPath = resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
  });
  const listed = await listWorkspaceEntries({
    workspaceRoot: args.workspaceRoot,
    dirPath,
    maxDepth,
    maxResults,
    entryType,
  });
  return {
    content: listed.entries.join("\n"),
    metadata: {
      path: requestedPath,
      count: listed.entries.length,
      maxDepth,
      entryType,
      truncated: listed.truncated,
      limitedByMaxResults: listed.truncated,
      limitedByMaxDepth: listed.limitedByMaxDepth,
      visitedEntries: listed.visitedEntries,
      ...(maxResults ? { maxResults } : {}),
    },
  };
}

async function searchFilesTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const query = requireWorkspaceSearchQuery(parsed);
  const exclude = readWorkspaceExcludeGlobs(parsed);
  const maxResults = readWorkspaceMaxResults(parsed);
  const contextLines = readWorkspaceContextLines(parsed);
  const literal = parsed.literal === true;
  const caseSensitive = parsed.caseSensitive === false ? false : true;
  const requestedPath = readWorkspacePathAlias(parsed) ?? ".";
  const includeIgnored = parsed.includeIgnored === true;
  const searchPath = resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
  });
  const relativeSearchPath = normalizeWorkspaceRelativePath({
    workspaceRoot: resolve(args.workspaceRoot),
    targetPath: searchPath,
  });
  const rgCommand = [
    "rg",
    "--line-number",
    "--no-heading",
    "--hidden",
    ...(literal ? ["--fixed-strings"] : []),
    ...(caseSensitive ? [] : ["--ignore-case"]),
    ...(contextLines !== undefined ? ["--context", String(contextLines)] : []),
    ...(includeIgnored ? ["--no-ignore"] : []),
    "--glob",
    "!node_modules",
    "--glob",
    "!.git",
    ...exclude.flatMap((excludePattern) => ["--glob", `!${excludePattern}`]),
    "--",
    query,
    relativeSearchPath,
  ];
  const grepCommand = [
    "grep",
    "-R",
    "-n",
    "-I",
    ...(literal ? ["-F"] : []),
    ...(caseSensitive ? [] : ["-i"]),
    ...(contextLines !== undefined ? ["-C", String(contextLines)] : []),
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    ...exclude.flatMap((excludePattern) => ["--exclude", excludePattern]),
    query,
    relativeSearchPath,
  ];
  const result = await (async () => {
    try {
      return maxResults && !contextLines
        ? await runWorkspaceCommandLimitedLines({
            workspaceRoot: args.workspaceRoot,
            command: rgCommand,
            maxLines: maxResults,
          })
        : await runWorkspaceCommand({
            workspaceRoot: args.workspaceRoot,
            command: rgCommand,
          });
    } catch {
      return maxResults && !contextLines
        ? await runWorkspaceCommandLimitedLines({
            workspaceRoot: args.workspaceRoot,
            command: grepCommand,
            maxLines: maxResults,
          })
        : await runWorkspaceCommand({
            workspaceRoot: args.workspaceRoot,
            command: grepCommand,
          });
    }
  })();
  let outputLines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd().replace(/^\.\//, ""))
    .filter(Boolean);
  let limitedByMaxResults = "limitedByMaxResults" in result && result.limitedByMaxResults === true;
  if (outputLines.length === 0 && result.exitCode === 0 && (includeIgnored || !(await hasRootGitignore(args.workspaceRoot)))) {
    const fallback = await scanWorkspaceTextMatches({
      workspaceRoot: args.workspaceRoot,
      relativeSearchPath,
      query,
      exclude,
      maxResults,
      literal,
      caseSensitive,
      contextLines,
    });
    outputLines = fallback.lines;
    limitedByMaxResults = fallback.limitedByMaxResults;
  }
  if (contextLines && outputLines.length > 0) {
    const limited = limitSearchOutputByMatches(outputLines, maxResults);
    outputLines = limited.lines;
    limitedByMaxResults = limitedByMaxResults || limited.truncated;
  }
  const matchLines = outputLines.filter((line) => /:\d+:/.test(line));
  const matchedFiles = Array.from(new Set(matchLines.flatMap((line) => {
    const match = line.match(/^(.*?):\d+:/);
    return match?.[1] ? [match[1]] : [];
  })));
  return {
    content: outputLines.join("\n"),
    metadata: {
      query,
      path: requestedPath,
      searchedPath: relativeSearchPath,
      exclude,
      includeIgnored,
      literal,
      caseSensitive,
      ...(contextLines === undefined ? {} : { contextLines }),
      count: outputLines.length,
      matchCount: matchLines.length,
      matchedFiles,
      truncated: limitedByMaxResults,
      limitedByMaxResults,
      ...(maxResults ? { maxResults } : {}),
      exitCode: result.exitCode,
      ...(extractActivity(parsed) ? { activity: extractActivity(parsed) } : {}),
    },
  };
}

async function hasRootGitignore(workspaceRoot: string) {
  try {
    await stat(resolve(workspaceRoot, ".gitignore"));
    return true;
  } catch {
    return false;
  }
}

async function readRootGitignorePatterns(workspaceRoot: string) {
  try {
    const content = await readFile(resolve(workspaceRoot, ".gitignore"), "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
      .map((line) => {
        const unanchored = line.replace(/^\//, "");
        return unanchored.endsWith("/") ? `${unanchored}**` : unanchored;
      });
  } catch {
    return [];
  }
}

async function filterRootGitignoredFiles(args: {
  workspaceRoot: string;
  files: string[];
  includeIgnored: boolean;
}) {
  if (args.includeIgnored) return args.files;
  const patterns = await readRootGitignorePatterns(args.workspaceRoot);
  if (patterns.length === 0) return args.files;
  const globs = patterns.map((pattern) => createGlob(pattern));
  return args.files.filter((file) => !globs.some((glob) => glob.match(file)));
}

function scanWorkspaceGlobFiles(args: {
  workspaceRoot: string;
  pattern: string;
  relativeSearchPath: string;
  exclude: string[];
}) {
  const pathPrefix = args.relativeSearchPath === "."
    ? ""
    : `${args.relativeSearchPath.replace(/\/+$/, "")}/`;
  return Array.from(createGlob(args.pattern).scanSync({
    cwd: args.workspaceRoot,
    dot: true,
    onlyFiles: true,
  }))
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean)
    .filter((line) => !line.startsWith(".git/") && !line.startsWith("node_modules/"))
    .filter((line) => !pathPrefix || line === args.relativeSearchPath || line.startsWith(pathPrefix))
    .filter((line) => !args.exclude.some((pattern) => createGlob(pattern).match(line)))
    .sort((left, right) => left.localeCompare(right));
}

function limitSearchOutputByMatches(lines: string[], maxResults?: number) {
  if (!maxResults) return { lines, truncated: false };
  const limited: string[] = [];
  let matches = 0;
  for (const line of lines) {
    if (/:\d+:/.test(line)) {
      if (matches >= maxResults) {
        return { lines: limited, truncated: true };
      }
      matches += 1;
    }
    limited.push(line);
  }
  return { lines: limited, truncated: false };
}

async function scanWorkspaceTextMatches(args: {
  workspaceRoot: string;
  relativeSearchPath: string;
  query: string;
  exclude: string[];
  maxResults?: number;
  literal: boolean;
  caseSensitive: boolean;
  contextLines?: number;
}) {
  const files = scanWorkspaceGlobFiles({
    workspaceRoot: args.workspaceRoot,
    pattern: "**/*",
    relativeSearchPath: args.relativeSearchPath,
    exclude: args.exclude,
  });
  const results: string[] = [];
  const seenContext = new Set<string>();
  let matchCount = 0;
  const literalQuery = args.caseSensitive ? args.query : args.query.toLowerCase();
  const regex = args.literal
    ? undefined
    : new RegExp(args.query, args.caseSensitive ? "" : "i");
  const pushLine = (file: string, lineNumber: number, text: string, isMatch: boolean) => {
    const separator = isMatch ? ":" : "-";
    const key = `${file}:${lineNumber}:${separator}`;
    if (seenContext.has(key)) return;
    seenContext.add(key);
    results.push(`${file}${separator}${lineNumber}${separator}${text}`);
  };
  for (const file of files) {
    let content = "";
    try {
      content = await readFile(resolve(args.workspaceRoot, file), "utf8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const haystack = args.caseSensitive ? line : line.toLowerCase();
      const matched = args.literal
        ? haystack.includes(literalQuery)
        : regex?.test(line) === true;
      if (!matched) continue;
      matchCount += 1;
      const contextLines = args.contextLines ?? 0;
      const start = Math.max(0, index - contextLines);
      const end = Math.min(lines.length - 1, index + contextLines);
      for (let contextIndex = start; contextIndex <= end; contextIndex += 1) {
        pushLine(file, contextIndex + 1, lines[contextIndex] ?? "", contextIndex === index);
      }
      if (args.maxResults && matchCount >= args.maxResults) {
        return {
          lines: results,
          limitedByMaxResults: true,
        };
      }
    }
  }
  return {
    lines: results,
    limitedByMaxResults: false,
  };
}

async function globFilesTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const pattern = requireWorkspaceGlobPattern(parsed);
  const exclude = readWorkspaceExcludeGlobs(parsed);
  const maxResults = readWorkspaceMaxResults(parsed);
  const requestedPath = readWorkspacePathAlias(parsed) ?? ".";
  const includeIgnored = parsed.includeIgnored === true;
  const searchPath = resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
  });
  const relativeSearchPath = normalizeWorkspaceRelativePath({
    workspaceRoot: resolve(args.workspaceRoot),
    targetPath: searchPath,
  });
  const command = [
      "rg",
      "--files",
      "--hidden",
      ...(includeIgnored ? ["--no-ignore"] : []),
      "--glob",
      pattern,
      "--glob",
      "!node_modules",
      "--glob",
      "!.git",
      ...exclude.flatMap((excludePattern) => ["--glob", `!${excludePattern}`]),
      ...(relativeSearchPath === "." ? [] : [relativeSearchPath]),
    ];
  const result = await runWorkspaceCommand({
    workspaceRoot: args.workspaceRoot,
    command,
  });
  const pathPrefix = relativeSearchPath === "." ? "" : `${relativeSearchPath.replace(/\/+$/, "")}/`;
  let files = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean)
    .filter((line) => !pathPrefix || line === relativeSearchPath || line.startsWith(pathPrefix))
    .sort((left, right) => left.localeCompare(right));
  files = await filterRootGitignoredFiles({
    workspaceRoot: args.workspaceRoot,
    files,
    includeIgnored,
  });
  if (files.length === 0 && (includeIgnored || !(await hasRootGitignore(args.workspaceRoot)))) {
    files = scanWorkspaceGlobFiles({
      workspaceRoot: args.workspaceRoot,
      pattern,
      relativeSearchPath,
      exclude,
    });
  }
  const commandLimitedByMaxResults = result.limitedByMaxResults === true;
  const totalCount = commandLimitedByMaxResults ? undefined : files.length;
  const limitedFiles = maxResults ? files.slice(0, maxResults) : files;
  const limitedByMaxResults = commandLimitedByMaxResults || limitedFiles.length < (totalCount ?? limitedFiles.length);
  const activity = extractActivity(parsed);
  return {
    content: limitedFiles.join("\n"),
    metadata: {
      pattern,
      effectivePattern: pathPrefix ? `${pathPrefix}${pattern}` : pattern,
      path: requestedPath,
      searchedPath: relativeSearchPath,
      exclude,
      includeIgnored,
      count: limitedFiles.length,
      ...(totalCount === undefined ? {} : { totalCount }),
      truncated: limitedByMaxResults,
      limitedByMaxResults,
      ...(maxResults ? { maxResults } : {}),
      exitCode: result.exitCode,
      ...(activity ? { activity } : {}),
    },
  };
}

async function resolveVisualStateBaseUrl(args: {
  workspaceRoot: string;
  explicitBaseUrl?: string;
  commandTimeoutMs?: number;
}) {
  if (args.explicitBaseUrl) return args.explicitBaseUrl;
  const statusResult = await runWorkspaceCommand({
    workspaceRoot: args.workspaceRoot,
    command: ["bun", "run", "preview:status"],
    timeoutMs: args.commandTimeoutMs,
  });
  if (statusResult.exitCode !== 0) throw new Error(statusResult.content);
  const status = parseLastJsonObject(statusResult.stdout);
  const localApiOrigin = typeof status?.localApiOrigin === "string" ? status.localApiOrigin : "";
  if (!localApiOrigin) {
    throw new Error("captureVisualState could not read localApiOrigin from preview:status.");
  }
  return localApiOrigin;
}

async function captureVisualStateTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
  commandTimeoutMs?: number;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const captureArgs = readVisualStateCaptureArgs(parsed);
  const baseUrl = await resolveVisualStateBaseUrl({
    workspaceRoot: args.workspaceRoot,
    explicitBaseUrl: captureArgs.baseUrl,
    commandTimeoutMs: args.commandTimeoutMs,
  });
  const extraArgs = [
    "--base",
    baseUrl,
    "--path",
    captureArgs.path,
    "--wait-selector",
    captureArgs.waitSelector,
    ...(captureArgs.scrollSelector ? ["--scroll-selector", captureArgs.scrollSelector] : []),
    ...(captureArgs.focusSelector ? ["--focus-selector", captureArgs.focusSelector] : []),
    ...(captureArgs.expectText ? ["--expect-text", captureArgs.expectText] : []),
    "--screenshot",
    captureArgs.screenshotPath,
    "--metrics",
    captureArgs.metricsPath,
  ];
  const result = await runWorkspacePackageScript({
    workspaceRoot: args.workspaceRoot,
    script: "probe:visual-review",
    extraArgs,
    commandTimeoutMs: args.commandTimeoutMs,
  });
  const metrics = parseLastJsonObject(String(result.metadata?.stdoutTail ?? result.content));
  return {
    content: [
      `pageUrl: ${typeof metrics?.pageUrl === "string" ? metrics.pageUrl : ""}`,
      `screenshotPath: ${captureArgs.screenshotPath}`,
      `metricsPath: ${captureArgs.metricsPath}`,
      `waitSelector: ${captureArgs.waitSelector}`,
      ...(captureArgs.focusSelector ? [`focusSelector: ${captureArgs.focusSelector}`] : []),
      ...(captureArgs.expectText ? [`expectText: ${captureArgs.expectText}`] : []),
      "",
      result.content,
    ].join("\n").trim(),
    metadata: {
      ...result.metadata,
      script: "probe:visual-review",
      args: extraArgs,
      baseUrl,
      path: captureArgs.path,
      waitSelector: captureArgs.waitSelector,
      scrollSelector: captureArgs.scrollSelector,
      focusSelector: captureArgs.focusSelector,
      expectText: captureArgs.expectText,
      screenshotPath: captureArgs.screenshotPath,
      metricsPath: captureArgs.metricsPath,
      ...(metrics ?? {}),
    },
  };
}

async function previewLifecycleTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
  commandTimeoutMs?: number;
  script: "preview:start" | "preview:status" | "preview:stop" | "preview:release";
}): Promise<AgentRuntimeToolResult> {
  const result = await runWorkspacePackageScript({
    workspaceRoot: args.workspaceRoot,
    script: args.script,
    commandTimeoutMs: args.commandTimeoutMs,
  });
  const summary = parseLastJsonObject(String(result.metadata?.stdoutTail ?? result.content)) ?? {};
  return {
    content: [
      typeof summary.previewUrl === "string" ? `previewUrl: ${summary.previewUrl}` : "",
      typeof summary.localApiOrigin === "string" ? `localApiOrigin: ${summary.localApiOrigin}` : "",
      typeof summary.serverDbPath === "string" ? `serverDbPath: ${summary.serverDbPath}` : "",
      "",
      result.content,
    ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n").trim(),
    metadata: {
      ...result.metadata,
      script: args.script,
      ...(summary ?? {}),
    },
  };
}

async function execShellTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
  commandTimeoutMs?: number;
  commandPrefix?: string[];
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const command = requireShellCommand(parsed, args.call.name);
  const result = await runWorkspaceCommand({
    workspaceRoot: args.workspaceRoot,
    command: buildWorkspaceShellCommand({
      toolName: args.call.name,
      command,
      shell: parsed.shell,
    }),
    timeoutMs: args.commandTimeoutMs,
    outputLimit: args.commandOutputLimit,
    commandPrefix: args.commandPrefix,
  });
  const activity = extractActivity(parsed);
  return {
    content: result.content,
    metadata: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ...(activity ? { activity } : {}),
    },
  };
}

export function createLocalWorkspaceToolExecutors(args: LocalWorkspaceToolArgs) {
  return {
    editFile: (call: AgentRuntimeToolCallInput) => editFileTool({
      call,
      workspaceRoot: args.workspaceRoot,
    }),
    globFiles: (call: AgentRuntimeToolCallInput) => globFilesTool({
      call,
      workspaceRoot: args.workspaceRoot,
    }),
    listFiles: (call: AgentRuntimeToolCallInput) => listFilesTool({
      call,
      workspaceRoot: args.workspaceRoot,
    }),
    readFile: (call: AgentRuntimeToolCallInput) => readFileTool({
      call,
      workspaceRoot: args.workspaceRoot,
    }),
    writeFile: (call: AgentRuntimeToolCallInput) => writeFileTool({
      call,
      workspaceRoot: args.workspaceRoot,
    }),
    searchFiles: (call: AgentRuntimeToolCallInput) => searchFilesTool({
      call,
      workspaceRoot: args.workspaceRoot,
    }),
    startPreview: (call: AgentRuntimeToolCallInput) => previewLifecycleTool({
      call,
      workspaceRoot: args.workspaceRoot,
      commandTimeoutMs: args.commandTimeoutMs,
      script: "preview:start",
    }),
    getPreviewStatus: (call: AgentRuntimeToolCallInput) => previewLifecycleTool({
      call,
      workspaceRoot: args.workspaceRoot,
      commandTimeoutMs: args.commandTimeoutMs,
      script: "preview:status",
    }),
    stopPreview: (call: AgentRuntimeToolCallInput) => previewLifecycleTool({
      call,
      workspaceRoot: args.workspaceRoot,
      commandTimeoutMs: args.commandTimeoutMs,
      script: "preview:stop",
    }),
    releasePreview: (call: AgentRuntimeToolCallInput) => previewLifecycleTool({
      call,
      workspaceRoot: args.workspaceRoot,
      commandTimeoutMs: args.commandTimeoutMs,
      script: "preview:release",
    }),
    captureVisualState: (call: AgentRuntimeToolCallInput) => captureVisualStateTool({
      call,
      workspaceRoot: args.workspaceRoot,
      commandTimeoutMs: args.commandTimeoutMs,
    }),
    execShell: (call: AgentRuntimeToolCallInput) => execShellTool({
      call,
      workspaceRoot: args.workspaceRoot,
      commandTimeoutMs: args.commandTimeoutMs,
      commandOutputLimit: args.commandOutputLimit,
      commandPrefix: args.commandPrefix,
    }),
  };
}
