// packages/agent-runtime/localWorkspaceToolDefs.ts
//
// Workspace tool schema 定义 + shell 命令构建 + tool 分发器。
// 从 localWorkspaceTools.ts 提取——纯声明，零 I/O，零副作用。
//
// 这组函数接受 variant 字符串，输出 OpenAI tool schema 对象。
// 执行器（readFileTool / execShellTool / searchFilesTool 等）留在 localWorkspaceTools.ts。

import { resolveExecutableOnPath } from "./runtimeCompat";
import type { AgentRuntimeToolResult } from "./hostAdapter";

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
    return 'Read a UTF-8 text file inside the workspace after listFiles, globFiles, or searchFiles has narrowed the target. Use lines with a range from searchFiles matches, or lines: "-50" for logs and generated output. Read the whole file only when the task truly needs all content or exact edit context.';
  }
  if (variant === "antiShell") {
    return "Read a UTF-8 text file inside the workspace. Do not use execShell with cat/sed/head/tail for normal text reads when readFile can return the needed file or line range. Use searchFiles first for content search, then readFile only the relevant lines when possible.";
  }
  return 'Read a UTF-8 text file inside the workspace. Read before editing when you need exact text for editFile. For discovery or classification tasks, avoid batch-reading every candidate; report candidate paths first, or read only one to three representative files with a small lines count. Use lines ranges for large code, docs, data, configs, and logs after searchFiles returns line numbers. Read the whole file only when the task truly needs all content or exact edit context.';
}

function buildReadWorkspaceParameters(variant?: ReadFileParameterVariant) {
  const path = buildWorkspacePathProperty();
  // One argument for one concept. startLine/endLine/maxLines/tailLines were
  // four orthogonal integers describing a single line range, so most of their
  // combinations were invalid and had to be caught by runtime rules the model
  // could not see (tailLines excluding the others, endLine >= startLine).
  // A slice string has no invalid combinations — only invalid syntax, which
  // one example in this description prevents.
  const lines = {
    type: "string",
    description:
      'Which lines to return: "40-120" for a range (1-based, inclusive), "120-" from a line to the end, "-50" for the last N lines (logs, generated output), "50" for the first N. Omit to read the whole file. Use a range after searchFiles gives a line number, and a small count to preview candidates instead of reading many whole files. When the user gives a read/preview budget, each readFile preview consumes one budget slot.',
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
  return {
    type: "object",
    properties: { path, lines },
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
      "When true, search files ignored by .gitignore such as .tmp. Defaults to false. Build artifacts (dist/, *.tsbuildinfo, *.min.js, etc.) are always excluded regardless of this flag. .git and node_modules remain excluded.",
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
  return {
    type: "function",
    function: {
      name: toolName,
      description:
        "Run a shell command in the local workspace. Commands already execute from the workspace root; do not cd into guessed paths such as /workspace, /repo, /home/user, or /home/user/workspace. Prefer one command that performs a complete verification or related git operation instead of many tiny commands. For branch setup, prefer idempotent commands such as git switch -C <branch> when replacing or recreating a benchmark branch is acceptable. Use portable POSIX commands for macOS/BSD shells; avoid GNU-only flags such as cat -A. Do not use cat -A. Do not use brittle byte-offset commands such as xxd -s -32. For separator lines, use echo or printf '%s\\n'. For text-file content or trailing-newline checks, prefer readFile over shell byte inspection when that tool is available. Do not run repeated git status, git log, git rev-parse, or branch checks after a successful command already returned the needed clean status and commit information; use one final verification command. If a command fails, use the error output to adjust the next command rather than repeating the same shape. For long-running commands that should keep running in the background (dev servers, watchers, REPLs, \`--watch\`/\`serve\`/\`dev\` scripts), prefer launchProcess. Obviously long-running commands run via execShell (sleep over 5s, tail -f, watch, infinite loops, dev/serve/watch scripts) are moved to the background automatically and return {detached: true, pid, label} — use listProcesses to inspect or stop them, and tell the user the command is running in the background. Any other command blocks until it exits, so keep those short.",
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

function buildLaunchProcessTool(): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: "launchProcess",
      description:
        "Launch a long-running process (dev server, watcher, REPL) in the background and return immediately without blocking the conversation. Use this instead of execShell for commands that do not exit on their own. Returns {pid, label, status:'running'}. The process keeps running after the tool returns; use listProcesses to check status or the host UI (/procs, /stop) to stop it.",
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
        "List currently registered background processes launched via launchProcess. Returns array of {pid, label, command, status, startedAt}.",
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
