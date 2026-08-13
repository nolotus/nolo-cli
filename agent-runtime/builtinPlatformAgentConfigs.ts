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
 * Provider/model truth source: `packages/core/builtinAgentCatalog.ts`
 * (`runtimeFallback: true` 条目)。本表由目录派生，不手抄。
 *
 * Coverage（由 catalog 的 runtimeFallback 标记决定）：
 * - flash / pro / image tier：DeepSeek V4 Flash / Pro、Kimi K2.6
 * - public image agents (进站即可生成图片)：GPT Image 2 生成/编辑/连续创作、
 *   Nano Banana 2 Lite
 * - builtin nolo：平台路由默认 agent（目录里 provider nolo / deepseek-v4-flash，
 *   @nolo 在记录缺失时保持可用；可达时宿主记录优先，`readAgentFromStore`
 *   先查 store）。
 *
 * 档位默认值见 `packages/app/settings/quickChatTierDefaults.ts`
 * （flash/balanced/quality 复用 Flash；image 用 Kimi）。
 */

import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type { BuiltinAgentCatalogEntry } from "../core/builtinAgentCatalog";
import { builtinRuntimeFallbackEntries } from "../core/builtinAgentCatalog";
import { publicAgentKey } from "../core/prefix";

function buildConfig(e: BuiltinAgentCatalogEntry): AgentRuntimeAgentConfig {
  const key = publicAgentKey(e.id);
  const rawRecord: Record<string, unknown> = {
    dbKey: key,
    isPublic: true,
    provider: e.provider,
    model: e.model,
    apiSource: e.apiSource ?? "platform",
    useServerProxy: e.useServerProxy ?? true,
  };
  if (e.hasImageOutput) rawRecord.hasImageOutput = true;
  if (e.imageModel) rawRecord.imageModel = e.imageModel;
  if (e.imageWorkflow) rawRecord.imageWorkflow = e.imageWorkflow;
  if (e.imageConfig) rawRecord.imageConfig = e.imageConfig;
  return {
    key,
    name: e.name,
    provider: e.provider,
    model: e.model,
    apiSource: e.apiSource ?? "platform",
    useServerProxy: e.useServerProxy ?? true,
    rawRecord,
  };
}

/** 兜底表 = catalog 里 runtimeFallback 条目（派生，手抄全部消失） */
const BUILTIN_PLATFORM_AGENT_CONFIGS: Record<string, AgentRuntimeAgentConfig> =
  Object.fromEntries(
    builtinRuntimeFallbackEntries().map((e) => [publicAgentKey(e.id), buildConfig(e)]),
  );

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

/**
 * Same built-in truth, shaped as an Agent *record* (the flat form web hosts
 * pass around as `agentConfig`) instead of an `AgentRuntimeAgentConfig`.
 *
 * Web's `streamAgentChatTurn` consumes `agentConfig.dbKey` / `.provider` /
 * `.model` directly, so it needs `rawRecord` flattened with a `dbKey` — it
 * cannot use the runtime-shaped config the CLI and desktop hosts take.
 */
export function resolveBuiltinPlatformAgentRecord(
  agentRef: string,
): Record<string, unknown> | null {
  const config = resolveBuiltinPlatformAgentConfig(agentRef);
  if (!config) return null;
  return {
    ...config.rawRecord,
    dbKey: agentRef,
    ...(config.name ? { name: config.name } : {}),
  };
}
