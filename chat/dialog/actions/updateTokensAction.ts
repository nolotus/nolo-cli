import { TokenUsageData } from "../../../ai/token/types";
import { DataType } from "../../../create/types";
import { createTokenKey, createTokenStatsKey } from "../../../database/keys";
import { ulid } from "ulid";
import { format } from "date-fns";
import { patch, read, selectById, write } from "../../../database/dbSlice";
import { toast } from "../../../app/utils/toast";
import {
  createTokenRecord,
  saveTokenRecord,
} from "../../../ai/token/saveTokenRecord";
import { createClientLogger } from "../../../core/clientLogger";
import { deductBalance } from "identity/actions"; // <--- 1. 导入新的 deductBalance action
import { prepareTokenUsageData } from "../../../ai/token/prepareTokenUsageData";
import { findModelConfig } from "../../../ai/llm/providers";
import { resolveMessageOwner } from "../../messages/resolveMessageOwner";
import { applyTokenUsageToDayStats, type DayStats } from "../../../ai/token/applyTokenUsageToDayStats";
import { runKeyed } from "../../../core/keyedTaskQueue";

const logger = createClientLogger("token-usage");
const dialogTokenPatchQueue = new Map<string, Promise<void>>();

const queueDialogTokenPatch = async <T>(
  dialogKey: string,
  task: () => Promise<T>
): Promise<T> => {
  const previousTask = dialogTokenPatchQueue.get(dialogKey) ?? Promise.resolve();
  const nextTask = previousTask.catch(() => undefined).then(task);
  const queueEntry = nextTask.then(
    () => undefined,
    () => undefined
  );

  dialogTokenPatchQueue.set(dialogKey, queueEntry);

  try {
    return await nextTask;
  } finally {
    if (dialogTokenPatchQueue.get(dialogKey) === queueEntry) {
      dialogTokenPatchQueue.delete(dialogKey);
    }
  }
};

const updateStats = async (
  data: TokenUsageData,
  existingStats: DayStats | null,
  key: string,
  thunkApi: any
) => {
  try {
    const dateKey = format(data.timestamp ?? Date.now(), "yyyy-MM-dd");
    const newStats = applyTokenUsageToDayStats(existingStats, {
      userId: data.userId ?? "",
      timeKey: dateKey,
      model: data.model || "unknown",
      provider: data.provider || "unknown",
      input_tokens: data.input_tokens,
      output_tokens: data.output_tokens,
      cost: data.cost,
    });

    await (thunkApi.dispatch(
      write({
        data: { ...newStats, id: key, type: DataType.TOKEN },
        customKey: key,
        userId: data.userId,
      })
    ) as any).unwrap();

    return newStats;
  } catch (error) {
    logger.error(
      { key, userId: data.userId, error: (error as any).message },
      "Failed to update token stats"
    );
    toast.error("Failed to update token stats");
    throw error;
  }
};

export const saveTokenUsage = async (data: TokenUsageData, thunkApi: any) => {
  // 用 data.timestamp（而非 Date.now()）取 dateKey，与 updateStats 内的
  // timeKey 计算保持一致，避免零点交界处 DB Key 与 Payload timeKey 错配。
  const dateKey = format(data.timestamp ?? Date.now(), "yyyy-MM-dd");
  const tokenDayStatsKey = createTokenStatsKey(data.userId ?? "", dateKey);
  // per-key 串行队列防止并发 read-modify-write 丢失增量（与服务端 runKeyed 对齐）
  return runKeyed(tokenDayStatsKey, async () => {
    try {
      let currentStats = null;
      try {
        currentStats = await thunkApi.dispatch(read({
          dbKey: tokenDayStatsKey
        })).unwrap();
      } catch (err) {
        logger.warn({ tokenDayStatsKey }, "No existing stats found");
      }

      const updatedStats = await updateStats(
        data,
        currentStats,
        tokenDayStatsKey,
        thunkApi
      );

      return {
        success: true,
        id: ulid(Date.now()),
        record: updatedStats,
      };
    } catch (error: any) {
      logger.error(
        {
          key: tokenDayStatsKey,
          userId: data.userId,
          error: error.message,
          tokenData: {
            input: data.input_tokens,
            output: data.output_tokens,
            model: data.model,
          },
        },
        "Failed to process token usage"
      );

      toast.error("Failed to process token usage");
      throw error;
    }
  });
};

export const updateTokensAction = async (
  { dialogId, dialogKey, usage: legacyUsage, usageRecord, agentConfig }: any,
  thunkApi: any
) => {
  const state = thunkApi.getState();
  const { currentUser } = state.auth;
  // Same owner priority as message writes (resolveMessageOwner): dialog
  // config → dialog key (dialog-local-*) → account → "local". Logged-out
  // local dialogs produce token-local-* / token-stats-day-user-local-* and
  // hit the shared device-local no-replication boundary.
  const dialogConfig = dialogKey ? selectById(state, dialogKey) : null;
  const dialogConfigUserId = (dialogConfig as { userId?: unknown } | null)
    ?.userId;
  const ownerUserId = resolveMessageOwner({
    dialogConfigUserId:
      typeof dialogConfigUserId === "string" ? dialogConfigUserId : null,
    dialogKey: typeof dialogKey === "string" ? dialogKey : "",
    currentAccountUserId: currentUser?.userId ?? null,
  });
  const timestamp = Date.now();
  const callId = typeof usageRecord?.callId === "string" && usageRecord.callId
    ? usageRecord.callId
    : undefined;
  const usageRaw = usageRecord?.usage ?? legacyUsage;
  const usageWithStableCallId = callId && !usageRaw?.provider_call_id
    ? { ...usageRaw, provider_call_id: callId }
    : usageRaw;
  const callAgentConfig = {
    ...agentConfig,
    ...(typeof usageRecord?.model === "string" ? { model: usageRecord.model } : {}),
    ...(typeof usageRecord?.provider === "string" ? { provider: usageRecord.provider } : {}),
  };
  const prepared = prepareTokenUsageData({
    rawUsage: usageWithStableCallId,
    agentConfig: callAgentConfig,
    userId: ownerUserId,
    username: currentUser?.username,
    agentId: agentConfig.id,
    dialogId,
    timestamp,
    entry_path: "web-chat",
  });
  const { usage, tokenData, recordProvider, billedModel } = prepared;
  const result = { cost: tokenData.cost, pay: tokenData.pay };

  const persistedTokenData = {
    ...tokenData,
    type: DataType.TOKEN,
    id: ulid(timestamp),
    dateKey: format(timestamp, "yyyy-MM-dd"),
    // Keep the same clock used for id/dateKey so record keys never see
    // undefined when a prepare helper omits timestamp.
    timestamp,
  } as TokenUsageData;
  const stableTokenKey = callId
    ? createTokenKey.recordForStableCall(ownerUserId, callId)
    : null;
  const accountingAlreadyProjected = stableTokenKey
    ? Boolean(selectById(state, stableTokenKey))
    : false;

  // Display unit prices for the actually billed provider/model (e.g. Flash
  // fallback → official DeepSeek 1/2), not the agent snapshot that may still
  // carry nolo Ollama list prices after upstream fallback.
  const billedCatalog = findModelConfig(recordProvider, billedModel)?.price;
  const record = createTokenRecord(persistedTokenData, {
    cost: result.cost,
    inputPrice: billedCatalog?.input ?? agentConfig.inputPrice,
    outputPrice: billedCatalog?.output ?? agentConfig.outputPrice,
  });


  await saveTokenRecord(persistedTokenData, record as any, thunkApi, callId);
  // Always retry the detail write: its server handler owns ledger retry.
  // Local day/dialog/live projections, however, are exactly-once per call.
  if (accountingAlreadyProjected) {
    return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cost: result.cost,
    };
  }
  await saveTokenUsage(persistedTokenData, thunkApi);

  if (persistedTokenData.billable === true ||
      (persistedTokenData.billable === undefined && result.cost > 0)) {
    thunkApi.dispatch(deductBalance(result.cost));
  }

  if (dialogKey) {
    await queueDialogTokenPatch(dialogKey, async () => {
      const latestState = thunkApi.getState();
      const dialogConfig =
        selectById(latestState, dialogKey) ??
        await thunkApi.dispatch(read({ dbKey: dialogKey })).unwrap();

      if (!dialogConfig) {
        throw new Error(`Dialog not found for token update: ${dialogKey}`);
      }

      await thunkApi.dispatch(
        patch({
          dbKey: dialogKey,
          changes: {
            inputTokens: (dialogConfig.inputTokens ?? 0) + usage.input_tokens,
            outputTokens: (dialogConfig.outputTokens ?? 0) + usage.output_tokens,
            totalCost: (dialogConfig.totalCost ?? 0) + result.cost,
          },
        })
      ).unwrap();
    });
  }

  // 返回本轮最终记账结果；TopBar 展示由持久化 dialog 统计 + runtime live 增量合并得到
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cost: result.cost,
  };
};
