// packages/agent-runtime/localWorkspaceToolDefs.ts
//
// Workspace tool schema 定义 + shell 命令构建 + tool 分发器。
// 从 localWorkspaceTools.ts 提取——纯声明，零 I/O，零副作用。
//
// 这组函数接受 variant 字符串，输出 OpenAI tool schema 对象。
// 执行器（readFileTool / execShellTool / searchFilesTool 等）留在 localWorkspaceTools.ts。

import { resolveExecutableOnPath } from "./runtimeCompat";
import type { AgentRuntimeToolResult } from "./hostAdapter";
import { IMMEDIATE_DETACH_SLEEP_THRESHOLD_SECONDS } from "./shellCommandPolicy";
import { buildExecShellToolDefinition } from "./capabilities/execShellCapability";

export type OpenAiCompatibleTool = Record<string, unknown> & {
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
  "listFiles", "readFile", "writeFile", "editFile",
  "globFiles", "searchFiles", "captureVisualState",
  "execShell", "launchProcess", "listProcesses",
] as const;

const SHELL_TOOL_NAMES = ["execShell", "launchProcess", "listProcesses"] as const;

const WORKSPACE_TOOL_NAME_SET = new Set<string>(WORKSPACE_TOOL_NAMES);
const REMOVED_WORKSPACE_TOOL_NAMES = new Set([
  "gitStatus", "gitDiff", "gitCreateBranch", "gitAdd", "gitCommit", "commitWorkspace",
]);

export { WORKSPACE_TOOL_NAMES, SHELL_TOOL_NAMES, WORKSPACE_TOOL_NAME_SET, REMOVED_WORKSPACE_TOOL_NAMES };

export function tokenizeShellPrefix(command: string) {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s"'|;&<>]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function buildWorkspacePathProperty() {
  return {
    type: "string",
    minLength: 1,
    description:
      "Path relative to the workspace root. Defaults to workspace root when omitted.",
  };
}

function buildListWorkspaceDescription(variant?: ListFilesDescriptionVariant) {
  if (variant === "brief") {
    return "List files and directories inside a workspace directory.";
  }
  if (variant === "workflow") {
    return "List directory overview inside workspace. Then use globFiles for path patterns, searchFiles for text discovery, and readFile for content.";
  }
  if (variant === "antiShell") {
    return "List directory overview inside workspace. Prefer listFiles over shell ls/find commands.";
  }
  return "List files and directories inside a workspace folder. Defaults to shallow overview (depth 1).";
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
    return 'Read a UTF-8 text file inside the workspace. Use lines with a range from searchFiles matches, or lines: "-50" for logs. Read the whole file only when the task needs all content.';
  }
  if (variant === "antiShell") {
    return "Read a UTF-8 text file inside the workspace. Prefer readFile over shell commands (cat/head/tail).";
  }
  return "Read a UTF-8 text file inside the workspace. Use lines for focused range reads after searchFiles to save tokens. A range already delivered earlier for an unchanged file answers with a short notice instead of resending (force:true refetches).";
}

function buildReadWorkspaceParameters(variant?: ReadFileParameterVariant) {
  const path = buildWorkspacePathProperty();
  const lines = {
    type: "string",
    description:
      'Line slice: "40-120" (range, 1-based, inclusive), "120-" (from line to end), "-50" (tail N lines), "50" (head N lines). Omit to read full file.',
  };
  if (variant === "minimal") {
    return {
      type: "object",
      properties: { path },
      required: ["path"],
    };
  }
  // `rich` and the default now agree: the schema declares exactly what the
  // executor accepts. The legacy integer arguments stay readable at runtime
  // for in-flight callers, but are deliberately undeclared so no model picks
  // them up from the schema — see LEGACY_SLICE_ARG_NAMES in localWorkspaceTools.
  const force = {
    type: "boolean",
    description:
      "Refetch even when the requested range was already delivered earlier and the file is unchanged (e.g. after context compaction).",
  };
  return {
    type: "object",
    properties: { path, lines, force },
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
        "Write full UTF-8 file content inside the workspace (new files or whole-file rewrites). Prefer editFile for targeted edits.",
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
        "Replace exact text occurrences in a workspace file. If expected replacement count fails, report the error instead of falling back to a whole-file rewrite.",
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
    return "Search file contents inside workspace. Returns line numbers; use readFile with line ranges for focused reading.";
  }
  if (variant === "antiShell") {
    return "Search text inside workspace files using ripgrep. Prefer searchFiles over shell grep.";
  }
  return "Search file contents inside the workspace using ripgrep. Returns matching lines and line numbers. Prefer globFiles when only finding file paths.";
}

function buildSearchWorkspaceParameters(variant?: SearchFilesParameterVariant) {
  const query = {
    type: "string",
    description: "Search query (regex or literal string).",
  };
  const path = buildWorkspacePathProperty();
  const includeIgnored = {
    type: "boolean",
    description:
      "When true, search gitignored files. Build artifacts (dist/, node_modules, .git) remain excluded.",
  };
  const exclude = {
    type: "array",
    items: { type: "string" },
    description: "Glob patterns to exclude from content search (e.g. ['dist/**', '*.log']).",
  };
  const maxResults = {
    type: "integer",
    description: "Max matching output lines to return.",
  };
  const literal = {
    type: "boolean",
    description: "When true, search query as literal text instead of regex.",
  };
  const caseSensitive = {
    type: "boolean",
    description: "When false, search case-insensitively. Defaults to true.",
  };
  const contextLines = {
    type: "integer",
    description: "Number of surrounding context lines around each match. Defaults to 0.",
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
    return "Find files by glob pattern. Use searchFiles for text inside candidates, and readFile for specific paths.";
  }
  if (variant === "antiShell") {
    return "Find workspace files by path glob. Prefer globFiles over shell find/ls commands.";
  }
  return "Find file paths by glob pattern without reading file contents. Use brace groups (e.g. '**/*.{ts,tsx}') to match multiple patterns in one call.";
}

function buildGlobWorkspaceParameters(variant?: GlobFilesParameterVariant) {
  const pattern = {
    type: "string",
    description: "Glob pattern for files (supports brace groups like '**/*.{ts,tsx}', '**/{package.json,tsconfig*.json}').",
  };
  const path = buildWorkspacePathProperty();
  const includeIgnored = {
    type: "boolean",
    description:
      "When true, include gitignored files (.git and node_modules remain excluded).",
  };
  const maxResults = {
    type: "integer",
    description: "Max file paths to return.",
  };
  const exclude = {
    type: "array",
    items: { type: "string" },
    description: "Glob patterns to exclude from results.",
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
        description: "Alias for pattern, kept for compatibility.",
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
            description: "Optional local app base URL. Defaults to http://127.0.0.1:38123.",
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
  return buildExecShellToolDefinition(toolName);
}

function buildLaunchProcessTool(): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "launchProcess",
      description:
        "Start a long-running background process (dev server, watcher, REPL) and return immediately with {pid, label, status}. Use listProcesses to inspect or stop it.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run in background.",
          },
          label: {
            type: "string",
            description: "Optional friendly label for the process.",
          },
          persist: {
            type: "boolean",
            description:
              "Keep process alive after session/conversation closes. Defaults to false.",
          },
        },
        required: ["command"],
      },
    },
  };
}

function buildListProcessesTool(): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "listProcesses",
      description:
        "List active background processes launched via launchProcess. Returns {pid, label, command, status, startedAt, persist}[].",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  };
}

export function wrapPowerShellCommand(command: string) {
  return [
    "[Console]::InputEncoding=[System.Text.Encoding]::UTF8",
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "$OutputEncoding=[System.Text.Encoding]::UTF8",
    "$PSStyle.OutputRendering='PlainText'",
    command,
  ].join("; ");
}

export function findPowerShellExecutable() {
  return resolveExecutableOnPath("pwsh") || resolveExecutableOnPath("powershell.exe") || resolveExecutableOnPath("powershell");
}

export function buildPowerShellCommand(command: string) {
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

export function buildBashCommand(command: string) {
  const executable = resolveExecutableOnPath("bash") || resolveExecutableOnPath("sh");
  if (!executable) throw new Error("bash/sh is not available on this machine.");
  return [executable, "-lc", command];
}

export function buildWorkspaceShellCommand(args: {
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

export function findWorkspaceShellEscapeToken(command: string): string | null {
  const tokens = tokenizeShellPrefix(command);
  for (const token of tokens) {
    if (
      token === ".." ||
      token.startsWith("../") ||
      token.startsWith("..\\") ||
      token.includes("/../") ||
      token.includes("\\..\\")
    ) {
      return token;
    }
    if (token === "~" || token.startsWith("~/") || token.startsWith("~\\")) {
      return token;
    }
    if (
      token === "/" ||
      token.startsWith("/") ||
      /^[A-Za-z]:[\\/]/.test(token) ||
      token.startsWith("\\\\")
    ) {
      return token;
    }
  }
  return null;
}

export function buildWorkspaceShellEscapeBlockedResult(args: {
  command: string;
  token: string;
}): AgentRuntimeToolResult {
  return {
    content: [
      "workspace_shell_escape_blocked",
      `blockedToken: ${args.token}`,
      `command: ${args.command}`,
      "Use paths relative to the authorized folder only.",
      "exitCode: 126",
    ].join("\n"),
    metadata: {
      exitCode: 126,
      workspaceShellEscapeBlocked: true,
      blockedToken: args.token,
    },
  };
}

export function buildWorkspaceToolDefinition(toolName: string, args?: {
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
  if (toolName === "captureVisualState") return buildCaptureVisualStateTool();
  if (toolName === "execShell") return buildExecShellTool(toolName);
  if (toolName === "launchProcess") return buildLaunchProcessTool();
  if (toolName === "listProcesses") return buildListProcessesTool();
  return null;
}

export function filterDeclaredWorkspaceToolNames(args: {
  toolNames?: string[];
  exposeShellTools: boolean;
}) {
  return (args.toolNames ?? []).filter((toolName) =>
    WORKSPACE_TOOL_NAME_SET.has(toolName) &&
    !REMOVED_WORKSPACE_TOOL_NAMES.has(toolName) &&
    (args.exposeShellTools || !SHELL_TOOL_NAMES.includes(toolName as any))
  );
}
