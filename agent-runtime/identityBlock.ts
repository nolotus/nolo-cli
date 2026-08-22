/**
 * Shared agent identity block builder.
 *
 * Single source of truth for the "--- 身份信息 ---" block that tells the model
 * which agent it is (name / ID / model). Every execution
 * surface must use this builder so the identity block — especially the model
 * name — is injected identically across:
 *
 *   - the renderer/web prompt (`ai/agent/buildSystemPrompt.ts`)
 *   - the server agent-run runtime (`server/handlers/agentRun/runtimeSystemMessages.ts`)
 *   - the local/desktop/TUI runtime (`agent-runtime/localLoop.ts`)
 *
 * Lives in `agent-runtime` (the lowest-level, host-agnostic package) because
 * the renderer → agent-runtime direction is allowed but the reverse is not.
 *
 * Format is intentionally stable (session-scope cache prefix): the block only
 * changes when the agent's identity changes, never per turn.
 */
import { asTrimmedString } from "../core/trimmedString";

export interface IdentityBlockInput {
  agentName?: string | null;
  agentId?: string | null;
  model?: string | null;
}

export const buildIdentityBlock = (input: IdentityBlockInput): string => {
  const lines = [
    "--- 身份信息 ---",
    asTrimmedString(input.agentName) ? `名称: ${asTrimmedString(input.agentName)}` : "",
    asTrimmedString(input.agentId) ? `ID: ${asTrimmedString(input.agentId)}` : "",
    asTrimmedString(input.model) ? `模型: ${asTrimmedString(input.model)}` : "",
  ].filter(Boolean);
  return lines.join("\n");
};
