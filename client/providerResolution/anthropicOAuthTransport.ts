/**
 * transport 分支：Anthropic OAuth —— /v1/messages 原生 wire
 *
 * 由 localRuntimeAdapter 原先 940 行的 resolveProviderBase 拆出，逻辑逐字保留。
 * 未命中本通道返回 null，交给 resolveLocalProvider 链上的下一条。
 */
import { fetchAnthropicMessagesCompletion, isAnthropicOAuthAgent } from "../../agent-runtime/anthropicMessagesProvider";
import { logLocalRuntimeDiagnostic } from "../localRuntimeDiagnostics";
import { fetchWithTransientRetry } from "../localRuntimeFetchRetry";
import { resolveProviderOpenAiToolBundle } from "../localRuntimeTools";
import type { ProviderResolver } from "./providerResolutionContext";

export const resolveAnthropicOAuthTransport: ProviderResolver = async (ctx) => {
  const { agentConfig, deps, fetchImpl, loopbackRequest, additionalToolNames, buildProviderOpenAiTools, recordLocalAvailability, apiKeyRefResolver } = ctx;
  // Claude Pro/Max OAuth uses Anthropic's Messages wire, not the generic
  // OpenAI-compatible transport. Keep the token local and translate at this
  // boundary, matching the server chat and background-run paths.
  if (isAnthropicOAuthAgent(agentConfig)) {
    const accessToken = await apiKeyRefResolver("claude");
    if (!accessToken) {
      throw new Error(
        'OAuth credential for "claude" not found locally. Run `nolo auth claude`.',
      );
    }
    const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
      agentConfig,
      deps.env,
      buildProviderOpenAiTools,
      additionalToolNames,
    );
    logLocalRuntimeDiagnostic("provider.selected", {
      agentKey: agentConfig.key,
      transport: "anthropic-messages",
      provider: "anthropic",
      model: agentConfig.model ?? "claude-sonnet-5",
      hasApiKey: true,
    });
    return {
      model: agentConfig.model || "claude-sonnet-5",
      complete: async (messages, options) => {
        const result = await fetchAnthropicMessagesCompletion({
          agentConfig,
          accessToken,
          openAiBody: {
            model: agentConfig.model || "claude-sonnet-5",
            messages,
            stream: false,
            ...(tools.length > 0 ? { tools } : {}),
          },
          fetchImpl: (url: string | URL | Request, init?: RequestInit) =>
            fetchWithTransientRetry(fetchImpl, url, init, {
              sleep: deps.sleep,
              loopbackRequest,
            }),
        });
        await recordLocalAvailability(result.status, result.body);
        if (result.status < 200 || result.status >= 300) {
          const errMsg =
            result.body?.error &&
            typeof result.body.error === "object" &&
            typeof result.body.error.message === "string"
              ? result.body.error.message
              : JSON.stringify(result.body);
          throw new Error(
            `local Claude OAuth provider failed: HTTP ${result.status} ${errMsg}`,
          );
        }
        const choice = Array.isArray(result.body.choices)
          ? result.body.choices[0]
          : undefined;
        const message = choice?.message ?? {};
        const content = typeof message.content === "string" ? message.content : "";
        const tool_calls = Array.isArray(message.tool_calls)
          ? message.tool_calls
          : undefined;
        if (content && options?.onTextDelta) options.onTextDelta(content);
        logLocalRuntimeDiagnostic("provider.request.result", {
          agentKey: agentConfig.key,
          transport: "anthropic-messages",
          ok: true,
          contentChars: content.length,
          toolCallCount: tool_calls?.length ?? 0,
          requestedToolNames,
        });
        return {
          content,
          model: agentConfig.model || "claude-sonnet-5",
          provider: "anthropic",
          ...(tool_calls ? { tool_calls } : {}),
          // fetchAnthropicMessagesCompletion 已把 Anthropic Messages 响应归一化成
          // OpenAI chat.completions 形状：choices[0] + usage（prompt_tokens/
          // output_tokens/cache_*）。必须透传，否则 localLoop 的 lastUsage 无
          // token 数，TUI context chip 拿不到更新（与 Codex OAuth 分支同因）。
          usage: result.body?.usage as Record<string, any> | undefined,
          trace: messages,
        };
      },
    };
  }
  return null;
};
