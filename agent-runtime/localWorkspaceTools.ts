import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync, spawn as spawnChildProcess } from "node:child_process";

import { toErrorMessage } from "../core/errorMessage";
import { isRecord } from "../core/isRecord";
import { asOptionalFiniteNumber } from "../core/optionalNumber";
import { asOptionalPositiveFiniteNumber } from "../core/optionalPositiveNumber";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asRecordOrEmpty } from "../core/recordOrEmpty";
import { asTrimmedNonEmptyStringArray } from "../core/stringArray";
import { asTrimmedString } from "../core/trimmedString";
import type {
  AgentRuntimeToolCallInput,
  AgentRuntimeToolResult,
} from "./hostAdapter";
import type { PermissionRequest } from "./actionGate";
import { createGlob, resolveExecutableOnPath } from "./runtimeCompat";
import { getProcessRegistry } from "./processRegistry";

type LocalWorkspaceToolArgs = {
  workspaceRoot: string;
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  commandPrefix?: string[];
  restrictShellToWorkspace?: boolean;
  /**
   * Optional confirmation callback for file tools that resolve to a path
   * OUTSIDE the workspace root (e.g. a macOS screenshot under /var/folders).
   *
   * When provided (interactive TUI), an external-path read/edit/write/glob/
   * list/search triggers this callback BEFORE execution; the action runs only
   * if it returns true. When absent (non-interactive CLI / machine dispatch),
   * external paths are ALLOWED to proceed — hard-blocking them with no
   * confirmation channel only stalls the agent turn while the model retries
   * the same path. This mirrors the destructive-shell guard's contract.
   *
   * Reuses the PermissionRequest shape; the confirm dialog renders title,
   * body and command (the exact external path) verbatim.
   */
  confirmExternalFileAccess?: (request: PermissionRequest) => Promise<boolean>;
};

const EXEC_SHELL_TIMEOUT_ENV = "NOLO_EXEC_SHELL_TIMEOUT_MS";
const DEFAULT_LOCAL_API_ORIGIN = "http://127.0.0.1:38123";

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

import {
  type OpenAiCompatibleTool,
  type GlobFilesDescriptionVariant,
  type GlobFilesParameterVariant,
  type SearchFilesDescriptionVariant,
  type SearchFilesParameterVariant,
  type ReadFileDescriptionVariant,
  type ReadFileParameterVariant,
  type ListFilesDescriptionVariant,
  type ListFilesParameterVariant,
  WORKSPACE_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  WORKSPACE_TOOL_NAME_SET,
  REMOVED_WORKSPACE_TOOL_NAMES,
  tokenizeShellPrefix,
  buildWorkspaceShellCommand,
  findWorkspaceShellEscapeToken,
  buildWorkspaceShellEscapeBlockedResult,
  buildWorkspaceToolDefinition,
  filterDeclaredWorkspaceToolNames,
} from "./localWorkspaceToolDefs";

const DEFAULT_LOCAL_CODING_TOOL_NAMES = [
  "listFiles",
  "readFile",
  "writeFile",
  "editFile",
  "globFiles",
  "searchFiles",
] as const;

function readTrimmedString(value: unknown): string | undefined {
  return asOptionalTrimmedString(value);
}

function resolveExecShellTimeoutMs(override: number | undefined) {
  const fromOverride = asOptionalPositiveFiniteNumber(override);
  if (fromOverride !== undefined) return fromOverride;
  const raw = process.env[EXEC_SHELL_TIMEOUT_ENV];
  if (raw === undefined) return undefined;
  return asOptionalPositiveFiniteNumber(Number(raw));
}


function extractInteractiveGhAuthCommand(command: string): string | null {
  const tokens = tokenizeShellPrefix(command);
  if (tokens[0] !== "gh" || tokens[1] !== "auth") return null;
  const subcommand = tokens[2];
  if (subcommand !== "login" && subcommand !== "refresh") return null;
  if (tokens.includes("--help")) return null;

  const result = ["gh", "auth", subcommand];
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "-h" || token === "--hostname" || token === "-s" || token === "--scopes" || token === "--remove-scopes" || token === "-r") {
      const value = tokens[index + 1];
      if (value) {
        result.push(token, value);
        index += 1;
      }
      continue;
    }
    if (token === "--clipboard" || token === "-c" || token === "--insecure-storage" || token === "--reset-scopes") {
      result.push(token);
      continue;
    }
    if (token.startsWith("--hostname=") || token.startsWith("--scopes=") || token.startsWith("--remove-scopes=")) {
      result.push(token);
      continue;
    }
  }
  return result.join(" ");
}

function splitShellWords(command: string): string[] {
  return tokenizeShellPrefix(command);
}

function buildInteractiveCommandBlockedResult(command: string): AgentRuntimeToolResult {
  const argv = splitShellWords(command);
  return {
    content: [
      "action_gate: handoff",
      `command: ${command}`,
      "Run this in the current TUI terminal, then resume the agent turn.",
      "exitCode: 130",
    ].join("\n"),
    metadata: {
      exitCode: 130,
      timedOut: false,
      actionGate: {
        id: `gate-${Date.now().toString(36)}-terminal-handoff`,
        kind: "handoff",
        title: "This command requires an interactive terminal.",
        body: "Complete it in the terminal, then nolo will continue.",
        payload: {
          command: argv,
          displayCommand: command,
        },
      },
      reason: "interactive-command-requires-terminal",
    },
  };
}

function extractActivityRefs(rawRefs: unknown): ActivityRef[] | undefined {
  if (!Array.isArray(rawRefs)) return undefined;
  const refs = rawRefs.flatMap((entry): ActivityRef[] => {
    if (!isRecord(entry)) return [];
    if (entry.type === "file") {
      const path = readTrimmedString(entry.path);
      return path ? [{ type: "file", path }] : [];
    }
    if (entry.type === "terminal") {
      const id = readTrimmedString(entry.id);
      const label = readTrimmedString(entry.label);
      return id || label
        ? [{ type: "terminal", ...(id ? { id } : {}), ...(label ? { label } : {}) }]
        : [];
    }
    if (entry.type === "url") {
      const url = readTrimmedString(entry.url);
      const label = readTrimmedString(entry.label);
      return url ? [{ type: "url", url, ...(label ? { label } : {}) }] : [];
    }
    return [];
  });
  return refs.length ? refs : undefined;
}

function extractActivityAction(rawAction: unknown): ToolActivityAction | undefined {
  if (!isRecord(rawAction)) return undefined;
  const title = readTrimmedString(rawAction.title);
  if (!title) return undefined;
  const kind = readTrimmedString(rawAction.kind);
  const detail = readTrimmedString(rawAction.detail);
  const refs = extractActivityRefs(rawAction.refs);
  return {
    title,
    ...(kind ? { kind } : {}),
    ...(detail ? { detail } : {}),
    ...(refs ? { refs } : {}),
  };
}

function extractActivityPhase(rawPhase: unknown): ToolActivityPhase | undefined {
  if (!isRecord(rawPhase)) return undefined;
  const title = readTrimmedString(rawPhase.title);
  if (!title) return undefined;
  const id = readTrimmedString(rawPhase.id) || title.toLowerCase().replace(/\s+/g, "-");
  const index = asOptionalFiniteNumber(rawPhase.index);
  const total = asOptionalFiniteNumber(rawPhase.total);
  const status =
    rawPhase.status === "pending" ||
    rawPhase.status === "running" ||
    rawPhase.status === "success" ||
    rawPhase.status === "failed"
      ? rawPhase.status
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
  if (!isRecord(rawPlan)) return undefined;
  if (!Array.isArray(rawPlan.phases)) return undefined;
  const phases = rawPlan.phases.flatMap((entry, index): ActivityPlan["phases"] => {
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
  const title = readTrimmedString(rawPlan.title);
  return {
    ...(title ? { title } : {}),
    phases,
  };
}

function extractActivity(parsed: WorkspaceFileArgs): ToolActivity | undefined {
  const raw = parsed._activity;
  if (!isRecord(raw)) return undefined;
  const nestedAction = extractActivityAction(raw.action);
  const legacyAction = extractActivityAction(raw);
  const action = nestedAction || legacyAction;
  const phase = extractActivityPhase(raw.phase);
  const plan = extractActivityPlan(raw.plan);
  if (!action && !plan) return undefined;
  return {
    ...(action ? action : {}),
    ...(phase ? { phase } : {}),
    ...(nestedAction ? { action: nestedAction } : {}),
    ...(plan ? { plan } : {}),
  };
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
      if (!args.exposeShellTools && SHELL_TOOL_NAMES.includes(toolName as any)) {
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
    return asRecordOrEmpty(JSON.parse(raw || "{}") as unknown) as WorkspaceFileArgs;
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
  return asOptionalTrimmedString(path);
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

/**
 * Clip an editFile oldText/newText payload into a short preview snippet for the
 * TUI trace. Keeps the first EDIT_SNIPPET_MAX_LINES non-empty lines, each
 * capped at EDIT_SNIPPET_WIDTH chars, so the user can see what actually changed
 * without the full (potentially huge) text flooding the trace.
 */
const EDIT_SNIPPET_MAX_LINES = 5;
const EDIT_SNIPPET_WIDTH = 96;

function clipEditSnippet(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  return lines
    .slice(0, EDIT_SNIPPET_MAX_LINES)
    .map((line) => (line.length > EDIT_SNIPPET_WIDTH ? `${line.slice(0, EDIT_SNIPPET_WIDTH)}…` : line))
    .join("\n");
}

function requireWorkspaceSearchQuery(args: WorkspaceFileArgs) {
  const query = asTrimmedString(args.query);
  if (!query) throw new Error("searchFiles requires a non-empty query.");
  return query;
}

function requireWorkspaceGlobPattern(args: WorkspaceFileArgs) {
  const pattern =
    asOptionalTrimmedString(args.pattern) ??
    asOptionalTrimmedString(args.glob) ??
    "";
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
  const singleExclude = asOptionalTrimmedString(args.exclude);
  if (singleExclude) {
    return [singleExclude];
  }
  if (!Array.isArray(args.exclude)) {
    throw new Error("exclude must be a glob string or an array of glob strings.");
  }
  return asTrimmedNonEmptyStringArray(args.exclude);
}

function requireShellCommand(args: WorkspaceFileArgs, toolName: string) {
  const command = asTrimmedString(args.cmd) || asTrimmedString(args.command);
  if (!command) throw new Error(`${toolName} requires a non-empty command.`);
  return command;
}

function requireVisualWaitSelector(args: WorkspaceFileArgs) {
  const selector = asTrimmedString(args.waitSelector);
  if (!selector) throw new Error("captureVisualState requires a non-empty waitSelector.");
  return selector;
}

function readVisualStateCaptureArgs(args: WorkspaceFileArgs) {
  const baseUrl = asOptionalTrimmedString(args.baseUrl) ?? asOptionalTrimmedString(args.base);
  const path = asOptionalTrimmedString(args.path) ?? "/";
  const waitSelector = requireVisualWaitSelector(args);
  const scrollSelector = asOptionalTrimmedString(args.scrollSelector);
  const focusSelector = asOptionalTrimmedString(args.focusSelector);
  const expectText = asOptionalTrimmedString(args.expectText);
  const screenshotPath =
    asOptionalTrimmedString(args.screenshotPath) ?? "test-results/frontend-agent/visual-state.png";
  const metricsPath =
    asOptionalTrimmedString(args.metricsPath) ?? "test-results/frontend-agent/visual-state-metrics.json";
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
      error: toErrorMessage(error),
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

/**
 * Prefer Desktop-bundled ripgrep (NOLO_BUNDLED_RG / Resources/bin), then PATH +
 * common install locations. Users do not need a system `rg` install.
 */
export function resolveRipgrepBinary(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fromEnv = asOptionalTrimmedString(env.NOLO_BUNDLED_RG);
  if (fromEnv) {
    try {
      if (existsSync(fromEnv)) return fromEnv;
    } catch {
      // ignore
    }
  }
  return resolveExecutableOnPath("rg");
}

async function runWorkspaceCommand(args: {
  workspaceRoot: string;
  command: string[];
  stdin?: string;
  timeoutMs?: number;
  outputLimit?: number;
  commandPrefix?: string[];
}) {
  const timeoutMs = asOptionalPositiveFiniteNumber(args.timeoutMs);
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
  // detached spawns a new process group so timeout cleanup can kill the whole
  // tree (parent shell + its children). The cost is that a SIGHUP/SIGTERM sent
  // only to this process no longer reaches the child — so if the TUI/CLI host
  // is killed mid-execShell, the child keeps running. Re-bridge that gap: while
  // a detached child is live, forward the host's SIGHUP/SIGTERM/SIGINT to its
  // process group, and detach the handlers once the child settles (exits,
  // errors, or is killed). SIGHUP is the main target (terminal close, no
  // competing host handler); SIGINT may also fire alongside a TUI/readline
  // SIGINT handler on Ctrl-C — that is benign, the ESRCH guard handles a
  // double-kill of an already-dead child.
  const cleanupChildOnHostSignal = (signal: NodeJS.Signals) => {
    if (typeof proc.pid === "number") {
      try { process.kill(-proc.pid, signal); } catch { /* already exited */ }
    }
  };
  if (detached) {
    process.once("SIGHUP", cleanupChildOnHostSignal);
    process.once("SIGTERM", cleanupChildOnHostSignal);
    process.once("SIGINT", cleanupChildOnHostSignal);
  }
  const detachSignalCleanup = () => {
    if (!detached) return;
    process.removeListener("SIGHUP", cleanupChildOnHostSignal);
    process.removeListener("SIGTERM", cleanupChildOnHostSignal);
    process.removeListener("SIGINT", cleanupChildOnHostSignal);
  };
  exitPromise.then(detachSignalCleanup, detachSignalCleanup);
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
  // Settle exit immediately so spawn "Executable not found" cannot become an
  // unhandledRejection while we are still reading stdout (crashed desktop before).
  const exitSettled = waitForNodeProcessExit(proc).then(
    (code) => ({ ok: true as const, code }),
    (error) => ({ ok: false as const, error }),
  );
  const stderrPromise = readNodeStream(proc.stderr);
  const lines: string[] = [];
  let pending = "";
  let limitedByMaxResults = false;
  try {
    await Promise.race([
      new Promise<void>((resolveRead, rejectRead) => {
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
        // No stdout pipe (spawn failed early) — wait for exit settlement.
        if (!proc.stdout) {
          void exitSettled.then((result) => {
            if (!result.ok) rejectRead(result.error);
            else resolveRead();
          });
        }
      }),
      exitSettled.then((result) => {
        if (!result.ok) throw result.error;
      }),
    ]);
  } catch (error) {
    const settled = await exitSettled;
    if (!settled.ok) throw settled.error;
    throw error;
  }
  if (!limitedByMaxResults && pending.trim()) lines.push(pending);
  const settled = await exitSettled;
  if (!settled.ok) throw settled.error;
  const exitCode = limitedByMaxResults ? 0 : settled.code;
  const stderr = await stderrPromise;
  return {
    stdout: lines.slice(0, args.maxLines).join("\n"),
    stderr,
    exitCode,
    limitedByMaxResults,
  };
}

export async function resolveLocalWorkspaceToolPath(args: {
  workspaceRoot: string;
  requestedPath: string;
  confirmExternalFileAccess?: (request: PermissionRequest) => Promise<boolean>;
}) {
  const workspaceRoot = resolve(args.workspaceRoot);
  const targetPath = resolve(workspaceRoot, args.requestedPath);
  if (!isPathInsideWorkspace({ workspaceRoot, targetPath })) {
    // External path: ask the user once via the confirmation gate (when an
    // interactive channel is available). Without a confirmation callback
    // (non-interactive CLI / machine dispatch) we ALLOW the access — hard
    // blocking here with no prompt only stalls the turn while the model
    // retries the same path. Same contract as the destructive-shell guard.
    if (args.confirmExternalFileAccess) {
      const request: PermissionRequest = {
        id: "permission-file-external-access",
        tool: "fileTool",
        action: "external_file_access",
        title: "确认读取工作区外部文件",
        body: "该路径位于当前工作区之外。确认后本次访问放行，否则拒绝。",
        command: args.requestedPath,
        suggestedRule: {
          scope: "once",
          pattern: { capability: "external_file_access", target: args.requestedPath },
        },
      };
      const confirmed = await args.confirmExternalFileAccess(request);
      if (!confirmed) {
        const error = new Error(
          `external file access blocked: user declined confirmation for ${args.requestedPath}`,
        ) as Error & { code?: string; permissionRequest?: PermissionRequest };
        error.code = "external_file_access_requires_confirmation";
        error.permissionRequest = request;
        throw error;
      }
    }
  }
  return targetPath;
}

async function readFileTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
  confirmExternalFileAccess?: (request: PermissionRequest) => Promise<boolean>;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const requestedPath = requireWorkspaceToolPath(parsed);
  const sliceArgs = readFileSliceArgs(parsed);
  const absolutePath = await resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
    ...(args.confirmExternalFileAccess
      ? { confirmExternalFileAccess: args.confirmExternalFileAccess }
      : {}),
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
  confirmExternalFileAccess?: (request: PermissionRequest) => Promise<boolean>;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const requestedPath = requireWorkspaceToolPath(parsed);
  const content = requireWorkspaceFileContent(parsed);
  const absolutePath = await resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
    ...(args.confirmExternalFileAccess
      ? { confirmExternalFileAccess: args.confirmExternalFileAccess }
      : {}),
  });
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  const relativePath = normalizeWorkspaceRelativePath({
    workspaceRoot: resolve(args.workspaceRoot),
    targetPath: absolutePath,
  });
  const activity = extractActivity(parsed);

  // Optional: run git diff --stat for a quick summary of what changed.
  let diffStat: string | undefined;
  try {
    const stats: string[] = [];
  for (const ref of ["", "--cached"]) {
    const result = spawnSync("git", ["diff", ref, "--stat", "--", relativePath], {
      cwd: args.workspaceRoot,
      timeout: 3000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = (result.stdout ?? "").trim();
    if (out) stats.push(out);
  }
    if (stats.length > 0) diffStat = stats.join("; ");
  } catch (err: unknown) {
    diffStat = `[git diff unavailable: ${toErrorMessage(err)}]`;
  }

  return {
    content: `wrote ${relativePath}`,
    metadata: {
      path: relativePath,
      bytes: Buffer.byteLength(content),
      ...(diffStat ? { diffStat } : {}),
      ...(activity ? { activity } : {}),
    },
  };
}

async function editFileTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
  confirmExternalFileAccess?: (request: PermissionRequest) => Promise<boolean>;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const requestedPath = requireWorkspaceToolPath(parsed);
  const oldText = requireWorkspaceOldText(parsed);
  const newText = requireWorkspaceNewText(parsed);
  const expectedReplacements = readExpectedReplacementCount(parsed);
  const absolutePath = await resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
    ...(args.confirmExternalFileAccess
      ? { confirmExternalFileAccess: args.confirmExternalFileAccess }
      : {}),
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
      oldSnippet: clipEditSnippet(oldText),
      newSnippet: clipEditSnippet(newText),
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
  confirmExternalFileAccess?: (request: PermissionRequest) => Promise<boolean>;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const requestedPath = readWorkspacePathAlias(parsed) ?? ".";
  const maxDepth = readWorkspaceMaxDepth(parsed);
  const maxResults = readWorkspaceMaxResults(parsed);
  const entryType = readWorkspaceEntryType(parsed);
  const dirPath = await resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
    ...(args.confirmExternalFileAccess
      ? { confirmExternalFileAccess: args.confirmExternalFileAccess }
      : {}),
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
  confirmExternalFileAccess?: (request: PermissionRequest) => Promise<boolean>;
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
  const searchPath = await resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
    ...(args.confirmExternalFileAccess
      ? { confirmExternalFileAccess: args.confirmExternalFileAccess }
      : {}),
  });
  const relativeSearchPath = normalizeWorkspaceRelativePath({
    workspaceRoot: resolve(args.workspaceRoot),
    targetPath: searchPath,
  });
  const rgBinary = resolveRipgrepBinary();
  const grepBinary = resolveExecutableOnPath("grep") || "grep";
  const rgCommand = rgBinary
    ? [
        rgBinary,
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
      ]
    : null;
  const grepCommand = [
    grepBinary,
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
    if (rgCommand) {
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
        // Fall through to grep / scanWorkspaceTextMatches.
      }
    }
    try {
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
    } catch {
      // Final path: pure JS scan below when both binaries fail.
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        limitedByMaxResults: false,
      };
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
  confirmExternalFileAccess?: (request: PermissionRequest) => Promise<boolean>;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const pattern = requireWorkspaceGlobPattern(parsed);
  const exclude = readWorkspaceExcludeGlobs(parsed);
  const maxResults = readWorkspaceMaxResults(parsed);
  const requestedPath = readWorkspacePathAlias(parsed) ?? ".";
  const includeIgnored = parsed.includeIgnored === true;
  const searchPath = await resolveLocalWorkspaceToolPath({
    workspaceRoot: args.workspaceRoot,
    requestedPath,
    ...(args.confirmExternalFileAccess
      ? { confirmExternalFileAccess: args.confirmExternalFileAccess }
      : {}),
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
  const commandLimitedByMaxResults = false;
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
  explicitBaseUrl?: string;
}) {
  if (args.explicitBaseUrl) return args.explicitBaseUrl;
  return DEFAULT_LOCAL_API_ORIGIN;
}

async function captureVisualStateTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
  commandTimeoutMs?: number;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const captureArgs = readVisualStateCaptureArgs(parsed);
  const baseUrl = await resolveVisualStateBaseUrl({
    explicitBaseUrl: captureArgs.baseUrl,
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

async function execShellTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  commandPrefix?: string[];
  restrictToWorkspace?: boolean;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const command = requireShellCommand(parsed, args.call.name);
  if (args.restrictToWorkspace) {
    // ponytail: lexical guard for desktop folder execShell; replace with OS sandbox if users need arbitrary shell syntax.
    const escapeToken = findWorkspaceShellEscapeToken(command);
    if (escapeToken) {
      return buildWorkspaceShellEscapeBlockedResult({ command, token: escapeToken });
    }
  }
  const interactiveAuthCommand = extractInteractiveGhAuthCommand(command);
  if (interactiveAuthCommand) {
    const activity = extractActivity(parsed);
    const blocked = buildInteractiveCommandBlockedResult(interactiveAuthCommand);
    return {
      ...blocked,
      metadata: {
        ...blocked.metadata,
        ...(activity ? { activity } : {}),
      },
    };
  }
  const result = await runWorkspaceCommand({
    workspaceRoot: args.workspaceRoot,
    command: buildWorkspaceShellCommand({
      toolName: args.call.name,
      command,
      shell: parsed.shell,
    }),
    timeoutMs: resolveExecShellTimeoutMs(args.commandTimeoutMs),
    outputLimit: args.commandOutputLimit,
    commandPrefix: args.commandPrefix,
  });
  const activity = extractActivity(parsed);
  return {
    content: result.content,
    metadata: {
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      ...(activity ? { activity } : {}),
    },
  };
}

function deriveLabel(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "process";
  const tokens = trimmed.split(/\s+/);
  const lastToken = tokens[tokens.length - 1] ?? trimmed;
  // If lastToken is something like "desktop:dev" or "dev", use it; remove path prefix if any
  const labelCandidate = lastToken.split(/[/\\]/).pop() || lastToken;
  return labelCandidate || trimmed;
}

async function launchProcessTool(args: {
  call: AgentRuntimeToolCallInput;
  workspaceRoot: string;
  commandPrefix?: string[];
  restrictToWorkspace?: boolean;
}): Promise<AgentRuntimeToolResult> {
  const parsed = parseWorkspaceToolArguments(args.call.arguments);
  const command = requireShellCommand(parsed, args.call.name);
  if (args.restrictToWorkspace) {
    const escapeToken = findWorkspaceShellEscapeToken(command);
    if (escapeToken) {
      return buildWorkspaceShellEscapeBlockedResult({ command, token: escapeToken });
    }
  }

  const labelArg = readTrimmedString((parsed as Record<string, unknown>).label);
  const label = labelArg || deriveLabel(command);

  const fullCommand = buildWorkspaceShellCommand({
    toolName: args.call.name,
    command,
    shell: parsed.shell,
  });

  const cmdArgs = [
    ...(args.commandPrefix ?? []),
    ...fullCommand,
  ];

  const detached = process.platform !== "win32";
  const proc = spawnChildProcess(cmdArgs[0] ?? "", cmdArgs.slice(1), {
    cwd: resolve(args.workspaceRoot),
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });

  const pid = proc.pid;
  if (typeof pid !== "number") {
    return {
      content: JSON.stringify({ error: "Failed to spawn child process" }),
      metadata: { command, status: "failed" },
    };
  }

  const pgid = detached ? pid : pid;
  const registry = getProcessRegistry();
  registry.add({ pid, pgid, command, label });

  const cleanupChildOnHostSignal = (signal: NodeJS.Signals) => {
    try {
      if (detached) {
        process.kill(-pid, signal);
      } else {
        process.kill(pid, signal);
      }
    } catch {
      // already exited
    }
  };

  if (detached) {
    process.once("SIGHUP", cleanupChildOnHostSignal);
    process.once("SIGTERM", cleanupChildOnHostSignal);
    process.once("SIGINT", cleanupChildOnHostSignal);
  }

  proc.on("close", (code) => {
    if (detached) {
      process.removeListener("SIGHUP", cleanupChildOnHostSignal);
      process.removeListener("SIGTERM", cleanupChildOnHostSignal);
      process.removeListener("SIGINT", cleanupChildOnHostSignal);
    }
    registry.markExited(pid, code ?? 1);
  });

  const activity = extractActivity(parsed);
  const resultData = { pid, label, status: "running" as const };

  return {
    content: JSON.stringify(resultData),
    metadata: {
      command,
      pid,
      label,
      status: "running",
      processLaunch: resultData,
      ...(activity ? { activity } : {}),
    },
  };
}

async function listProcessesTool(args: {
  call: AgentRuntimeToolCallInput;
}): Promise<AgentRuntimeToolResult> {
  const list = getProcessRegistry().list();
  return {
    content: JSON.stringify(list),
    metadata: {
      count: list.length,
      processes: list,
    },
  };
}

export function createLocalWorkspaceToolExecutors(args: LocalWorkspaceToolArgs) {
  const fileAccess = args.confirmExternalFileAccess
    ? { confirmExternalFileAccess: args.confirmExternalFileAccess }
    : {};
  return {
    editFile: (call: AgentRuntimeToolCallInput) => editFileTool({
      call,
      workspaceRoot: args.workspaceRoot,
      ...fileAccess,
    }),
    globFiles: (call: AgentRuntimeToolCallInput) => globFilesTool({
      call,
      workspaceRoot: args.workspaceRoot,
      ...fileAccess,
    }),
    listFiles: (call: AgentRuntimeToolCallInput) => listFilesTool({
      call,
      workspaceRoot: args.workspaceRoot,
      ...fileAccess,
    }),
    readFile: (call: AgentRuntimeToolCallInput) => readFileTool({
      call,
      workspaceRoot: args.workspaceRoot,
      ...fileAccess,
    }),
    writeFile: (call: AgentRuntimeToolCallInput) => writeFileTool({
      call,
      workspaceRoot: args.workspaceRoot,
      ...fileAccess,
    }),
    searchFiles: (call: AgentRuntimeToolCallInput) => searchFilesTool({
      call,
      workspaceRoot: args.workspaceRoot,
      ...fileAccess,
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
      restrictToWorkspace: args.restrictShellToWorkspace,
    }),
    launchProcess: (call: AgentRuntimeToolCallInput) => launchProcessTool({
      call,
      workspaceRoot: args.workspaceRoot,
      commandPrefix: args.commandPrefix,
      restrictToWorkspace: args.restrictShellToWorkspace,
    }),
    listProcesses: (call: AgentRuntimeToolCallInput) => listProcessesTool({
      call,
    }),
  };
}
