import { isAbsolute } from "node:path";
import type { PermissionRequest } from "../actionGate";
import type { AgentRunService } from "./agentRunService";
import type { AgentActivitySink } from "./agentRunActivity";
import type { CapabilityExecutionContext, ExecutableCapability } from "./capability";
import { createCapabilitySdk, type CapabilitySdk, BUILTIN_CAPABILITIES } from "./capabilitySdk";

export interface PtcStrictTurnContext {
  /** Explicit absolute workspace root. Fallback to process.cwd() is strictly forbidden. */
  workspaceRoot: string;
  /** Explicit AbortSignal from the active turn lifecycle. */
  abortSignal: AbortSignal;
  /** Explicit workspace path containment constraint. */
  restrictToWorkspace: boolean;
  /** Explicit destructive shell command guard flag. */
  enableDestructiveShellGuard: boolean;
  /** Optional interactive confirmation policy for destructive actions. */
  blockDestructiveWithoutConfirmation?: boolean;
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  /** Execution timeout and limits */
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  commandPrefix?: string[];
  detachMs?: number;
  confirmed?: boolean;
  /** Programmatic agent runner service */
  agentRunService?: AgentRunService;
  /** Audit and activity hooks */
  onInvoke?: (capability: string, input: unknown) => void | Promise<void>;
  activityContext?: { parentActivityId?: string };
  onActivity?: AgentActivitySink;
  [key: string]: unknown;
}

export class PtcContextValidationError extends Error {
  constructor(message: string) {
    super(`PTC context validation failed: ${message}`);
    this.name = "PtcContextValidationError";
  }
}

/**
 * Validates and produces a fail-closed context for PTC (Programmatic Tool Calling) execution.
 *
 * Security & Reliability Invariants:
 * 1. workspaceRoot must be a non-empty string. Fallback to process.cwd() is strictly forbidden.
 * 2. abortSignal must be a valid AbortSignal instance from the current turn.
 * 3. restrictToWorkspace must be explicitly provided as a boolean.
 * 4. enableDestructiveShellGuard must be explicitly provided as a boolean.
 *
 * Missing or invalid critical fields immediately reject PTC execution.
 */
export function createPtcFailClosedContext(
  input: unknown,
): PtcStrictTurnContext {
  if (!input || typeof input !== "object") {
    throw new PtcContextValidationError("Turn context object is required for PTC execution.");
  }

  const raw = input as Record<string, unknown>;

  if (typeof raw.workspaceRoot !== "string" || !raw.workspaceRoot.trim()) {
    throw new PtcContextValidationError(
      "PTC execution requires an explicit, non-empty 'workspaceRoot'. Fallback to process.cwd() is strictly forbidden.",
    );
  }

  if (!isAbsolute(raw.workspaceRoot.trim())) {
    throw new PtcContextValidationError(
      `PTC execution requires an absolute path for 'workspaceRoot' (received "${raw.workspaceRoot}").`,
    );
  }

  if (
    !raw.abortSignal ||
    !(raw.abortSignal instanceof AbortSignal) ||
    typeof (raw.abortSignal as AbortSignal).aborted !== "boolean" ||
    typeof (raw.abortSignal as AbortSignal).addEventListener !== "function"
  ) {
    throw new PtcContextValidationError(
      "PTC execution requires an explicit 'abortSignal' (AbortSignal) from current turn context.",
    );
  }

  if (typeof raw.restrictToWorkspace !== "boolean") {
    throw new PtcContextValidationError(
      "PTC execution requires an explicit boolean 'restrictToWorkspace' setting.",
    );
  }

  if (typeof raw.enableDestructiveShellGuard !== "boolean") {
    throw new PtcContextValidationError(
      "PTC execution requires an explicit boolean 'enableDestructiveShellGuard' setting.",
    );
  }

  const validated: PtcStrictTurnContext = {
    workspaceRoot: raw.workspaceRoot.trim(),
    abortSignal: raw.abortSignal as AbortSignal,
    restrictToWorkspace: raw.restrictToWorkspace,
    enableDestructiveShellGuard: raw.enableDestructiveShellGuard,
    blockDestructiveWithoutConfirmation:
      typeof raw.blockDestructiveWithoutConfirmation === "boolean"
        ? raw.blockDestructiveWithoutConfirmation
        : undefined,
    confirmDestructiveAction:
      typeof raw.confirmDestructiveAction === "function"
        ? (raw.confirmDestructiveAction as (request: PermissionRequest) => Promise<boolean>)
        : undefined,
    commandTimeoutMs:
      typeof raw.commandTimeoutMs === "number" ? raw.commandTimeoutMs : undefined,
    commandOutputLimit:
      typeof raw.commandOutputLimit === "number" ? raw.commandOutputLimit : undefined,
    commandPrefix: Array.isArray(raw.commandPrefix) ? (raw.commandPrefix as string[]) : undefined,
    detachMs: typeof raw.detachMs === "number" ? raw.detachMs : undefined,
    confirmed: typeof raw.confirmed === "boolean" ? raw.confirmed : undefined,
    agentRunService: raw.agentRunService as AgentRunService | undefined,
    onInvoke: typeof raw.onInvoke === "function" ? (raw.onInvoke as any) : undefined,
    activityContext: raw.activityContext as { parentActivityId?: string } | undefined,
    onActivity: typeof raw.onActivity === "function" ? (raw.onActivity as AgentActivitySink) : undefined,
  };

  return validated;
}

/**
 * Creates a CapabilitySdk guaranteed to be bound to a fail-closed PTC context.
 */
export function createPtcCapabilitySdk(args: {
  turnContext: unknown;
  capabilities?: readonly ExecutableCapability<any, any>[];
}): { sdk: CapabilitySdk; context: PtcStrictTurnContext } {
  const strictContext = createPtcFailClosedContext(args.turnContext);
  const sdk = createCapabilitySdk({
    context: strictContext as CapabilityExecutionContext,
    capabilities: args.capabilities ?? BUILTIN_CAPABILITIES,
  });

  return {
    sdk,
    context: strictContext,
  };
}
