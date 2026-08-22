// packages/agent-runtime/capabilities/capabilityPolicy.ts
//
// Canonical policy evaluation for capabilities before execution.
// Ensures consistent policy enforcement across native tool calls, programmatic SDK, and standalone invocations.

import type { PermissionRequest } from "../actionGate";
import { isDestructiveShellCommand, resolveShellCommandArg } from "../shellCommandPolicy";
import type { CapabilityExecutionContext, ExecutableCapability } from "./capability";

export function toDisplayCommand(command: unknown): string | undefined {
  if (typeof command === "string") {
    const trimmed = command.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(command)) {
    const joined = command
      .map((item) => (typeof item === "string" ? item : String(item)))
      .filter((item) => item.length > 0)
      .join(" ")
      .trim();
    return joined ? joined : undefined;
  }
  return undefined;
}

export function buildDestructiveShellPermissionRequest(command?: string): PermissionRequest {
  return {
    id: "permission-shell-destructive-action",
    tool: "execShell",
    action: "destructive_shell_command",
    title: "确认执行破坏性 shell 命令",
    body: "该命令可能删除或重置用户内容，需要用户明确确认后才能执行。",
    ...(command ? { command } : {}),
    suggestedRule: {
      scope: "once",
      pattern: { capability: "destructive_action", target: "shell_command" },
    },
  };
}

export function buildDestructiveShellBlockedError(
  reason: string,
  request: PermissionRequest,
): Error & {
  code: string;
  policy: Record<string, unknown>;
  permissionRequest: PermissionRequest;
} {
  const error = new Error(reason) as Error & {
    code: string;
    policy: Record<string, unknown>;
    permissionRequest: PermissionRequest;
  };
  error.code = "destructive_action_requires_confirmation";
  error.policy = {
    capability: "destructive_action",
    target: "shell_command",
    detail: "execShell destructive command",
  };
  error.permissionRequest = request;
  return error;
}

export async function evaluateExecShellDestructiveGuard(
  input: unknown,
  ctx: CapabilityExecutionContext,
): Promise<void> {
  const guardEnabled = ctx.enableDestructiveShellGuard !== false;
  if (!guardEnabled || ctx.confirmed) {
    return;
  }

  const rawCommand = resolveShellCommandArg(
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : { command: input },
  );
  const extraInput =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>).input : undefined;

  if (!isDestructiveShellCommand({ command: rawCommand, input: extraInput })) {
    return;
  }

  const displayCommand = toDisplayCommand(rawCommand);
  const request = buildDestructiveShellPermissionRequest(displayCommand);

  if (!ctx.confirmDestructiveAction) {
    if (ctx.blockDestructiveWithoutConfirmation) {
      throw buildDestructiveShellBlockedError(
        "destructive shell command blocked: no confirmation channel available",
        request,
      );
    }
    return;
  }

  const confirmed = await ctx.confirmDestructiveAction(request);
  if (!confirmed) {
    throw buildDestructiveShellBlockedError(
      "destructive shell command blocked: user declined confirmation",
      request,
    );
  }
}

export async function evaluateCapabilityPolicy(
  capability: ExecutableCapability<any, any>,
  normalizedInput: unknown,
  ctx: CapabilityExecutionContext,
): Promise<void> {
  if (capability.name === "execShell") {
    await evaluateExecShellDestructiveGuard(normalizedInput, ctx);
  }
}
