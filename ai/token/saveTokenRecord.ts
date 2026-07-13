import { TokenUsageData, TokenRecord } from "../token/types";
import { DataType } from "../../create/types";
import { createTokenKey } from "../../database/keys";
import { write } from "../../database/dbSlice";
import { toast } from "../../app/utils/toast";
import { pino } from "pino";

const logger = pino({ name: "token-record", level: "info" });

type TokenCount = { input: number; output: number };

export interface ModelStats {
  count: number;
  tokens: TokenCount;
  cost: number;
}

/** Draft built before id/username/type are stamped at save time. */
export type TokenRecordDraft = TokenUsageData & {
  cost: number;
  inputPrice?: number;
  outputPrice?: number;
};

export const createTokenRecord = (
  data: TokenUsageData,
  { cost, inputPrice, outputPrice }: Partial<TokenRecord> = {}
): TokenRecordDraft => ({
  ...data,
  cost: cost || data.cost,
  inputPrice,
  outputPrice,
});

export const saveTokenRecord = async (
  tokenData: TokenUsageData,
  record: TokenRecord,
  thunkApi: { dispatch: (action: unknown) => unknown }
) => {
  const ownerUserId = tokenData.userId || record.userId;
  const eventTime =
    tokenData.timestamp ?? record.createdAt ?? Date.now();
  const key = createTokenKey.record(ownerUserId, eventTime);
  try {
    await thunkApi.dispatch(
      write({
        data: { ...record, id: key, type: DataType.TOKEN, userId: ownerUserId },
        customKey: key,
        // writeAction stamps record.userId from writeConfig.userId ||
        // currentUserId; without this, logged-out local token rows lose
        // the authoritative "local" owner before replication planning.
        userId: ownerUserId,
      })
    );
  } catch (error) {
    logger.error(
      {
        key,
        userId: tokenData.userId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to save token record"
    );
    toast.error("Failed to save token record");
    throw error;
  }
};
