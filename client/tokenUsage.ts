import {
  BUILTIN_NOLO_AGENT_KEY,
  BUILTIN_NOLO_AGENT_NAME,
} from "../core/builtinAgents";
import { API_REPORTED_COST_MULTIPLIER } from "../ai/token/calculatePrice";
import { findModelConfig } from "../ai/llm/providers";
import {
  DEFAULT_CONTEXT_WINDOW,
  getModelContextWindow,
} from "../ai/llm/getModelContextWindow";
import { builtinAgentCatalogEntryById } from "../core/builtinAgentCatalog";
import { parsePublicAgentId } from "../core/prefix";
import { normalizeUsage } from "../ai/token/normalizeUsage";
import type { EnvLike } from "./agentRunTypes";

export type TurnTokenUsage = {
  input: number;
  output: number;
  contextWindow?: number;
  remaining?: number;
  /** 本轮累计消耗的平台积分（provider 返回 cost 按 8 credits/USD 换算；非平台计费无此值）。 */
  credits?: number;
  /**
   * 命中缓存的输入 token（已含在 `input` 里，不是额外量）。
   * 命中与未命中的单价可差一到两个数量级，光看 input 看不出账单为什么是那个数。
   */
  cacheRead?: number;
  /** 写入缓存的输入 token（同样已含在 `input` 里）。 */
  cacheWrite?: number;
};

const isUsableModelId = (model?: string | null): model is string => {
  const raw = model?.trim();
  return Boolean(raw) && raw !== "-" && raw !== "auto";
};

export type AgentModelRef = {
  agentKey?: string;
  agentName?: string;
  model?: string | null;
};

/**
 * 「这个 agent 实际跑哪个模型」——本文件唯一的一处判断。
 *
 * 顺序：显式 model → 该 key 在 builtinAgentCatalog 里声明的模型。
 * 都不命中返回 undefined，由调用方决定怎么兜底。
 *
 * 直接查 catalog，而不是维护一张「档位 key → 模型」的小表：catalog 本来就覆盖
 * 内置 + 广场 + 内部管线的全部条目，小表只认三个档位 key 且三个值完全相同。
 *
 * 上下文窗口和 token 估算都建在它上面。这两条链曾经各写各的：窗口查了档位 key
 * 而估算没查，同一个 key 一边解析出 1M、另一边说不知道。
 */
function resolveEffectiveModel(opts: AgentModelRef): string | undefined {
  if (isUsableModelId(opts.model)) return opts.model;

  const agentKey = opts.agentKey?.trim();
  if (!agentKey) return undefined;

  return builtinAgentCatalogEntryById(parsePublicAgentId(agentKey))?.model;
}

/**
 * 供 `estimateDefaultCliContextTokens` 展开的展示名 + 模型。
 *
 * 初始状态 / `/new` / `/compact` / `/switch` 共用这一处解析，之前各处手抄
 * "DeepSeek V4 Flash" / "deepseek-v4-flash" 已随型号换代漂移成过期值。
 * 字段都可选：解析不出来就不给，让下游用自己的兜底，不塞空串冒充有值。
 */
export function resolveAgentModelIdentity(
  opts: AgentModelRef,
): { agentName?: string; model?: string } {
  const model = resolveEffectiveModel(opts);
  // 默认档用 catalog 的品牌名（"nolo"），除非调用方显式给了 model——那说明
  // 它已经知道自己在跑什么，名字也该由它说了算。
  const useCatalogName =
    !isUsableModelId(opts.model) && opts.agentKey?.trim() === BUILTIN_NOLO_AGENT_KEY;
  const agentName = useCatalogName ? BUILTIN_NOLO_AGENT_NAME : opts.agentName?.trim();

  return {
    ...(agentName ? { agentName } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * Resolve the context window for a TUI agent selection.
 *
 * 先按 `resolveEffectiveModel` 解析出真实模型；解析不出来才退回显示名的 fuzzy
 * 匹配，最后才是通用默认值。修掉过的历史 bug：agentName "nolo" 一路落到
 * DEFAULT_CONTEXT_WINDOW（256k），而它实际跑在 1M 的模型上。窗口跟随 catalog
 * 模型，所以 NOLO_AUTO_ROUTE 不再影响它。
 */
export function resolveAgentContextWindow(opts: AgentModelRef): number {
  const model = resolveEffectiveModel(opts);
  if (model) return getModelContextWindow(model);

  if (opts.agentName?.trim()) {
    return getModelContextWindow(opts.agentName);
  }

  return DEFAULT_CONTEXT_WINDOW;
}

const PROVIDER_LOOKUP_ORDER = [
  "openrouter",
  "fireworks",
  "openai",
  "mimo",
  "gmi",
  "google",
  "nolo",
  "mistral",
  "vultr",
  "deepinfra",
  "cloudflare",
] as const;

export function parseUsageRecord(usage?: Record<string, unknown> | null): TurnTokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  if (!input && !output) return undefined;
  // Cache field names differ per provider — Anthropic uses
  // cache_read_input_tokens, DeepSeek uses top-level prompt_cache_hit_tokens /
  // prompt_cache_miss_tokens, OpenAI nests cached_tokens under
  // prompt_tokens_details. normalizeUsage already knows all of them, so read
  // through it rather than keeping a second, narrower list here.
  const normalized = normalizeUsage(usage as never);
  const cacheRead = normalized.cache_read_input_tokens || undefined;
  const cacheWrite = normalized.cache_creation_input_tokens || undefined;
  return {
    input,
    output,
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

export function mergeUsageRecords(
  current?: Record<string, unknown> | null,
  next?: Record<string, unknown> | null
) {
  const left = parseUsageRecord(current);
  const right = parseUsageRecord(next);
  // Nothing on the left: hand back `next` untouched. Reshaping it here used to
  // drop the cache fields, which is how a merged total could disagree with the
  // provider's own numbers.
  if (!left) return right ? next ?? undefined : current ?? undefined;
  if (!right) return current ?? undefined;
  const cacheRead = (left.cacheRead ?? 0) + (right.cacheRead ?? 0);
  const cacheWrite = (left.cacheWrite ?? 0) + (right.cacheWrite ?? 0);
  return {
    input_tokens: left.input + right.input,
    output_tokens: left.output + right.output,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_creation_input_tokens: cacheWrite } : {}),
  };
}

export function resolveContextWindow(model?: string) {
  const raw = model?.trim();
  if (!raw) return undefined;

  for (const provider of PROVIDER_LOOKUP_ORDER) {
    const config = findModelConfig(provider, raw);
    if (config?.contextWindow) return config.contextWindow;
  }

  // PROVIDER_LOOKUP_ORDER 不含 qwen / moonshot / nolo / xai / zai / anthropic，
  // 且对命名变体（显示名、未在表内的自定义 id）也会 miss。回退到全量模型表 +
  // fuzzy 兜底，与 TUI 初始 fallback 共用单一真值源（getModelContextWindow）。
  return getModelContextWindow(raw);
}

export function buildTurnTokenUsage(
  usage?: Record<string, unknown> | null,
  model?: string
): TurnTokenUsage | undefined {
  const parsed = parseUsageRecord(usage);
  if (!parsed) return undefined;
  const contextWindow = resolveContextWindow(model);
  const remaining =
    contextWindow && parsed.input > 0
      ? Math.max(0, contextWindow - parsed.input)
      : undefined;
  const rawCost = typeof usage?.cost === "number" ? usage.cost : undefined;
  const credits =
    rawCost !== undefined && rawCost > 0
      ? rawCost * API_REPORTED_COST_MULTIPLIER
      : undefined;
  return {
    ...parsed,
    ...(contextWindow ? { contextWindow } : {}),
    ...(remaining != null ? { remaining } : {}),
    ...(credits !== undefined ? { credits } : {}),
  };
}

export function formatTokenCount(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const compact = value / 1000;
    if (Number.isInteger(compact)) return `${compact}k`;
    return `${compact.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const compact = value / 1_000_000;
  return compact >= 100 ? `${Math.round(compact)}M` : `${compact.toFixed(1).replace(/\.0$/, "")}M`;
}

export function renderTokenStatus(tokens?: TurnTokenUsage) {
  if (!tokens) return "in — out — left —";
  const left =
    tokens.remaining != null
      ? formatTokenCount(tokens.remaining)
      : tokens.contextWindow
        ? "—"
        : "—";
  // Cache hits are a slice of `input`, so they read as a parenthetical on it
  // rather than a separate column.
  const cache =
    tokens.cacheRead != null && tokens.cacheRead > 0
      ? ` (cache ${formatTokenCount(tokens.cacheRead)})`
      : "";
  return `in ${formatTokenCount(tokens.input)}${cache} out ${formatTokenCount(tokens.output)} left ${left}`;
}

export function shouldShowUsage(env: EnvLike) {
  return env.NOLO_DEBUG === "1" || env.NOLO_SHOW_USAGE === "1";
}

export function formatUsage(usage: any, dialogId: unknown) {
  const parts: string[] = [];
  if (typeof dialogId === "string" && dialogId)
    parts.push(`dialog=${dialogId}`);

  if (usage && typeof usage === "object") {
    const normalized = normalizeUsage(usage as never);
    const input = Number(normalized.input_tokens || usage?.input_tokens || usage?.prompt_tokens || 0);
    const output = Number(normalized.output_tokens || usage?.output_tokens || usage?.completion_tokens || 0);
    const cacheHit = Number(normalized.cache_read_input_tokens || 0);

    if (input || output) {
      let tokenStr = `tokens=${input}+${output}`;
      if (cacheHit > 0 && input > 0) {
        const hitPercent = ((cacheHit / (input + cacheHit)) * 100).toFixed(1).replace(/\.0$/, "");
        tokenStr += ` (cache: ${formatTokenCount(cacheHit)} / ${hitPercent}%)`;
      }
      parts.push(tokenStr);
    }
  }

  return parts.length ? `  (${parts.join("  ")})` : "";
}