import type { RootState } from "../../app/store";
import type { DialogConfig } from "../../app/types";
import { patch, read, write } from "../../database/dbSlice";
import { DataType } from "../../create/types";
import { createDialogMessageKeyAndId } from "../../database/keys";
import { streamAgentChatTurn } from "../agent/agentSlice";
import { createDialog } from "../../chat/dialog/dialogSlice";
import { serializeMessageContent } from "../../chat/messages/messageContent";
import { addToolMessage, selectAllMsgs } from "../../chat/messages/messageSlice";
import type { Message } from "../../chat/messages/types";
import { extractCustomId } from "../../core/prefix";
import {
  calculateParallelBranchPricing,
  summarizeParallelBudget,
  summarizeParallelCosts,
  type ParallelBudgetSummary,
} from "../tools/agent/parallelBudget";

type ParallelDisplayMode = "inline" | "folded";

function getBranchFinalContent(
  messages: Message[],
  options: {
    agentKey: string;
    parallelSessionId?: string;
    parallelBranchId?: string;
  }
) {
  const { agentKey, parallelSessionId, parallelBranchId } = options;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (parallelSessionId && message.parallelSessionId !== parallelSessionId) continue;
    if (parallelBranchId && message.parallelBranchId !== parallelBranchId) continue;
    if (message.agentKey !== agentKey && message.cybotKey !== agentKey) continue;

    const content = serializeMessageContent(message.content);
    if (content) {
      return { content, messageId: message.id };
    }
  }

  return null;
}

async function persistInlineBranchMessage(options: {
  dispatch: any;
  parentDialogId: string;
  agentKey: string;
  agentName: string;
  content: string;
  parallelSessionId: string;
  parallelBranchId: string;
  parallelLabel: string;
  parallelIndex: number;
}) {
  const {
    dispatch,
    parentDialogId,
    agentKey,
    agentName,
    content,
    parallelSessionId,
    parallelBranchId,
    parallelLabel,
    parallelIndex,
  } = options;
  const { key: dbKey, messageId } = createDialogMessageKeyAndId(parentDialogId);
  const mirroredMessage: Message & { dialogId?: string } = {
    id: messageId,
    dbKey,
    dialogId: parentDialogId,
    role: "assistant",
    content,
    agentKey,
    cybotKey: agentKey,
    agentName,
    isStreaming: false,
    parallelSessionId,
    parallelBranchId,
    parallelLabel,
    parallelIndex,
  };

  dispatch(addToolMessage(mirroredMessage));
  await dispatch(
    write({
      data: {
        ...mirroredMessage,
        type: DataType.MSG,
      },
      customKey: dbKey,
    })
  );

  return {
    parentMessageId: messageId,
    parentMessageKey: dbKey,
  };
}

export async function startParallelAgentStreams(options: {
  task: string;
  agents: Array<{ agentKey: string; label?: string; branchId?: string; serverBase?: string }>;
  dispatch: any;
  getState: () => RootState;
  dialogId?: string;
  dialogKey?: string;
  waitForCompletion?: boolean;
  displayMode?: ParallelDisplayMode;
  budgetCredits?: number;
}) {
  const {
    task,
    agents,
    dispatch,
    getState,
    dialogId,
    dialogKey,
    waitForCompletion = false,
    budgetCredits,
  } = options;
  const parallelSessionId = `parallel-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const parentDialogId = dialogKey ? extractCustomId(dialogKey) : null;
  const effectiveDisplayMode: ParallelDisplayMode = "inline";

  const branches = await Promise.all(
    agents.map(async (agent, index) => {
      const branchId = agent.branchId?.trim() || `branch-${index + 1}`;
      const config = await dispatch(read({ dbKey: agent.agentKey })).unwrap();
      const label =
        agent.label?.trim() ||
        (typeof config?.name === "string" && config.name.trim()) ||
        `Agent ${index + 1}`;

      return {
        agentKey: agent.agentKey,
        ...(typeof agent.serverBase === "string" && agent.serverBase.trim()
          ? { serverBase: agent.serverBase.trim() }
          : {}),
        parallelBranchId: branchId,
        parallelLabel: label,
        parallelIndex: index,
        agentRecordId: typeof config?.dbKey === "string" ? config.dbKey : agent.agentKey,
        model: typeof config?.model === "string" ? config.model : null,
        provider: typeof config?.provider === "string" ? config.provider : null,
        inputPrice:
          typeof config?.inputPrice === "number" && Number.isFinite(config.inputPrice)
            ? config.inputPrice
            : null,
        outputPrice:
          typeof config?.outputPrice === "number" && Number.isFinite(config.outputPrice)
            ? config.outputPrice
            : null,
      };
    })
  );

  const branchTaskPreview = task.replace(/\s+/g, " ").trim().slice(0, 36);
  const useChildDialogs = waitForCompletion && !!dialogKey;

  const branchesWithTargets = await Promise.all(
    branches.map(async (branch) => {
      if (!useChildDialogs) {
        return branch;
      }

      const childTitle =
        branchTaskPreview.length > 0
          ? `${branch.parallelLabel} · ${branchTaskPreview}`
          : branch.parallelLabel;

      const created = (await dispatch(
        createDialog({
          cybots: [branch.agentKey],
          title: childTitle,
          inheritFromDialogKey: dialogKey,
          skipGreeting: true,
        })
      ).unwrap()) as DialogConfig;

      if (created?.dbKey && parentDialogId) {
        await dispatch(
          patch({
            dbKey: created.dbKey,
            changes: {
              parentDialogId,
            },
          })
        )
          .unwrap()
          .catch(() => null);
      }

      return {
        ...branch,
        childDialogKey: created?.dbKey,
        childDialogId: created?.dbKey ? extractCustomId(created.dbKey) : undefined,
        childSpaceId: created?.spaceId,
      };
    })
  );

  if (!waitForCompletion) {
    for (const branch of branchesWithTargets) {
      void dispatch(
        streamAgentChatTurn({
          agentKey: branch.agentKey,
          userInput: task,
          ...(branch.serverBase ? { serverBase: branch.serverBase } : {}),
          ...(dialogKey ? { dialogKey } : {}),
          runtimeOptions: {
            parallelSessionId,
            parallelBranchId: branch.parallelBranchId,
            parallelLabel: branch.parallelLabel,
            parallelIndex: branch.parallelIndex,
          },
        })
      );
    }

    return {
      displayMode: effectiveDisplayMode,
      parallelSessionId,
      branches: branchesWithTargets,
    };
  }

  const results = await Promise.all(
    branchesWithTargets.map(async (branch) => {
      try {
        const targetDialogKey = branch.childDialogKey || dialogKey;
        const targetDialogId = branch.childDialogId || dialogId;
        const branchTurn = await dispatch(
          streamAgentChatTurn({
            agentKey: branch.agentKey,
            userInput: task,
            ...(branch.serverBase ? { serverBase: branch.serverBase } : {}),
            ...(targetDialogKey ? { dialogKey: targetDialogKey } : {}),
            ...(!branch.childDialogKey
              ? {
                  runtimeOptions: {
                    parallelSessionId,
                    parallelBranchId: branch.parallelBranchId,
                    parallelLabel: branch.parallelLabel,
                    parallelIndex: branch.parallelIndex,
                  },
                }
              : {}),
          })
        ).unwrap();

        if (!targetDialogId) {
          return {
            ok: false,
            label: branch.parallelLabel,
            branchId: branch.parallelBranchId,
            parallelSessionId,
            parallelIndex: branch.parallelIndex,
            agentKey: branch.agentKey,
            dialogKey: targetDialogKey ?? null,
            dialogId: targetDialogId ?? null,
            model: branch.model,
            error: "missing dialogId for parallel result collection",
            spentCredits: null,
          };
        }

        const finalMessage = getBranchFinalContent(
          selectAllMsgs(getState(), targetDialogId) as Message[],
          branch.childDialogKey
            ? {
                agentKey: branch.agentKey,
              }
            : {
                parallelSessionId,
                parallelBranchId: branch.parallelBranchId,
                agentKey: branch.agentKey,
              }
        );

        if (!finalMessage?.content) {
          return {
            ok: false,
            label: branch.parallelLabel,
            branchId: branch.parallelBranchId,
            parallelSessionId,
            parallelIndex: branch.parallelIndex,
            agentKey: branch.agentKey,
            dialogKey: targetDialogKey ?? null,
            dialogId: targetDialogId ?? null,
            spaceId: branch.childSpaceId ?? null,
            model: branch.model,
            error: "branch completed without assistant content",
            spentCredits: null,
          };
        }

        const inlineProjection =
          effectiveDisplayMode === "inline" && parentDialogId
            ? await persistInlineBranchMessage({
                dispatch,
                parentDialogId,
                agentKey: branch.agentKey,
                agentName: branch.parallelLabel,
                content: finalMessage.content,
                parallelSessionId,
                parallelBranchId: branch.parallelBranchId,
                parallelLabel: branch.parallelLabel,
                parallelIndex: branch.parallelIndex,
              })
            : null;
        const pricing = calculateParallelBranchPricing({
          usage: branchTurn?.usage,
          agentKey: branch.agentKey,
          dialogId: targetDialogId ?? null,
          agentConfig: {
            id: branch.agentRecordId,
            model: branch.model,
            provider: branch.provider,
            inputPrice: branch.inputPrice,
            outputPrice: branch.outputPrice,
          },
        });

        return {
          ok: true,
          label: branch.parallelLabel,
          branchId: branch.parallelBranchId,
          parallelSessionId,
          parallelIndex: branch.parallelIndex,
          agentKey: branch.agentKey,
          agentName: branch.parallelLabel,
          dialogKey: targetDialogKey ?? null,
          dialogId: targetDialogId ?? null,
          spaceId: branch.childSpaceId ?? null,
          model: branch.model,
          provider: branch.provider,
          content: finalMessage.content,
          messageId: finalMessage.messageId,
          inlineMessageId: inlineProjection?.parentMessageId ?? null,
          inlineMessageKey: inlineProjection?.parentMessageKey ?? null,
          usage: branchTurn?.usage ?? null,
          spentCredits: pricing.spentCredits,
          billedModel: pricing.billedModel,
          billedProvider: pricing.billedProvider,
          billingServiceTier: pricing.billingServiceTier,
          pricingError: pricing.pricingError,
        };
      } catch (error: any) {
        return {
          ok: false,
          label: branch.parallelLabel,
          branchId: branch.parallelBranchId,
          parallelSessionId,
          parallelIndex: branch.parallelIndex,
          agentKey: branch.agentKey,
          dialogKey: branch.childDialogKey ?? dialogKey ?? null,
          dialogId: branch.childDialogId ?? dialogId ?? null,
          spaceId: branch.childSpaceId ?? null,
          model: branch.model,
          provider: branch.provider,
          error: error?.message || String(error),
          spentCredits: null,
        };
      }
    })
  );

  const successful = results.filter((item) => item.ok);
  const failed = results.filter((item) => !item.ok);
  const stats = {
    total: results.length,
    succeeded: successful.length,
    failed: failed.length,
  };
  const costSummary = summarizeParallelCosts(results);
  const budget = summarizeParallelBudget({
    budgetCredits,
    results,
  }) as ParallelBudgetSummary | null;
  const mergedContent = successful
    .map((item) => `## ${item.label}\n\n${item.content || "(无内容)"}`)
    .join("\n\n");
  const failedSummary = failed
    .map((item) => `- ${item.label}: ${item.error || "unknown error"}`)
    .join("\n");
  const llmContext = [
    mergedContent ? `并行分支结果：\n${mergedContent}` : "",
    failedSummary ? `失败分支：\n${failedSummary}` : "",
    costSummary.pricedBranches > 0 || budget
      ? [
          `并行成本：本轮已花费 ${costSummary.spentCredits} 积分。`,
          budget
            ? `预算 ${budget.budgetCredits} 积分，剩余 ${budget.remainingCredits} 积分。`
            : "",
          costSummary.unpricedBranches > 0
            ? `${costSummary.unpricedBranches} 个成功分支缺少精确定价。`
            : "",
          budget?.exhausted
            ? "预算已耗尽，请不要再开启新的并行轮次，直接总结当前共识与分歧。"
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    displayMode: effectiveDisplayMode,
    parallelSessionId,
    branches: branchesWithTargets,
    results,
    stats,
    costSummary,
    ...(budget ? { budget } : {}),
    content: mergedContent,
    llmContext,
  };
}
