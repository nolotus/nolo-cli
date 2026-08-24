/**
 * transport 分支：直连 OpenAI-compatible endpoint —— 所有分支都未命中时的兜底通道
 *
 * 由 localRuntimeAdapter 原先 940 行的 resolveProviderBase 拆出，逻辑逐字保留。
 * 未命中本通道返回 null，交给 resolveLocalProvider 链上的下一条。
 */
import { inlineImageUrlsForCustomProvider } from "../../../ai/chat/inlineImageUrlsForCustomProvider";
import { executeOpenAiCompatibleChatCompletion } from "../../agentRuntimeLocal";
import { resolveCliOpenAiProviderConfig } from "../localProviderResolver";
import { logLocalRuntimeDiagnostic, summarizeOpenAiToolNames } from "../localRuntimeDiagnostics";
import { fetchWithTransientRetry } from "../localRuntimeFetchRetry";
import { resolveProviderOpenAiToolBundle } from "../localRuntimeTools";
import { asOptionalTrimmedString } from "../../../core/optionalString";
import { summarizeEndpoint } from "../../../core/summarizeEndpoint";
import type { ProviderResolver } from "./providerResolutionContext";

export const resolveDirectOpenAiCompatibleTransport: ProviderResolver = async (ctx) => {
  const { agentConfig, deps, fetchImpl, loopbackRequest, additionalToolNames, buildProviderOpenAiTools, recordLocalAvailability, apiKeyRefResolver, credentialBroker, syncFetcher, serverUrl, authToken } = ctx;

  const providerConfig = await resolveCliOpenAiProviderConfig({
    agentConfig,
    env: deps.env,
    apiKeyRefResolver,
    credentialBroker,
    syncFetcher,
  });
  // OAuth provider 的 access token 可能短于一次工具循环的时长。
  // 把 token 解析下沉到每次请求，而不是固化在 providerConfig 里。
  // 非 OAuth ref（broker 的 api-key:*）resolver 会返回 null，回落到已解析的 key。
  const oauthApiKeyRef = asOptionalTrimmedString(agentConfig.apiKeyRef);
  // 不要 catch：resolver 只在「凭证存在、已过期、且刷不动」时抛错，此时旧 token
  // 必定也是死的，吞掉异常只会把「Run `nolo auth <provider>`」这句可执行的指引
  // 降级成一句无信息量的 HTTP 401。非 OAuth ref 走的是 return null，不是抛错。
  const resolveRequestApiKey = oauthApiKeyRef
    ? (opts: { force: boolean }) =>
        apiKeyRefResolver(oauthApiKeyRef, { force: opts.force })
    : undefined;
  logLocalRuntimeDiagnostic("provider.selected", {
    agentKey: agentConfig.key,
    transport: "direct-openai-compatible",
    apiSource: agentConfig.apiSource ?? null,
    provider: providerConfig.provider,
    model: providerConfig.model,
    endpoint: summarizeEndpoint(providerConfig.endpoint) ?? null,
    hasApiKey: Boolean(providerConfig.apiKey),
    apiKeyHeader: providerConfig.apiKeyHeader ?? null,
    useServerProxy: agentConfig.useServerProxy ?? null,
    customProviderEndpoint:
      summarizeEndpoint(agentConfig.customProviderUrl) ?? null,
  });
  const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
    agentConfig,
    deps.env,
    buildProviderOpenAiTools,
    additionalToolNames,
  );
  return {
    model: providerConfig.model,
    complete: async (messages, options) => {
      const stream = Boolean(options?.onTextDelta);
      const inlinedMessages = (
        await inlineImageUrlsForCustomProvider(
          { messages },
          {
            shouldInline: true,
            isAllowedImageUrl: (url) => {
              try {
                return new URL(url).origin === new URL(serverUrl).origin;
              } catch {
                return false;
              }
            },
            fetchImage: async (url) => {
              const response = await fetchImpl(url, {
                headers: authToken
                  ? { Authorization: `Bearer ${authToken}` }
                  : undefined,
              });
              if (!response.ok) {
                return { ok: false, error: `HTTP ${response.status}` };
              }
              return {
                ok: true,
                mimeType:
                  response.headers.get("content-type") ??
                  "application/octet-stream",
                bytes: new Uint8Array(await response.arrayBuffer()),
              };
            },
          },
        ) as { messages: typeof messages }
      ).messages;
      logLocalRuntimeDiagnostic("provider.request.start", {
        agentKey: agentConfig.key,
        transport: "direct-openai-compatible",
        requestUrl: summarizeEndpoint(providerConfig.endpoint) ?? null,
        model: providerConfig.model,
        messageCount: messages.length,
        toolCount: tools.length,
        requestedToolNames,
        openAiToolNames: summarizeOpenAiToolNames(tools),
        stream,
      });
      const result = await executeOpenAiCompatibleChatCompletion({
        providerConfig,
        messages: inlinedMessages,
        tools,
        fetchImpl: (url: string | URL | Request, init?: RequestInit) =>
          fetchWithTransientRetry(fetchImpl, url, init, {
            sleep: deps.sleep,
            loopbackRequest,
          }),
        stream,
        onTextDelta: options?.onTextDelta,
        onHttpResult: ({ status, body }) =>
          recordLocalAvailability(status, body),
        ...(resolveRequestApiKey ? { resolveApiKey: resolveRequestApiKey } : {}),
      });
      logLocalRuntimeDiagnostic("provider.request.result", {
        agentKey: agentConfig.key,
        transport: "direct-openai-compatible",
        ok: true,
        stream,
        contentChars: result.content.length,
        toolCallCount: result.tool_calls?.length ?? 0,
      });
      return result;
    },
  };
};
