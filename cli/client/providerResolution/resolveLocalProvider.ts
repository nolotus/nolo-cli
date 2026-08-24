/**
 * 本地 runtime 的 provider 路由：按顺序试每条 transport，第一条命中的胜出。
 *
 * **顺序是语义的一部分**，不要随手调整：
 * 1. 本地 CLI 子进程 —— agent 显式声明了 cliProvider，最特殊，先判。
 * 2-4. 三条 OAuth 专用 wire（Antigravity CCA / Anthropic messages / Codex responses）
 *      —— 它们都不是 OpenAI-compatible，必须先于任何通用分支拦下，否则会被
 *      兜底通道当成普通 /chat/completions 打过去（历史上就是这么 404 的）。
 * 5. Cursor Connect。
 * 6. Gemini 3 + tools 的 native 路由 —— 必须先于 platform proxy，后者传不了
 *    thought_signature。
 * 7. 平台代理。
 * 8. 直连 OpenAI-compatible —— 兜底，永远命中，返回类型上不为 null。
 *
 * 拆分前这里是一个 940 行的闭包，分支靠缩进和上下文位置隐式排序；现在顺序被这
 * 个数组显式表达，增删一条通道只动一行 + 一个文件。
 */
import type { AgentRuntimeProvider } from "../../../agent-runtime";

import { resolveAnthropicOAuthTransport } from "./anthropicOAuthTransport";
import { resolveAntigravityTransport } from "./antigravityTransport";
import { resolveCliProviderTransport } from "./cliProviderTransport";
import { resolveCodexOAuthTransport } from "./codexOAuthTransport";
import { resolveCursorTransport } from "./cursorTransport";
import { resolveDirectOpenAiCompatibleTransport } from "./directOpenAiCompatibleTransport";
import { resolveGeminiNativeToolTransport } from "./geminiNativeToolTransport";
import { resolvePlatformProxyTransport } from "./platformProxyTransport";
import type { ProviderResolutionContext, ProviderResolver } from "./providerResolutionContext";

const TRANSPORTS: readonly ProviderResolver[] = [
  resolveCliProviderTransport,
  resolveAntigravityTransport,
  resolveAnthropicOAuthTransport,
  resolveCodexOAuthTransport,
  resolveCursorTransport,
  resolveGeminiNativeToolTransport,
  resolvePlatformProxyTransport,
  // 兜底必须留在最后。
  resolveDirectOpenAiCompatibleTransport,
];

export async function resolveLocalProvider(
  ctx: ProviderResolutionContext,
): Promise<AgentRuntimeProvider> {
  for (const transport of TRANSPORTS) {
    const provider = await transport(ctx);
    if (provider) return provider;
  }
  // 兜底通道要么返回 provider 要么抛错，走到这里说明 TRANSPORTS 被改坏了。
  throw new Error(
    "no local provider transport matched; the OpenAI-compatible fallback must be last in TRANSPORTS",
  );
}
