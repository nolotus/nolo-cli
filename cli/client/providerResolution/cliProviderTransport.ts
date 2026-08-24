/**
 * transport 分支：本地 CLI 子进程（claude / codex / gemini CLI 等）
 *
 * 由 localRuntimeAdapter 原先 940 行的 resolveProviderBase 拆出，逻辑逐字保留。
 * 未命中本通道返回 null，交给 resolveLocalProvider 链上的下一条。
 */
import { CliProviderQuotaError, executeCli as defaultExecuteCli } from "../../../ai/agent/cliExecutor";
import { buildPromptForCliProvider, collectCliProviderImageInputs, isCliProviderAgent, resolveCliProviderName } from "../cliProviderHelpers";
import { logLocalRuntimeDiagnostic } from "../localRuntimeDiagnostics";
import { toErrorMessage } from "../../../core/errorMessage";
import type { CliImageInput, LocalCliExecutor } from "../localRuntimeAdapter";
import type { ProviderResolver } from "./providerResolutionContext";

export const resolveCliProviderTransport: ProviderResolver = async (ctx) => {
  const { agentConfig, deps, workspaceRoot } = ctx;
  if (isCliProviderAgent(agentConfig)) {
    const provider = resolveCliProviderName(agentConfig);
    logLocalRuntimeDiagnostic("provider.selected", {
      agentKey: agentConfig.key,
      transport: "local-cli",
      apiSource: agentConfig.apiSource ?? null,
      provider,
      model: agentConfig.model ?? null,
      cwd: workspaceRoot,
    });
    return {
      model: agentConfig.model || provider,
      complete: async (messages, options) => {
        const executeCli =
          deps.executeCli ?? (defaultExecuteCli as LocalCliExecutor);
        const imageUrls = collectCliProviderImageInputs(messages);
        const imageInputs: CliImageInput[] | undefined =
          imageUrls.length > 0
            ? imageUrls.map((url) => ({ source: url }))
            : undefined;
        const prompt = buildPromptForCliProvider(messages);
        try {
          const reasoningEffortRaw = agentConfig.reasoning_effort;
          const reasoningEffort =
            reasoningEffortRaw === "low" ||
            reasoningEffortRaw === "medium" ||
            reasoningEffortRaw === "high" ||
            reasoningEffortRaw === "xhigh" ||
            reasoningEffortRaw === "max"
              ? reasoningEffortRaw
              : undefined;
          const result = await executeCli(provider, prompt, {
            ...(agentConfig.model ? { model: agentConfig.model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(typeof options?.timeoutMs === "number"
              ? { timeout: options.timeoutMs }
              : {}),
            cwd: workspaceRoot,
            yolo: true,
            env: deps.env,
            ...(imageInputs ? { imageInputs } : {}),
          });
          return {
            content: result.text,
            model: agentConfig.model || provider,
            raw: result.raw,
          };
        } catch (error) {
          // 保留配额限额错误，让上层（派发者 / supervisor / PM fallback）能快速识别并换另一个 agent 重派
          if (error instanceof CliProviderQuotaError) {
            throw error;
          }
          const message = toErrorMessage(error);
          throw new Error(
            `Local CLI provider "${provider}" is unavailable or failed: ${message}`,
          );
        }
      },
    };
  }
  return null;
};
