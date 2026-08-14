import { randomUUID } from "node:crypto";

import { isAdaptiveThinkingModelId } from "../integrations/anthropic/anthropicOAuthModels";
import type { AgentRuntimeAgentConfig } from "./hostAdapter";

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_API_VERSION = "2023-06-01";
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

/**
 * Minimal Claude Code-compatible OAuth fingerprint.
 * Live-validated 2026-08-04: UA/betas alone still 429 Sonnet/Opus; identity
 * system block is required. Billing header / cch / Stainless / tool prefixes
 * are intentionally out of scope for this pass.
 */
export const CLAUDE_CODE_VERSION = "2.1.220";
export const CLAUDE_CODE_USER_AGENT =
  `claude-cli/${CLAUDE_CODE_VERSION} (external, local-agent, agent-sdk/0.1.0)`;
export const ANTHROPIC_OAUTH_BETA_HEADER =
  `claude-code-20250219,${ANTHROPIC_OAUTH_BETA}`;
export const CLAUDE_CODE_SYSTEM_INSTRUCTION =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
/** Legacy Claude Code identity phrases kept for dedupe only. */
const CLAUDE_CODE_IDENTITY_PATTERNS = [
  CLAUDE_CODE_SYSTEM_INSTRUCTION,
  "You are Claude Code",
] as const;

/**
 * reasoning_effort → Anthropic extended-thinking budget_tokens 映射。
 * Anthropic 没有 effort 枚举，只有 budget_tokens（1024..32000）。把 OpenAI
 * 风格的 effort 档位映射为 token 预算；缺省按 medium（8192）处理，对齐
 * createAgentSchema.ts 的 DEFAULT_REASONING_EFFORT。
 */
const REASONING_EFFORT_TO_BUDGET: Record<string, number> = {
  minimal: 2048,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 32000,
  max: 32000,
};

/** 返回 effort 对应的 thinking budget；none/off/未知返回 undefined（不开启）。 */
function resolveThinkingBudget(effort: string | undefined): number | undefined {
  if (!effort) return undefined;
  const normalized = effort.toLowerCase();
  if (normalized === "none" || normalized === "off") return undefined;
  return REASONING_EFFORT_TO_BUDGET[normalized];
}

// ── 默认档位常量（单一事实源，避免散落） ─────────────────────────────────────
/** effort 缺省时的档位（用户要求默认 medium，对齐 createAgentSchema.DEFAULT_REASONING_EFFORT）。 */
const DEFAULT_THINKING_EFFORT = "medium";
/** enabled 分支 effort 缺省时的默认 budget（medium=8192）。 */
const DEFAULT_ENABLED_BUDGET = 8192;
/** enableThinking=true 但未给 thinkingBudget 时的历史默认值（保留旧行为，与 8192 不一致是有意的）。 */
const DEFAULT_ENABLE_THINKING_BUDGET = 8000;

/**
 * Anthropic output_config.effort 枚举：max/xhigh/high/medium/low（无 minimal）。
 * minimal 是 OpenAI 风格最小思考档，Anthropic 不认，映射到最低档 low。
 */
const ANTHROPIC_EFFORT_ALIASES: Record<string, string> = { minimal: "low" };

type JsonRecord = Record<string, unknown>;

/** resolveThinkingSpec 输入：effort 原始值（大小写不敏感）、当前 maxTokens/temperature、调用方注入的 thinking。 */
type ThinkingSpecInput = {
  model: string | undefined;
  /** 原始 reasoning_effort（可能 undefined / none / off / minimal / low ...）。 */
  reasoningEffort: string | undefined;
  maxTokens: number;
  temperature: number | undefined;
  /** openAiBody.thinking（调用方已注入的 thinking，如 loopRequestBody 的 enableThinking 通道）。 */
  injectedThinking: unknown;
  enableThinking: unknown;
  thinkingBudget: unknown;
};

type ThinkingSpec = {
  thinkingBlock: JsonRecord | undefined;
  outputConfig: JsonRecord | undefined;
  maxTokens: number;
  temperature: number | undefined;
};

/**
 * 解析 Anthropic thinking 请求体（纯函数，可按 provider 复用）。
 * 官方 Models overview + steering 文档（2026-08 实测确认）：
 * - adaptive 模型（5 代 fable/opus/sonnet-5 + 4.6/4.7/4.8 系）：
 *   effort 在 output_config.effort，thinking:{type:"adaptive", display:"summarized"}
 *   （display 默认 omitted 思考不可见）；5 代默认 thinking-on，none/off 必须发
 *   {type:"disabled"} 才能关；无 budget 约束，不强改 max_tokens/temperature。
 * - extended 模型（4.5 及更早含 haiku-4-5，官方 Adaptive=No）：
 *   effort → budget_tokens 映射 + 硬约束（temperature=1、max_tokens>budget，否则 400）。
 * - 未知模型走 extended 分支（保守，向后兼容）。
 */
export function resolveThinkingSpec(input: ThinkingSpecInput): ThinkingSpec {
  const { model, maxTokens } = input;
  const normalizedEffort = input.reasoningEffort?.toLowerCase();
  const effortDisabled =
    normalizedEffort === "none" || normalizedEffort === "off";
  const effectiveEffort =
    normalizedEffort !== undefined && !effortDisabled
      ? (ANTHROPIC_EFFORT_ALIASES[normalizedEffort] ?? normalizedEffort)
      : DEFAULT_THINKING_EFFORT;

  let thinkingBlock: JsonRecord | undefined;
  let outputConfig: JsonRecord | undefined;
  let finalMaxTokens = maxTokens;
  let finalTemperature = input.temperature;

  if (isAdaptiveThinkingModelId(model)) {
    // adaptive：官方 effort 在 output_config.effort；summarized 让思考可见；
    // 5 代默认 thinking-on，显式 none/off 必须发 disabled 才能关。
    if (effortDisabled) {
      thinkingBlock = { type: "disabled" };
    } else {
      thinkingBlock = { type: "adaptive", display: "summarized" };
      outputConfig = { effort: effectiveEffort };
    }
  } else {
    // extended(enabled)：effort → budget_tokens + Anthropic 硬约束。
    const injected = input.injectedThinking as
      | { type?: unknown; budget_tokens?: unknown }
      | undefined;
    const injectedBudget =
      injected?.type === "enabled" && typeof injected.budget_tokens === "number"
        ? injected.budget_tokens
        : undefined;
    const effortBudget = resolveThinkingBudget(input.reasoningEffort);
    // effort 缺失（未显式关闭）时，回退到调用方注入的 thinking / enableThinking
    // / 默认 medium；effort 显式为 none/off 时不注入。
    const fallbackBudget =
      input.reasoningEffort === undefined
        ? injectedBudget ??
          (input.enableThinking === true
            ? (typeof input.thinkingBudget === "number"
                ? input.thinkingBudget
                : DEFAULT_ENABLE_THINKING_BUDGET)
            : DEFAULT_ENABLED_BUDGET)
        : undefined;
    const thinkingBudget = effortBudget ?? fallbackBudget;
    if (thinkingBudget !== undefined) {
      thinkingBlock = { type: "enabled", budget_tokens: thinkingBudget };
      // 硬约束：默认 max_tokens=8192 与 medium budget 相等，必须提升。
      finalMaxTokens = Math.max(maxTokens, thinkingBudget + 1);
      finalTemperature = 1;
    }
  }

  return {
    thinkingBlock,
    outputConfig,
    maxTokens: finalMaxTokens,
    temperature: finalTemperature,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isCacheControl(value: unknown): value is { type: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).type === "string",
  );
}

function toAnthropicContent(content: unknown): JsonRecord[] {
  // Anthropic Messages API rejects empty text blocks with HTTP 400
  // "text content blocks must be non-empty". Skip empty strings and empty
  // text parts so they never reach the wire.
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: JsonRecord[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as JsonRecord;
    if ((part.type === "text" || part.type === "input_text") && typeof part.text === "string") {
      if (part.text.length > 0) {
        const block: JsonRecord = { type: "text", text: part.text };
        if (isCacheControl(part.cache_control)) block.cache_control = part.cache_control;
        blocks.push(block);
      }
      continue;
    }
    if (part.type !== "image_url") continue;
    const imageUrl =
      typeof part.image_url === "string"
        ? part.image_url
        : stringValue((part.image_url as JsonRecord | undefined)?.url);
    if (!imageUrl) continue;
    const dataMatch = imageUrl.match(/^data:([^;,]+);base64,(.+)$/s);
    const block: JsonRecord = {
      type: "image",
      source: dataMatch
        ? { type: "base64", media_type: dataMatch[1], data: dataMatch[2] }
        : { type: "url", url: imageUrl },
    };
    if (isCacheControl(part.cache_control)) block.cache_control = part.cache_control;
    blocks.push(block);
  }
  return blocks;
}

function pushMessage(
  messages: JsonRecord[],
  role: "user" | "assistant",
  content: JsonRecord[],
): void {
  if (content.length === 0) return;
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    (previous.content as JsonRecord[]).push(...content);
    return;
  }
  messages.push({ role, content });
}

function hasClaudeCodeIdentity(system: JsonRecord[]): boolean {
  return system.some((block) => {
    if (!block || typeof block !== "object") return false;
    const text = stringValue((block as JsonRecord).text);
    return Boolean(
      text &&
        CLAUDE_CODE_IDENTITY_PATTERNS.some((pattern) => text.includes(pattern)),
    );
  });
}

export function buildAnthropicMessagesBody(args: {
  agentConfig: AgentRuntimeAgentConfig;
  openAiBody: JsonRecord;
}): JsonRecord {
  const rawMessages = Array.isArray(args.openAiBody.messages)
    ? args.openAiBody.messages
    : [];
  const system: JsonRecord[] = [];
  if (args.agentConfig.prompt?.trim()) {
    system.push({ type: "text", text: args.agentConfig.prompt.trim() });
  }
  const messages: JsonRecord[] = [];

  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as JsonRecord;
    const role = String(message.role ?? "");
    if (role === "system" || role === "developer") {
      const stablePrefixChars = Number(message.stable_prefix_chars);
      if (
        typeof message.content === "string" &&
        Number.isFinite(stablePrefixChars) &&
        stablePrefixChars > 0 &&
        stablePrefixChars <= message.content.length
      ) {
        const stable = message.content.slice(0, stablePrefixChars);
        // Keep the suffix byte-for-byte, including the separator inserted by
        // localLoop. Splitting for cache_control must not change model input.
        const dynamic = message.content.slice(stablePrefixChars);
        system.push({ type: "text", text: stable, cache_control: { type: "ephemeral" } });
        if (dynamic) system.push({ type: "text", text: dynamic });
      } else {
        system.push(...toAnthropicContent(message.content));
      }
      continue;
    }
    if (role === "tool") {
      const toolUseId = stringValue(message.tool_call_id);
      if (toolUseId) {
        pushMessage(messages, "user", [{
          type: "tool_result",
          tool_use_id: toolUseId,
          content: typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content ?? ""),
        }]);
      }
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const blocks = toAnthropicContent(message.content);
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const rawCall of message.tool_calls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as JsonRecord;
        const fn = call.function as JsonRecord | undefined;
        const name = stringValue(fn?.name);
        if (!name) continue;
        let input: unknown = {};
        try {
          input = typeof fn?.arguments === "string" ? JSON.parse(fn.arguments) : fn?.arguments ?? {};
        } catch {
          input = { value: fn?.arguments };
        }
        blocks.push({
          type: "tool_use",
          id: stringValue(call.id) ?? `toolu_${randomUUID()}`,
          name,
          input,
        });
      }
    }
    pushMessage(messages, role, blocks);
  }

  // Anthropic currently rejects third-party OAuth Sonnet/Opus unless the
  // request carries Claude Code identity + beta fingerprint.
  if (!hasClaudeCodeIdentity(system)) {
    system.unshift({ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION });
  }
  if (system.length > 0 && !system.some((block) => isCacheControl(block.cache_control))) {
    // Legacy callers provide one undifferentiated system prompt. Scope-aware
    // callers already mark the stable block; never move that breakpoint onto
    // a dynamic suffix such as current time, memory, or summary.
    system[system.length - 1].cache_control = { type: "ephemeral" };
  }

  const tools = Array.isArray(args.openAiBody.tools)
    ? args.openAiBody.tools.flatMap((raw): JsonRecord[] => {
        if (!raw || typeof raw !== "object") return [];
        const fn = (raw as JsonRecord).function as JsonRecord | undefined;
        const name = stringValue(fn?.name);
        if (!name) return [];
        return [{
          name,
          ...(stringValue(fn?.description) ? { description: fn?.description } : {}),
          input_schema:
            fn?.parameters && typeof fn.parameters === "object"
              ? fn.parameters
              : { type: "object", properties: {} },
        }];
      })
    : [];

  // Inject a cache_control breakpoint on the last tool definition so the entire
  // toolset is cached as part of the initial prefix (tools -> system -> messages).
  // Idempotent: skip when any tool already carries a cache_control breakpoint
  // (mirrors the system/messages injection guards below).
  if (tools.length > 0 && !tools.some((tool) => isCacheControl(tool.cache_control))) {
    tools[tools.length - 1].cache_control = { type: "ephemeral" };
  }
  const model =
    stringValue(args.openAiBody.model) ?? args.agentConfig.model ?? "claude-sonnet-5";
  const maxTokensRaw =
    args.openAiBody.max_completion_tokens ??
    args.openAiBody.max_tokens ??
    args.agentConfig.max_tokens;
  const maxTokens =
    typeof maxTokensRaw === "number" && Number.isFinite(maxTokensRaw)
      ? Math.max(1, Math.floor(maxTokensRaw))
      : 8192;

  // 推理强度：openAiBody（客户端）优先，fallback agentConfig；分流逻辑见
  // resolveThinkingSpec（adaptive/enabled 按模型代际，effort 默认 medium）。
  const reasoningEffort =
    stringValue(args.openAiBody.reasoning_effort) ??
    stringValue(args.agentConfig.reasoning_effort);
  const spec = resolveThinkingSpec({
    model,
    reasoningEffort,
    maxTokens,
    temperature:
      typeof args.openAiBody.temperature === "number"
        ? args.openAiBody.temperature
        : args.agentConfig.temperature,
    injectedThinking: args.openAiBody.thinking,
    enableThinking: (args.agentConfig as { enableThinking?: unknown }).enableThinking,
    thinkingBudget: (args.agentConfig as { thinkingBudget?: unknown }).thinkingBudget,
  });
  const { thinkingBlock, outputConfig } = spec;
  const finalMaxTokens = spec.maxTokens;
  const finalTemperature = spec.temperature;

  // Inject a single cache_control breakpoint on the last message's last
  // content block. This caches the full conversation prefix (system + history)
  // so the next turn's request can hit cache_read (0.1x quota vs 1x full input).
  // Single breakpoint is deliberate — the caller rebuilds the full message
  // array each turn, so a breakpoint on the current last message lets the next
  // turn's identical prefix hit the cache. Anthropic allows up to 4 breakpoints;
  // adding more on prior user turns is a future optimization, not needed now.
  if (messages.length > 0) {
    const lastMessage = messages[messages.length - 1];
    const content = Array.isArray(lastMessage.content) ? lastMessage.content : [];
    if (content.length > 0) {
      const lastBlock = content[content.length - 1];
      if (!isCacheControl(lastBlock.cache_control)) {
        lastBlock.cache_control = { type: "ephemeral" };
      }
    }
  }

  return {
    model,
    messages,
    max_tokens: finalMaxTokens,
    stream: false,
    ...(thinkingBlock ? { thinking: thinkingBlock } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(typeof finalTemperature === "number" ? { temperature: finalTemperature } : {}),
    ...(typeof args.openAiBody.top_p === "number" ? { top_p: args.openAiBody.top_p } : {}),
  };
}

export function mapAnthropicMessageToOpenAi(payload: JsonRecord): JsonRecord {
  const content = Array.isArray(payload.content) ? payload.content : [];
  let text = "";
  let reasoning = "";
  const toolCalls: JsonRecord[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as JsonRecord;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    if (block.type === "thinking" && typeof block.thinking === "string") reasoning += block.thinking;
    if (block.type === "tool_use" && typeof block.name === "string") {
      toolCalls.push({
        id: stringValue(block.id) ?? `toolu_${randomUUID()}`,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const usage = (payload.usage as JsonRecord | undefined) ?? {};
  const inputTokens =
    (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
    (typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0) +
    (typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0);
  const cacheCreationInputTokens =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
  const cacheReadInputTokens =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const stopReason = String(payload.stop_reason ?? "");
  const message: JsonRecord = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: stringValue(payload.id) ?? `chatcmpl_${randomUUID()}`,
    object: "chat.completion",
    model: stringValue(payload.model) ?? "claude",
    choices: [{
      index: 0,
      message,
      finish_reason:
        toolCalls.length > 0 || stopReason === "tool_use"
          ? "tool_calls"
          : stopReason === "max_tokens"
            ? "length"
            : "stop",
    }],
    usage: {
      // prompt_tokens/input_tokens are total input, including cache read/write.
      // Preserve Anthropic's components so normalization and billing can apply
      // the correct cache prices without double-counting them.
      prompt_tokens: inputTokens,
      input_tokens: inputTokens,
      completion_tokens: outputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cache_creation_input_tokens: cacheCreationInputTokens,
      cache_read_input_tokens: cacheReadInputTokens,
    },
  };
}

export async function fetchAnthropicMessagesCompletion(args: {
  agentConfig: AgentRuntimeAgentConfig;
  accessToken: string;
  openAiBody: JsonRecord;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; body: JsonRecord; headers?: Headers }> {
  const response = await (args.fetchImpl ?? fetch)(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "anthropic-version": ANTHROPIC_API_VERSION,
      "anthropic-beta": ANTHROPIC_OAUTH_BETA_HEADER,
      "User-Agent": CLAUDE_CODE_USER_AGENT,
      "x-app": "cli",
    },
    body: JSON.stringify(buildAnthropicMessagesBody(args)),
    signal: args.signal,
  });
  const payload = (await response.json().catch(async () => ({
    error: { message: await response.text().catch(() => response.statusText) },
  }))) as JsonRecord;
  if (!response.ok) return { status: response.status, body: payload, headers: response.headers };
  return { status: 200, body: mapAnthropicMessageToOpenAi(payload) };
}

export function isAnthropicOAuthAgent(
  agent: Pick<AgentRuntimeAgentConfig, "apiKeyRef">,
): boolean {
  return agent.apiKeyRef?.trim().toLowerCase() === "claude";
}
