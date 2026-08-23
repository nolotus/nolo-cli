import type { AgentRuntimeToolResult } from "../hostAdapter";
import type { PermissionRequest } from "../actionGate";
import {
  IMMEDIATE_DETACH_SLEEP_THRESHOLD_SECONDS,
  isImmediateDetachShellCommand,
  resolveShellCommandArg,
} from "../shellCommandPolicy";
import {
  buildWorkspaceShellCommand,
  findWorkspaceShellEscapeToken,
  buildWorkspaceShellEscapeBlockedResult,
  extractActivity,
  extractInteractiveGhAuthCommand,
  buildInteractiveCommandBlockedResult,
  resolveExecShellTimeoutMs,
  runWorkspaceCommand,
} from "../workspaceShell";
import type { CapabilityExecutionContext, ExecutableCapability, OpenAiCompatibleTool } from "./capability";


// Small, policy-free context builder: maps the local runtime's real execShell
// settings into the CapabilityExecutionContext fields that execShellCapability
// (and therefore PTC tools.execShell) reads. Used so PTC execShell is never
// more permissive than normal local tool calling — both share the same builder
// and the same execShellCapability path.
export type LocalExecShellContextArgs = {
  workspaceRoot: string;
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  commandPrefix?: string[];
  restrictToWorkspace?: boolean;
  abortSignal?: AbortSignal;
  detachMs?: number;
  confirmed?: boolean;
  enableDestructiveShellGuard?: boolean;
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  blockDestructiveWithoutConfirmation?: boolean;
  onInvoke?: (capability: string, input: unknown) => void | Promise<void>;
};

export function buildLocalExecShellContext(
  args: LocalExecShellContextArgs,
): CapabilityExecutionContext {
  return {
    workspaceRoot: args.workspaceRoot,
    ...(args.commandTimeoutMs !== undefined ? { commandTimeoutMs: args.commandTimeoutMs } : {}),
    ...(args.commandOutputLimit !== undefined ? { commandOutputLimit: args.commandOutputLimit } : {}),
    ...(args.commandPrefix ? { commandPrefix: args.commandPrefix } : {}),
    ...(args.restrictToWorkspace !== undefined ? { restrictToWorkspace: args.restrictToWorkspace } : {}),
    ...(args.abortSignal ? { abortSignal: args.abortSignal } : {}),
    ...(args.detachMs !== undefined ? { detachMs: args.detachMs } : {}),
    ...(args.confirmed !== undefined ? { confirmed: args.confirmed } : {}),
    ...(args.enableDestructiveShellGuard !== undefined ? { enableDestructiveShellGuard: args.enableDestructiveShellGuard } : {}),
    ...(args.confirmDestructiveAction ? { confirmDestructiveAction: args.confirmDestructiveAction } : {}),
    ...(args.blockDestructiveWithoutConfirmation !== undefined
      ? { blockDestructiveWithoutConfirmation: args.blockDestructiveWithoutConfirmation }
      : {}),
    ...(args.onInvoke ? { onInvoke: args.onInvoke } : {}),
  };
}

export interface ExecShellInput {
  command: string;
  shell?: unknown;
  activity?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

export function buildExecShellToolDefinition(toolName = "execShell"): OpenAiCompatibleTool {
  return {
    type: "function",
    function: {
      name: toolName,
      description:
        `Execute a shell command from the workspace root. Prefer one compound command (e.g. 'git status && git diff --stat') to perform complete verification in one step instead of multiple small roundtrips. Do not cd into guessed paths; commands already run from the workspace root. Commands block until exit. Long-running commands (sleep over ${IMMEDIATE_DETACH_SLEEP_THRESHOLD_SECONDS}s, dev servers, watchers) automatically detach to background returning {detached: true, pid, label}; for persistent services, prefer launchProcess.`,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run (non-empty).",
          },
          cmd: {
            type: "string",
            description: "Compatibility alias for command.",
          },
        },
      },
    },
  };
}

export function normalizeExecShellInput(input: unknown): ExecShellInput {
  if (input === null || input === undefined) {
    throw new Error("execShell requires a non-empty command.");
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new Error("execShell requires a non-empty command.");
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object") {
          return normalizeExecShellInput(parsed);
        }
      } catch {
        // Not valid JSON, treat as raw command string
      }
    }
    return { command: trimmed };
  }

  if (typeof input === "object") {
    const record = input as Record<string, unknown>;
    let rawCommand = resolveShellCommandArg(record);
    if (typeof rawCommand !== "string" || !rawCommand.trim()) {
      const fallback = record.command ?? record.cmd;
      if (typeof fallback === "string" && fallback.trim()) {
        rawCommand = fallback;
      }
    }
    const command = typeof rawCommand === "string" ? rawCommand.trim() : "";
    if (!command) {
      throw new Error("execShell requires a non-empty command.");
    }
    const activity = extractActivity(record);
    return {
      command,
      ...(record.shell !== undefined ? { shell: record.shell } : {}),
      ...(activity ? { activity } : {}),
      ...(record.input !== undefined ? { input: record.input } : {}),
    };
  }

  throw new Error("execShell requires a non-empty command.");
}

export const execShellCapability: ExecutableCapability<ExecShellInput, AgentRuntimeToolResult> = {
  name: "execShell",

  getToolDefinition(toolName = "execShell"): OpenAiCompatibleTool {
    return buildExecShellToolDefinition(toolName);
  },

  normalizeInput(input: unknown): ExecShellInput {
    return normalizeExecShellInput(input);
  },

  async invoke(
    ctx: CapabilityExecutionContext,
    normalized: ExecShellInput,
  ): Promise<AgentRuntimeToolResult> {
    const workspaceRoot = ctx.workspaceRoot || process.cwd();
    const command = normalized.command;

    if (ctx.restrictToWorkspace) {
      const escapeToken = findWorkspaceShellEscapeToken(command);
      if (escapeToken) {
        return buildWorkspaceShellEscapeBlockedResult({ command, token: escapeToken });
      }
    }

    const interactiveAuthCommand = extractInteractiveGhAuthCommand(command);
    if (interactiveAuthCommand) {
      const blocked = buildInteractiveCommandBlockedResult(interactiveAuthCommand);
      return {
        ...blocked,
        metadata: {
          ...blocked.metadata,
          ...(normalized.activity ? { activity: normalized.activity } : {}),
        },
      };
    }

    const result = await runWorkspaceCommand({
      workspaceRoot,
      command: buildWorkspaceShellCommand({
        toolName: "execShell",
        command,
        shell: normalized.shell,
      }),
      timeoutMs: resolveExecShellTimeoutMs(ctx.commandTimeoutMs),
      outputLimit: ctx.commandOutputLimit,
      commandPrefix: ctx.commandPrefix,
      abortSignal: ctx.abortSignal,
      detachMs: isImmediateDetachShellCommand({ command }) ? 0 : ctx.detachMs,
      stdin: typeof normalized.input === "string" ? normalized.input : undefined,
    });

    return {
      content: result.content,
      metadata: {
        command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        ...(result.aborted ? { aborted: true } : {}),
        ...(result.detached
          ? { detached: true, pid: result.pid, label: result.label, status: "running" as const }
          : {}),
        ...(normalized.activity ? { activity: normalized.activity } : {}),
      },
    };
  },
};
