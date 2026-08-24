/**
 * transport 分支：Cursor Connect
 *
 * 由 localRuntimeAdapter 原先 940 行的 resolveProviderBase 拆出，逻辑逐字保留。
 * 未命中本通道返回 null，交给 resolveLocalProvider 链上的下一条。
 */
import type { AgentRuntimeResult, AgentRuntimeToolCallInput } from "../../../agent-runtime";
import { createCursorProvider, isCursorOAuthAgent } from "../../../agent-runtime/cursor/cursorProvider";
import { resolveExecShellDetachMs } from "../cliLocalToolBudget";
import { logLocalRuntimeDiagnostic } from "../localRuntimeDiagnostics";
import { resolveProviderOpenAiToolBundle } from "../localRuntimeTools";
import { executeLocalToolWithPolicy } from "../localToolPolicy";
import type { ProviderResolver } from "./providerResolutionContext";

export const resolveCursorTransport: ProviderResolver = async (ctx) => {
  const { agentConfig, deps, workspaceRoot, additionalToolNames, buildProviderOpenAiTools, apiKeyRefResolver, activeAgentToolNames, localToolExecutors } = ctx;
  // Cursor OAuth uses a bespoke ConnectRPC + protobuf wire (HTTP/2 to
  // api2.cursor.sh), not OpenAI-compatible chat.completions. Route through
  // the dedicated cursorProvider which translates nolo messages to the
  // AgentRunRequest protobuf and streams AgentServerMessage frames.
  if (isCursorOAuthAgent(agentConfig)) {
    const accessToken = await apiKeyRefResolver("cursor");
    if (!accessToken) {
      throw new Error(
        'OAuth credential for "cursor" not found locally. Run `nolo auth cursor`.',
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
      transport: "cursor-connect",
      provider: "cursor",
      model: agentConfig.model ?? "cursor-default",
      hasApiKey: true,
    });
    // Build a cursor-internal executeTool that reuses the same policy +
    // executors as the host adapter's executeTool. Cursor drives its own
    // inline exec loop (sync, in-stream), so we give it the same local
    // tool executors rather than routing back through localLoop.
    const cursorExecuteTool = async (call: AgentRuntimeToolCallInput) => {
      const result = await executeLocalToolWithPolicy({
        env: deps.env,
        agentToolNames: activeAgentToolNames,
        call,
        executors: localToolExecutors,
        detachMs: resolveExecShellDetachMs(deps.env),
        ...(deps.confirmDestructiveAction
          ? { confirmDestructiveAction: deps.confirmDestructiveAction }
          : {}),
      });
      return {
        content: result.content,
        metadata: {
          ...(result.metadata ?? {}),
          workspaceRoot,
          workspaceKind: "current",
        },
      };
    };
    const cursorProvider = createCursorProvider({
      accessToken,
      model: agentConfig.model || "cursor-default",
      systemPrompt: agentConfig.prompt?.trim() || undefined,
      tools,
      executeTool: cursorExecuteTool,
    });
    // cursorProvider.complete already returns AgentRuntimeResult; wrap to
    // attach tool surface diagnostics for parity with other providers.
    return {
      model: agentConfig.model || "cursor-default",
      complete: async (messages, options) => {
        logLocalRuntimeDiagnostic("provider.request.start", {
          agentKey: agentConfig.key,
          transport: "cursor-connect",
          model: agentConfig.model ?? "cursor-default",
          messageCount: messages.length,
          toolCount: tools.length,
          requestedToolNames,
        });
        const result = await cursorProvider.complete(messages, options);
        logLocalRuntimeDiagnostic("provider.request.result", {
          agentKey: agentConfig.key,
          transport: "cursor-connect",
          ok: true,
          contentChars: (result.content ?? "").length,
          toolCallCount: result.tool_calls?.length ?? 0,
        });
        return result;
      },
    };
  }
  return null;
};
