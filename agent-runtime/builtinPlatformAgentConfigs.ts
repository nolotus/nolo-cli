/**
 * Built-in public platform agent configs — shared by CLI local runtime and
 * desktop agent runtime adapter.
 *
 * When the local/remote record store has no record for one of these agent
 * keys (e.g. CLI leveldb never synced the public agent, or the remote read
 * 401/404s), we synthesize the same platform provider/model config the
 * hosted server would return, instead of falling back to the built-in `nolo`
 * agent or erroring with "Local agent config not found".
 *
 * Provider/model truth source (by priority):
 * 1. `scripts/createSpaceAgents.ts` seed definitions.
 * 2. `packages/app/settings/quickChatTierDefaults.ts` tier → agentKey map.
 *
 * Keep this mapping in sync with the quick-chat tier defaults in
 * `packages/app/settings/quickChatTierDefaults.ts`.
 */

import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import {
  BUILTIN_NOLO_AGENT_KEY,
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY,
  PUBLIC_GLM_52_AGENT_KEY,
  PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
  PUBLIC_KIMI_K27_CODING_AGENT_KEY,
} from "../core/builtinAgents";

/**
 * Built-in platform agent configs keyed by agent dbKey.
 *
 * Coverage:
 * - flash tier: DeepSeek V4 Flash (nolo / deepseek-v4-flash)
 * - balanced tier: DeepSeek V4 Pro (deepseek / deepseek-v4-pro)
 * - quality tier: GLM 5.2 (nolo / glm-5.2)
 * - image tier: Kimi K2.6 (nolo / kimi-k2.6)
 * - coding executor: Kimi K2.7 Coding (nolo / kimi-k2.7-code)
 * - builtin nolo: platform-routed default agent.
 *   NOTE: the builtin nolo agent has no seed in `scripts/createSpaceAgents.ts`;
 *   its provider/model live only in the hosted production record. As a
 *   code-level fallback we route it through the same platform proxy channel
 *   as flash (provider "nolo" / model "deepseek-v4-flash") so that `@nolo`
 *   keeps working when the record is unavailable. The hosted record, when
 *   reachable, always wins because `readAgentFromStore` checks the store
 *   first.
 */
const BUILTIN_PLATFORM_AGENT_CONFIGS: Record<string, AgentRuntimeAgentConfig> = {
  [PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY]: {
    key: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
    name: "DeepSeek V4 Flash",
    provider: "nolo",
    model: "deepseek-v4-flash",
    apiSource: "platform",
    useServerProxy: true,
    rawRecord: {
      dbKey: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
      isPublic: true,
      provider: "nolo",
      model: "deepseek-v4-flash",
      apiSource: "platform",
      useServerProxy: true,
    },
  },
  [PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY]: {
    key: PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY,
    name: "DeepSeek V4 Pro",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiSource: "platform",
    useServerProxy: true,
    rawRecord: {
      dbKey: PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY,
      isPublic: true,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      apiSource: "platform",
      useServerProxy: true,
    },
  },
  [PUBLIC_GLM_52_AGENT_KEY]: {
    key: PUBLIC_GLM_52_AGENT_KEY,
    name: "GLM 5.2",
    provider: "nolo",
    model: "glm-5.2",
    apiSource: "platform",
    useServerProxy: true,
    rawRecord: {
      dbKey: PUBLIC_GLM_52_AGENT_KEY,
      isPublic: true,
      provider: "nolo",
      model: "glm-5.2",
      apiSource: "platform",
      useServerProxy: true,
    },
  },
  [PUBLIC_KIMI_K26_IMAGE_AGENT_KEY]: {
    key: PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
    name: "Kimi K2.6",
    provider: "nolo",
    model: "kimi-k2.6",
    apiSource: "platform",
    useServerProxy: true,
    rawRecord: {
      dbKey: PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
      isPublic: true,
      provider: "nolo",
      model: "kimi-k2.6",
      apiSource: "platform",
      useServerProxy: true,
    },
  },
  [PUBLIC_KIMI_K27_CODING_AGENT_KEY]: {
    key: PUBLIC_KIMI_K27_CODING_AGENT_KEY,
    name: "Kimi K2.7 Coding",
    provider: "nolo",
    model: "kimi-k2.7-code",
    apiSource: "platform",
    useServerProxy: true,
    rawRecord: {
      dbKey: PUBLIC_KIMI_K27_CODING_AGENT_KEY,
      isPublic: true,
      provider: "nolo",
      model: "kimi-k2.7-code",
      apiSource: "platform",
      useServerProxy: true,
    },
  },
  [BUILTIN_NOLO_AGENT_KEY]: {
    key: BUILTIN_NOLO_AGENT_KEY,
    name: "Nolo",
    provider: "nolo",
    model: "deepseek-v4-flash",
    apiSource: "platform",
    useServerProxy: true,
    rawRecord: {
      dbKey: BUILTIN_NOLO_AGENT_KEY,
      isPublic: true,
      provider: "nolo",
      model: "deepseek-v4-flash",
      apiSource: "platform",
      useServerProxy: true,
    },
  },
};

/**
 * Resolve a built-in platform agent config by agentRef (agent dbKey).
 * Returns null for any ref not in the built-in map — callers fall back to
 * their own lookup / null handling.
 */
export function resolveBuiltinPlatformAgentConfig(
  agentRef: string,
): AgentRuntimeAgentConfig | null {
  return BUILTIN_PLATFORM_AGENT_CONFIGS[agentRef] ?? null;
}