import { TokenUsageData } from "../../../ai/token/types";
import { DataType } from "../../../create/types";
import { createTokenStatsKey } from "../../../database/keys";
import { ulid } from "ulid";
import { format } from "date-fns";
import { patch, read, selectById, write } from "../../../database/dbSlice";
import { toast } from "../../../app/utils/toast";
import {
  createTokenRecord,
  saveTokenRecord,
  ModelStats,
} from "../../../ai/token/saveTokenRecord";
import { pino } from "pino";
import { deductBalance } from "../../../auth/authSlice"; // <--- 1. 导入新的 deductBalance action
import { prepareTokenUsageData } from "../../../ai/token/prepareTokenUsageData";

const logger = pino({ name: "token-usage", level: "info" });
const dialogTokenPatchQueue = new Map<string, Promise<void>>();

interface DayStats {
  userId: string;
  period: "day";
  timeKey: string;
  total: ModelStats;
  models: Record<string, ModelStats>;
  providers: Record<string, ModelStats>;
}

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

const updateStatsCounter = (
  data: TokenUsageData,
  stats: ModelStats = { count: 0, tokens: { input: 0, output: 0 }, cost: 0 }
): ModelStats => ({
  count: stats.count + 1,
  tokens: {
    input: stats.tokens.input + data.input_tokens,
    output: stats.tokens.output + data.output_tokens,
  },
  cost: stats.cost + data.cost,
});

const updateStats = async (
  data: TokenUsageData,
  existingStats: DayStats | null,
  key: string,
  thunkApi
) => {
  try {
    const stats = existingStats ?? {
      userId: data.userId,
      period: "day",
      timeKey: format(Date.now(), "yyyy-MM-dd"),
      total: { count: 0, tokens: { input: 0, output: 0 }, cost: 0 },
      models: {},
      providers: {},
    };

    const modelName = data.model || "unknown";
    const providerName = data.provider || "unknown";

    const cleanModels = Object.fromEntries(
      Object.entries(stats.models).filter(
        ([key]) => !["unknown", "undefined"].includes(key)
      )
    );

    const updatedStats = {
      ...stats,
      total: updateStatsCounter(data, stats.total),
      models: {
        ...cleanModels,
        [modelName]: updateStatsCounter(data, cleanModels[modelName]),
      },
      providers: {
        ...stats.providers,
        [providerName]: updateStatsCounter(data, stats.providers[providerName]),
      },
    };

    await thunkApi.dispatch(
      write({
        data: { ...updatedStats, id: key, type: DataType.TOKEN },
        customKey: key,
      })
    );

    return updatedStats;
  } catch (error) {
    logger.error(
      { key, userId: data.userId, error: error.message },
      "Failed to update token stats"
    );
    toast.error("Failed to update token stats");
    throw error;
  }
};

export const saveTokenUsage = async (data: TokenUsageData, thunkApi) => {
  const dateKey = format(Date.now(), "yyyy-MM-dd");
  const tokenDayStatsKey = createTokenStatsKey(data.userId, dateKey);
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
  } catch (error) {
    logger.error(
      {
        key,
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
};

export const updateTokensAction = async (
  { dialogId, dialogKey, usage: usageRaw, agentConfig },
  thunkApi
) => {
  const { currentUser } = thunkApi.getState().auth;
  const timestamp = Date.now();
  const prepared = prepareTokenUsageData({
    rawUsage: usageRaw,
    agentConfig,
    userId: currentUser?.userId,
    username: currentUser?.username,
    cybotId: agentConfig.id,
    dialogId,
    timestamp,
  });
  const { usage, tokenData } = prepared;
  const result = { cost: tokenData.cost, pay: tokenData.pay };

  const persistedTokenData: TokenUsageData = {
    ...tokenData,
    type: DataType.TOKEN,
    id: ulid(timestamp),
    dateKey: format(timestamp, "yyyy-MM-dd"),
  };

  const record = createTokenRecord(persistedTokenData, {
    cost: result.cost,
    inputPrice: agentConfig.inputPrice,
    outputPrice: agentConfig.outputPrice,
  });


  await saveTokenRecord(persistedTokenData, record, thunkApi);
  await saveTokenUsage(persistedTokenData, thunkApi);

  if (result.cost > 0) {
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
