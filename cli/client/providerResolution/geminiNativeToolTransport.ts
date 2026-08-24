/**
 * transport 分支：Gemini 3 + tools 的 native generateContent 路由（platform proxy 传不了 thought_signature）
 *
 * 由 localRuntimeAdapter 原先 940 行的 resolveProviderBase 拆出，逻辑逐字保留。
 * 未命中本通道返回 null，交给 resolveLocalProvider 链上的下一条。
 */
import type { AgentRuntimeResult } from "../../../agent-runtime";
import { accumulateGeminiChunks, buildGeminiGenerateContentRequest, isGemini3Model, shouldUseGeminiNativeToolRoute } from "../../../agent-runtime/geminiNativeShared";
import { parseSseDataLineJson } from "../../../agent-runtime/sseDataLine";
import { readSseDataValues } from "../../../agent-runtime/sseFrames";
import { resolvePlatformChatProviderConfig, shouldUsePlatformChatProvider } from "../../agentRuntimeLocal";
import { logLocalRuntimeDiagnostic } from "../localRuntimeDiagnostics";
import { resolveProviderOpenAiToolBundle } from "../localRuntimeTools";
import type { ProviderResolver } from "./providerResolutionContext";

export const resolveGeminiNativeToolTransport: ProviderResolver = async (ctx) => {
  const { agentConfig, deps, fetchImpl, additionalToolNames, buildProviderOpenAiTools, apiKeyRefResolver, credentialBroker, syncFetcher } = ctx;
  // Gemini 3 系列 + tools → 走 native generateContent 以支持 thought_signature
  // Platform proxy 的 OpenAI-compatible 路径无法传递 thought_signature
  if (
    shouldUsePlatformChatProvider(deps.env, agentConfig) &&
    isGemini3Model(agentConfig.model ?? "") &&
    agentConfig.provider === "google"
  ) {
    const providerConfig = await resolvePlatformChatProviderConfig({
      agentConfig,
      env: deps.env,
      apiKeyRefResolver,
      credentialBroker,
      syncFetcher,
    });
    const { requestedToolNames, tools } = resolveProviderOpenAiToolBundle(
      agentConfig,
      deps.env,
      buildProviderOpenAiTools,
      additionalToolNames,
    );

    // 只有本地有 API key 时才走 native route；
    // platform agent（无本地 key）由 server 端 chatHandler 的 native 路由处理
    if (
      tools.length > 0 &&
      providerConfig.apiKey &&
      shouldUseGeminiNativeToolRoute(
        agentConfig.provider ?? "",
        agentConfig.model ?? "",
        tools,
        () => false, // CLI 端不区分 image 模型
      )
    ) {
      logLocalRuntimeDiagnostic("provider.selected", {
        agentKey: agentConfig.key,
        transport: "gemini-native-tool",
        apiSource: agentConfig.apiSource ?? null,
        provider: providerConfig.provider,
        model: providerConfig.model,
        hasApiKey: Boolean(providerConfig.apiKey),
      });
      return {
        model: providerConfig.model,
        complete: async (messages, options) => {
          const requestBody = buildGeminiGenerateContentRequest({
            messages: messages as unknown[],
            tools: tools as unknown[],
            maxTokens: typeof agentConfig.max_tokens === "number"
              ? agentConfig.max_tokens
              : undefined,
            temperature: typeof agentConfig.temperature === "number"
              ? agentConfig.temperature
              : undefined,
            attachSkipThoughtSignature: true,
          });

          const model = providerConfig.model;
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;

          logLocalRuntimeDiagnostic("provider.request.start", {
            agentKey: agentConfig.key,
            transport: "gemini-native-tool",
            model,
            messageCount: messages.length,
            toolCount: tools.length,
            requestedToolNames,
          });

          const res = await fetchImpl(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": providerConfig.apiKey ?? "",
            },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(120000),
          });

          if (!res.ok) {
            const errText = await res.text();
            logLocalRuntimeDiagnostic("provider.request.failed", {
              agentKey: agentConfig.key,
              transport: "gemini-native-tool",
              status: res.status,
              error: errText.slice(0, 200),
            });
            throw new Error(
              `gemini native tool provider failed: HTTP ${res.status} ${errText.slice(0, 500)}`,
            );
          }

          const chunks = await readSseDataValues(res, parseSseDataLineJson);
          const { text, toolCalls, usage } = accumulateGeminiChunks(chunks);

          if (text && options?.onTextDelta) {
            options.onTextDelta(text);
          }

          const result: AgentRuntimeResult = {
            content: text,
            model,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            ...(usage ? { usage } : {}),
            trace: messages,
          };
          logLocalRuntimeDiagnostic("provider.request.result", {
            agentKey: agentConfig.key,
            transport: "gemini-native-tool",
            ok: true,
            contentChars: text.length,
            toolCallCount: toolCalls.length,
          });
          return result;
        },
      };
    }
  }
  return null;
};
