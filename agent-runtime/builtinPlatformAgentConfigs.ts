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
 * - builtin nolo：平台路由默认 agent，@nolo 在记录缺失时保持可用。
 *   具体型号见 catalog 条目本身，此处不复述——复述过的地方都随换代过期了。
 *
 * 注意：记录存在时**不再**完全让位给记录。builtin 组的 provider/model 由
 * 代码托管，见本文件末尾的 `applyBuiltinAgentRuntimeOverride`。
 *
 * 默认档见 `packages/app/settings/quickChatTierDefaults.ts`（指向 nolo 本体）。
 */

import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type { BuiltinAgentCatalogEntry } from "../core/builtinAgentCatalog";
import {
  builtinAgentCatalogEntryById,
  builtinRuntimeFallbackEntries,
} from "../core/builtinAgentCatalog";
import { isBuiltinPlatformAgentKey } from "../core/builtinAgents";
import { parsePublicAgentId, publicAgentKey } from "../core/prefix";

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

/**
 * 平台内置 6 个 agent（catalog 的 `group: "builtin"`）的**运行时字段由代码托管**。
 *
 * 分工：`provider` / `model` 以 builtinAgentCatalog 为唯一真相源，即使数据库里
 * 存着别的值也以代码为准；`prompt` / `tools` / `greeting` / `name` 等内容字段
 * 仍然以记录为准（内容归数据，运行时归代码）。
 *
 * 为什么需要它：catalog 原本只在「记录缺失」时兜底，记录存在就完全让位给 DB。
 * 于是改了 catalog 的模型却没跑 `scripts/updatePlazaModels.ts` 时，代码和线上会
 * 静默分叉——2026-08 就发生过：catalog 已声明 nolo 用 deepseek-v4-flash-vision-exp，
 * 而线上记录仍是 kimi-k2.6（再被 platformHosted 转发到 qwen），用户看到的
 * context window 和实际模型都对不上。
 *
 * 生效点应当在**服务端**（`server/handlers/agentRun/agentLookup.ts`）：换代只需
 * 服务端发版，装着旧版 CLI / 桌面端的存量用户也立刻跟上，不必等客户端升级。
 * 客户端直连 provider 的本地模式（runtimeMode=local）绕过服务端，那条路仍靠升级。
 *
 * 注意：线上这 6 条记录里的旧 `model` 字段是**不生效的死字段**，刻意不迁移
 * （改数据有风险，且代码已经是真相源）。要换模型改 catalog，不要改数据库。
 */
export function resolveBuiltinAgentRuntimeFields(
  agentKey: string,
): { provider: string; model: string } | null {
  if (!isBuiltinPlatformAgentKey(agentKey)) return null;
  const entry = builtinAgentCatalogEntryById(parsePublicAgentId(agentKey));
  if (!entry) return null;
  return { provider: entry.provider, model: entry.model };
}

/**
 * 把 catalog 的 provider/model 盖到一条内置 agent 记录上。
 * 非内置 agent 原样返回（引用相等），调用方可以无条件套用。
 *
 * 同时覆盖 `rawRecord`：`AgentRuntimeAgentConfig` 会把原始记录整份挂在那里，
 * 而下游有直接从 rawRecord 读 provider/model 的（web 的 streamAgentChatTurn
 * 就是），只盖顶层会留下一份仍是旧值的副本。
 */
export function applyBuiltinAgentRuntimeOverride<T extends object>(
  agentKey: string,
  record: T,
): T {
  const fields = resolveBuiltinAgentRuntimeFields(agentKey);
  if (!fields) return record;

  const current = record as {
    provider?: unknown;
    model?: unknown;
    rawRecord?: Record<string, unknown>;
  };
  const rawNeedsOverride =
    current.rawRecord != null &&
    (current.rawRecord.provider !== fields.provider ||
      current.rawRecord.model !== fields.model);

  if (
    current.provider === fields.provider &&
    current.model === fields.model &&
    !rawNeedsOverride
  ) {
    return record;
  }

  return {
    ...record,
    provider: fields.provider,
    model: fields.model,
    ...(current.rawRecord
      ? {
          rawRecord: {
            ...current.rawRecord,
            provider: fields.provider,
            model: fields.model,
          },
        }
      : {}),
  };
}
