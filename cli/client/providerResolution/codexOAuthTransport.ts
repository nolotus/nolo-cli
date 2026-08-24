/**
 * transport 分支：Codex OAuth —— /backend-api/codex/responses wire
 *
 * 由 localRuntimeAdapter 原先 940 行的 resolveProviderBase 拆出，逻辑逐字保留。
 * 未命中本通道返回 null，交给 resolveLocalProvider 链上的下一条。
 */
import type { AgentRuntimeResult } from "../../../agent-runtime";
import { fetchCodexResponsesCompletion, isCodexOAuthAgent } from "../../../agent-runtime/codexResponsesProvider";
import { readOAuthCredential } from "../../../agent-runtime/oauthTokenStore";
import { logLocalRuntimeDiagnostic } from "../localRuntimeDiagnostics";
import { fetchWithTransientRetry } from "../localRuntimeFetchRetry";
import { resolveProviderOpenAiToolBundle } from "../localRuntimeTools";
import type { ProviderResolver } from "./providerResolutionContext";

export const resolveCodexOAuthTransport: ProviderResolver = async (ctx) => {
  const { agentConfig, deps, fetchImpl, loopbackRequest, additionalToolNames, buildProviderOpenAiTools, recordLocalAvailability, apiKeyRefResolver } = ctx;
  // ChatGPT Codex (subscription OAuth) — Responses API at
  // /backend-api/codex/responses. ChatGPT OAuth tokens cannot call
  // api.openai.com/v1/responses (returns 401 missing_scope: model.request);
  // they must go through the Codex backend. Mirrors the server-side
  // loopUpstream.ts Codex branch.
  if (isCodexOAuthAgent(agentConfig)) {
    const accessToken = await apiKeyRefResolver("chatgpt");
    if (!accessToken) {
      throw new Error(
        'OAuth credential for "chatgpt" not found locally. Run `nolo auth chatgpt`.',
      );
    }
    const credential = readOAuthCredential("chatgpt");
    const accountId = credential?.accountId;
    const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
      agentConfig,
      deps.env,
      buildProviderOpenAiTools,
      additionalToolNames,
    );
    logLocalRuntimeDiagnostic("provider.selected", {
      agentKey: agentConfig.key,
      transport: "codex-responses",
      provider: "openai",
      model: agentConfig.model ?? "gpt-5.6-sol",
      hasApiKey: true,
    });
    return {
      model: agentConfig.model || "gpt-5.6-sol",
      complete: async (messages, options) => {
        const result = await fetchCodexResponsesCompletion({
          agentConfig,
          accessToken,
          ...(accountId ? { accountId } : {}),
          openAiBody: {
            model: agentConfig.model || "gpt-5.6-sol",
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
            `local Codex OAuth provider failed: HTTP ${result.status} ${errMsg}`,
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
          transport: "codex-responses",
          ok: true,
          contentChars: content.length,
          toolCallCount: tool_calls?.length ?? 0,
          requestedToolNames,
        });
        return {
          content,
          ...(tool_calls ? { tool_calls } : {}),
          // fetchCodexResponsesCompletion 已把 codex responses 流聚合完毕并归一化成
          // OpenAI chat.completions 形状：choices[0].finish_reason（"stop"/"tool_calls"）
          // + usage（prompt/completion/total_tokens）。必须透传，否则 localLoop 把正常走完
          // 的空轮误判成 stream_truncated、TUI context chip 也拿不到 token 数更新。
          finish_reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
          stream_complete: true,
          // body 类型是 Record<string, unknown>，透传 usage 需 cast 到 AgentRuntimeResult.usage。
          usage: result.body?.usage as Record<string, any> | undefined,
          trace: messages,
        };
      },
    };
  }
  return null;
};
