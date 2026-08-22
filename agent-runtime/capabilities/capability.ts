import type { AgentRuntimeToolResult } from "../hostAdapter";
import type { PermissionRequest } from "../actionGate";

export type OpenAiCompatibleTool = Record<string, unknown> & {
  type?: string;
  function?: Record<string, unknown> & {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export interface CapabilityExecutionContext {
  workspaceRoot?: string;
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  commandPrefix?: string[];
  restrictToWorkspace?: boolean;
  abortSignal?: AbortSignal;
  detachMs?: number;
  /** Whether the destructive action was already approved/confirmed by the caller */
  confirmed?: boolean;
  /** Whether the destructive shell guard is enabled (defaults to true) */
  enableDestructiveShellGuard?: boolean;
  /** Optional interactive confirmation callback for destructive actions */
  confirmDestructiveAction?: (request: PermissionRequest) => Promise<boolean>;
  /**
   * Behavior when a destructive action is detected but confirmDestructiveAction is absent:
   * - true: reject and throw destructive_action_requires_confirmation error (e.g. desktop turn service)
   * - false: allow execution without stalling (headless CLI default)
   */
  blockDestructiveWithoutConfirmation?: boolean;
  /** Optional policy check or audit hook invoked before capability execution */
  onInvoke?: (capability: string, input: unknown) => void | Promise<void>;
  [key: string]: unknown;
}

export interface ExecutableCapability<I = unknown, O = AgentRuntimeToolResult> {
  readonly name: string;

  /** Native tool schema definition (OpenAI-compatible function tool format) */
  getToolDefinition(toolName?: string): OpenAiCompatibleTool;

  /** Canonical input normalization & validation. Throws on invalid input. */
  normalizeInput(input: unknown): I;

  /**
   * Low-level capability execution hook.
   *
   * Note: This is the raw underlying implementation. It does NOT evaluate
   * runtime safety policies or audit hooks. Public consumers and tool adapters
   * should always execute capabilities via `invokeCapability(capability, input, ctx)`
   * or `createCapabilitySdk({ context }).invoke(...)`, which enforce the full
   * `normalize -> policy -> audit(onInvoke) -> invoke` pipeline.
   */
  invoke(ctx: CapabilityExecutionContext, input: I): Promise<O>;
}
