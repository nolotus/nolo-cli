/**
 * transport 分支：平台代理（nolo server 中转）
 *
 * 由 localRuntimeAdapter 原先 940 行的 resolveProviderBase 拆出，逻辑逐字保留。
 * 未命中本通道返回 null，交给 resolveLocalProvider 链上的下一条。
 */
import { buildPlatformChatCompletionRequest, parsePlatformChatCompletionData, parsePlatformChatCompletionResponse, readPlatformChatSseCompletion, resolvePlatformChatProviderConfig, shouldUsePlatformChatProvider } from "../../agentRuntimeLocal";
import { logLocalRuntimeDiagnostic, summarizeOpenAiToolNames } from "../localRuntimeDiagnostics";
import { fetchWithTransientRetry } from "../localRuntimeFetchRetry";
import { resolveProviderOpenAiToolBundle } from "../localRuntimeTools";
import { summarizeEndpoint } from "../../core/summarizeEndpoint";
import { join } from "node:path";
import type { ProviderResolver } from "./providerResolutionContext";

export async function shouldRetryPlatformProxyResponse(
  response: Response,
): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const body = (await response.clone().json()) as {
      reason?: unknown;
    };
    return body?.reason === "core_draining";
  } catch {
    return false;
  }
}

export const resolvePlatformProxyTransport: ProviderResolver = async (ctx) => {
  const { agentConfig, deps, fetchImpl, loopbackRequest, additionalToolNames, buildProviderOpenAiTools, recordLocalAvailability, apiKeyRefResolver, credentialBroker, syncFetcher, serverUrl, authToken } = ctx;
  if (shouldUsePlatformChatProvider(deps.env, agentConfig)) {
    const providerConfig = await resolvePlatformChatProviderConfig({
      agentConfig,
      env: deps.env,
      apiKeyRefResolver,
      credentialBroker,
      syncFetcher,
    });
    logLocalRuntimeDiagnostic("provider.selected", {
      agentKey: agentConfig.key,
      transport: "platform-proxy",
      apiSource: agentConfig.apiSource ?? null,
      provider: providerConfig.provider,
      model: providerConfig.model,
      endpoint: summarizeEndpoint(providerConfig.endpoint) ?? null,
      proxyServer: summarizeEndpoint(providerConfig.serverUrl) ?? null,
      hasAuthToken: Boolean(providerConfig.authToken),
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
        const usesResponsesApi =
          providerConfig.endpoint.includes("/responses");
        // Streaming is a client/runtime capability, not a property of the
        // selected upstream wire. Nolo may switch Responses ↔ Chat Completions
        // behind an older TUI during a rollout; request SSE in either case and
        // route each frame by its actual payload shape in the shared parser.
        const stream = Boolean(options?.onTextDelta);
        const request = buildPlatformChatCompletionRequest({
          providerConfig,
          messages,
          tools,
          stream,
          ...(options?.dialogId ? { dialogId: options.dialogId } : {}),
        });
        logLocalRuntimeDiagnostic("provider.request.start", {
          agentKey: agentConfig.key,
          transport: "platform-proxy",
          requestUrl: summarizeEndpoint(request.url) ?? null,
          endpoint: summarizeEndpoint(providerConfig.endpoint) ?? null,
          model: providerConfig.model,
          messageCount: messages.length,
          toolCount: tools.length,
          requestedToolNames,
          openAiToolNames: summarizeOpenAiToolNames(tools),
          stream,
        });
        let res = await fetchWithTransientRetry(
          fetchImpl,
          request.url,
          {
            ...request.init,
          },
          {
            sleep: deps.sleep,
            loopbackRequest,
            // A chat POST is not safe to replay after an ambiguous network or
            // gateway failure: the server/provider may already have accepted
            // it. The client only waits through the server's explicit pre-
            // admission deployment drain signal.
            retryableStatuses: new Set([503]),
            shouldRetryResponse: shouldRetryPlatformProxyResponse,
            retryNetworkErrors: false,
            onRetry: deps.activityReporter
              ? ({ attempt, maxAttempts, delayMs }) => {
                  deps.activityReporter!(
                    `自动重试 ${attempt}/${maxAttempts} · ${Math.ceil(delayMs / 1000)}s`,
                  );
                }
              : undefined,
          },
        );
        if (!res.ok) {
          const raw = await res.text().catch(() => "");
          const data = parsePlatformChatCompletionData(raw);
          await recordLocalAvailability(res.status, data);
          // `JSON.stringify(data)` collapses an empty/HTML/Cloudflare body into
          // `{}`, which is ambiguous and forces a long post-hoc investigation.
          // Carry the raw body (truncated) + gateway-revealing headers so the
          // next 502 self-documents its origin:
          //   - empty body + server: Caddy     -> gateway / origin unreachable
          //   - {"error":{code:"UPSTREAM_*"}} -> nolo app layer (upstream deepseek)
          //   - HTML "502 Bad Gateway"         -> CDN / reverse proxy
          const rawPreview =
            raw.length > 200 ? `${raw.slice(0, 200)}…(${raw.length}b)` : raw;
          const gatewayHeaders = [
            "server",
            "cf-ray",
            "cf-cache-status",
            "content-length",
          ]
            .map((h) => {
              const v = res.headers.get(h);
              return v ? `${h}=${v}` : null;
            })
            .filter(Boolean)
            .join(" ");
          throw new Error(
            `platform provider failed: HTTP ${res.status} ${JSON.stringify(data)}` +
              (rawPreview ? ` raw="${rawPreview}"` : "") +
              (gatewayHeaders ? ` headers=[${gatewayHeaders}]` : ""),
          );
        }
        await recordLocalAvailability(res.status);
        const contentType = res.headers.get("content-type") ?? "";
        const shouldStream =
          Boolean(stream && options?.onTextDelta) &&
          contentType.includes("text/event-stream");
        if (shouldStream && options?.onTextDelta) {
          const streamed = await readPlatformChatSseCompletion({
            response: res,
            usesResponsesApi,
            onTextDelta: options.onTextDelta,
            onReasoningDelta: options.onReasoningDelta,
          });
          logLocalRuntimeDiagnostic("provider.request.result", {
            agentKey: agentConfig.key,
            transport: "platform-proxy",
            ok: true,
            stream: true,
            contentChars: streamed.content.length,
            toolCallCount: streamed.tool_calls?.length ?? 0,
          });
          return {
            content: streamed.content,
            model: providerConfig.model,
            provider: providerConfig.provider,
            ...(streamed.tool_calls
              ? { tool_calls: streamed.tool_calls }
              : {}),
            ...(streamed.reasoning_content
              ? { reasoning_content: streamed.reasoning_content }
              : {}),
            ...(streamed.usage ? { usage: streamed.usage } : {}),
            ...(streamed.finish_reason
              ? { finish_reason: streamed.finish_reason }
              : {}),
            ...(streamed.stream_complete
              ? { stream_complete: streamed.stream_complete }
              : {}),
            trace: messages,
          };
        }
        const raw = await res.text().catch(() => "");
        logLocalRuntimeDiagnostic("provider.request.result", {
          agentKey: agentConfig.key,
          transport: "platform-proxy",
          status: res.status,
          ok: res.ok,
          responseBytes: raw.length,
        });
        const data = parsePlatformChatCompletionData(raw);
        return parsePlatformChatCompletionResponse({
          providerConfig,
          data,
          trace: messages,
        });
      },
    };
  }
  return null;
};
