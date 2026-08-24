/**
 * transport 分支：Antigravity（Google Cloud Code Assist）——CCA wire，非 OpenAI 兼容
 *
 * 由 localRuntimeAdapter 原先 940 行的 resolveProviderBase 拆出，逻辑逐字保留。
 * 未命中本通道返回 null，交给 resolveLocalProvider 链上的下一条。
 */
import type { AgentRuntimeToolCall } from "../../agent-runtime";
import { fetchAntigravityCloudCodeCompletion } from "../../agent-runtime/antigravityCloudCodeProvider";
import { isAntigravityOAuthAgent } from "../../agent-runtime/antigravityOAuth";
import { readOAuthCredential } from "../../agent-runtime/oauthTokenStore";
import { logLocalRuntimeDiagnostic, summarizeOpenAiToolNames } from "../localRuntimeDiagnostics";
import { fetchWithTransientRetry } from "../localRuntimeFetchRetry";
import { resolveProviderOpenAiToolBundle } from "../localRuntimeTools";
import { toErrorMessage } from "../../core/errorMessage";
import { summarizeEndpoint } from "../../core/summarizeEndpoint";
import type { ProviderResolver } from "./providerResolutionContext";

export const resolveAntigravityTransport: ProviderResolver = async (ctx) => {
  const { agentConfig, deps, fetchImpl, loopbackRequest, additionalToolNames, buildProviderOpenAiTools, recordLocalAvailability, apiKeyRefResolver } = ctx;
  // Antigravity (Google Cloud Code Assist) is not OpenAI-compatible: local
  // direct `/chat/completions` against daily-cloudcode-pa returns HTTP 404.
  // Mirror server agent-run loop: CCA wire + local oauth refresh.
  if (isAntigravityOAuthAgent(agentConfig)) {
    // OAuth access token 可能短于一次工具循环的时长，也可能被 Google 在
    // 本地仍认为新鲜时提前作废（refresh 轮换/上游瞬时拒绝）。解析下沉到
    // 每次请求；401 时强制换新 token 重试一次，与 openAiCompatibleProvider
    // 和服务端 loopUpstream 的 401/403 refresh-and-retry 对齐。
    const resolveAccessToken = async (): Promise<string> => {
      const accessToken = await apiKeyRefResolver("antigravity");
      if (!accessToken) {
        throw new Error(
          'OAuth credential for "antigravity" not found locally. Run `nolo auth antigravity`.',
        );
      }
      return accessToken;
    };
    // 构建时快速失败：凭证完全缺失时保留原有的明确指引。
    await resolveAccessToken();
    const credential = readOAuthCredential("antigravity");
    const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
      agentConfig,
      deps.env,
      buildProviderOpenAiTools,
      additionalToolNames,
    );
    logLocalRuntimeDiagnostic("provider.selected", {
      agentKey: agentConfig.key,
      transport: "antigravity-cloud-code",
      apiSource: agentConfig.apiSource ?? null,
      provider: agentConfig.provider ?? "google-antigravity",
      model: agentConfig.model ?? null,
      customProviderEndpoint:
        summarizeEndpoint(agentConfig.customProviderUrl) ?? null,
      hasApiKey: true,
      hasProjectId: Boolean(credential?.metadata?.projectId),
    });
    return {
      model: agentConfig.model || "gemini-3.1-pro",
      complete: async (messages, options) => {
        const openAiBody: Record<string, unknown> = {
          model: agentConfig.model || "gemini-3.1-pro",
          messages,
          stream: false,
          ...(tools.length > 0 ? { tools } : {}),
        };
        logLocalRuntimeDiagnostic("provider.request.start", {
          agentKey: agentConfig.key,
          transport: "antigravity-cloud-code",
          model: openAiBody.model,
          messageCount: messages.length,
          toolCount: tools.length,
          requestedToolNames,
          openAiToolNames: summarizeOpenAiToolNames(tools),
        });
        const accessToken = await resolveAccessToken();
        const sendCcaRequest = (token: string) =>
          fetchAntigravityCloudCodeCompletion({
            agentConfig,
            accessToken: token,
            metadata: credential?.metadata ?? null,
            openAiBody,
            signal: options?.signal,
            onTextDelta: options?.onTextDelta,
            onReasoningDelta: options?.onReasoningDelta,
            fetchImpl: (url: string | URL | Request, init?: RequestInit) =>
              fetchWithTransientRetry(fetchImpl, url, init, {
                sleep: deps.sleep,
                loopbackRequest,
              }),
          });
        let result = await sendCcaRequest(accessToken);
        if (result.status === 401) {
          // 上游拒绝了本地认为新鲜的 token：强制换新 token 重试一次。
          // 刷新失败时保留原始 401 向上抛（对齐 loopUpstream 的语义）。
          try {
            const refreshed = await apiKeyRefResolver("antigravity", {
              force: true,
            });
            if (refreshed && refreshed !== accessToken) {
              logLocalRuntimeDiagnostic("provider.request.auth_retry", {
                agentKey: agentConfig.key,
                transport: "antigravity-cloud-code",
              });
              result = await sendCcaRequest(refreshed);
            }
          } catch (error) {
            logLocalRuntimeDiagnostic("provider.request.auth_retry_failed", {
              agentKey: agentConfig.key,
              transport: "antigravity-cloud-code",
              error: toErrorMessage(error),
            });
          }
        }
        await recordLocalAvailability(result.status, result.body);
        if (result.status < 200 || result.status >= 300) {
          const errMsg =
            result.body &&
            typeof result.body === "object" &&
            result.body.error &&
            typeof (result.body.error as { message?: unknown }).message ===
              "string"
              ? (result.body.error as { message: string }).message
              : JSON.stringify(result.body);
          throw new Error(
            `local antigravity provider failed: HTTP ${result.status} ${errMsg}`,
          );
        }
        const choice = Array.isArray(result.body.choices)
          ? (result.body.choices[0] as
              | {
                  message?: {
                    content?: string | null;
                    tool_calls?: AgentRuntimeToolCall[];
                  };
                }
              | undefined)
          : undefined;
        const message = choice?.message ?? {};
        const content =
          typeof message.content === "string"
            ? message.content
            : message.content == null
              ? ""
              : String(message.content);
        const tool_calls = Array.isArray(message.tool_calls)
          ? message.tool_calls
          : undefined;
        logLocalRuntimeDiagnostic("provider.request.result", {
          agentKey: agentConfig.key,
          transport: "antigravity-cloud-code",
          ok: true,
          contentChars: content.length,
          toolCallCount: tool_calls?.length ?? 0,
        });
        return {
          content,
          model: agentConfig.model || "gemini-3.1-pro",
          provider: agentConfig.provider || "google-antigravity",
          ...(tool_calls ? { tool_calls } : {}),
          // fetchAntigravityCloudCodeCompletion 已把 CCA 流聚合完毕并归一化成
          // OpenAI chat.completions 形状：choices[0] + usage
          // （prompt_tokens/completion_tokens/total_tokens）。必须透传，否则
          // localLoop 的 lastUsage 无 token 数，TUI context chip 拿不到更新。
          usage: result.body?.usage as Record<string, any> | undefined,
          trace: messages,
        };
      },
    };
  }
  return null;
};
