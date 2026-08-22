import type { AgentRuntimeToolResult } from "../hostAdapter";
import type { OpenAiCompatibleTool } from "../localWorkspaceToolDefs";

export interface CapabilityExecutionContext {
  workspaceRoot?: string;
  commandTimeoutMs?: number;
  commandOutputLimit?: number;
  commandPrefix?: string[];
  restrictToWorkspace?: boolean;
  abortSignal?: AbortSignal;
  detachMs?: number;
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

  /** Actual capability execution */
  invoke(ctx: CapabilityExecutionContext, input: I): Promise<O>;
}
