/**
 * Agent config inspection + tool surface resolution helpers.
 *
 * Extracted from localRuntimeAdapter.ts. Pure functions for detecting builtin
 * nolo agents, resolving the effective tool surface for an agent config, and
 * extracting user text / subject refs from runtime inputs.
 */
import type {
  AgentRuntimeAgentConfig,
  AgentRuntimeChatMessage,
  AgentRuntimeSaveTurnInput,
} from "../../agent-runtime";
import { resolveRuntimeToolSurfaceForAgent } from "../../agent-runtime/runtimeToolSurface";
import { asOptionalTrimmedString } from "../../core/optionalString";
import type { EnvLike } from "./localRuntimeHelpers";
import { NOLO_DEFAULT_AGENT_ID, NOLO_DEFAULT_AGENT_KEY } from "../agentAliases";
import { parseUserIdFromAuthToken } from "../cliEnvHelpers";
import {
  resolveRuntimeAuthToken,
} from "./localRuntimeHelpers";

export const BUILTIN_NOLO_AGENT_KEY = NOLO_DEFAULT_AGENT_KEY;
const BUILTIN_NOLO_AGENT_ID = NOLO_DEFAULT_AGENT_ID;

export function resolveLocalUserId(env: EnvLike) {
  const explicitUserId = env.NOLO_LOCAL_USER_ID || env.NOLO_USER_ID;
  if (explicitUserId) return explicitUserId;
  const tokenUserId = parseUserIdFromAuthToken(resolveRuntimeAuthToken(env));
  return tokenUserId || "local";
}

export function isBuiltinNoloAgentRef(ref: unknown) {
  if (typeof ref !== "string") return false;
  const normalized = ref.trim();
  return (
    normalized === BUILTIN_NOLO_AGENT_KEY ||
    normalized === BUILTIN_NOLO_AGENT_ID ||
    normalized.endsWith(`-${BUILTIN_NOLO_AGENT_ID}`)
  );
}

export function isBuiltinNoloAgentConfig(
  agentConfig: AgentRuntimeAgentConfig | null | undefined,
) {
  const key =
    agentConfig?.key ||
    agentConfig?.rawRecord?.dbKey ||
    agentConfig?.rawRecord?.agentKey;
  const id = agentConfig?.rawRecord?.id;
  return isBuiltinNoloAgentRef(key) || isBuiltinNoloAgentRef(id);
}

/**
 * Resolve the effective tool surface for an agent config, accounting for
 * builtin nolo agents (trusted), public agents (sharing), and private agents
 * owned by the current user.
 */
export function withResolvedRuntimeToolSurface(
  agentConfig: AgentRuntimeAgentConfig | null,
  env: EnvLike,
) {
  if (!agentConfig) return agentConfig;
  const currentUserId = resolveLocalUserId(env);
  const rawRecord = (agentConfig as any).rawRecord ?? {};
  const ownerId = asOptionalTrimmedString(rawRecord.userId) ?? null;
  const toolSurface = resolveRuntimeToolSurfaceForAgent({
    explicitToolNames: agentConfig.toolNames,
    currentUserId,
    agentOwnerId: ownerId,
    agentKey: rawRecord.dbKey ?? agentConfig.key,
    isPublic:
      !isBuiltinNoloAgentConfig(agentConfig) && rawRecord.isPublic === true,
    sharingLevel:
      typeof rawRecord.sharingLevel === "string"
        ? rawRecord.sharingLevel
        : null,
    trustedPrivateInvocation: isBuiltinNoloAgentConfig(agentConfig),
    runtimeHost: "cli",
  });
  return {
    ...agentConfig,
    toolNames: toolSurface.finalToolNames,
    toolSurface,
    prompt: agentConfig.prompt,
  };
}

export function extractLastUserText(messages: AgentRuntimeChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  if (typeof lastUser.content === "string") return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text ?? "")
      .join(" ");
  }
  return "";
}

export function localTurnHasSubjectRefs(input: AgentRuntimeSaveTurnInput) {
  return (
    Array.isArray(input.runtimeContext?.subjectRefs) &&
    input.runtimeContext.subjectRefs.length > 0
  );
}