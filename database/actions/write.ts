// 文件路径: database/actions/write.ts

import type { DbThunkApi } from "../thunkApiTypes";
import { getRuntimeServerContext } from "../runtimeServerContext";
import { DataType } from "../../create/types";
import { normalizeTimeFields, logger } from "./common";
import {
  resolveAuthorityReplicationServers,
  scheduleWriteReplication,
} from "./replication";
import { toast } from "../../app/utils/toast";

const SPACE_MEMBER_PREFIX = "space-member-";

const getMemberUserIdFromSpaceMemberKey = (dbKey: string): string | null => {
  if (!dbKey.startsWith(SPACE_MEMBER_PREFIX)) return null;
  const rest = dbKey.slice(SPACE_MEMBER_PREFIX.length);
  const lastDash = rest.lastIndexOf("-");
  if (lastDash <= 0) return null;
  return rest.slice(0, lastDash);
};

// 辅助函数：保存到本地 DB
const saveToClientDb = async (
  clientDb: any,
  dbKey: string,
  data: any
): Promise<void> => {
  if (!clientDb) {
    logger.error({ dbKey }, "Client database is undefined in saveToClientDb");
    throw new Error("Client database instance is required");
  }
  try {
    await clientDb.put(dbKey, data);
    logger.debug({ dbKey }, "Data saved successfully to local database.");
  } catch (err: any) {
    logger.error({ err, dbKey }, "Failed to save data to local database");
    throw new Error(`Local database put failed for ${dbKey}: ${err.message}`);
  }
};

/**
 * Write Action: 写入新数据项。
 * 1. 验证数据类型。
 * 2. 规范化数据（添加时间戳、dbKey、userId）。
 * 3. 保存数据到本地数据库。
 * 4. 若在线，异步将完整数据写入所有服务器。
 */
export const writeAction = async (
  writeConfig: { data: any; customKey: string; userId?: string },
  thunkApi: DbThunkApi
): Promise<any> => {
  const { db: clientDb } = thunkApi.extra as import("../../app/store").AppExtra;
  if (!clientDb) {
    throw new Error("Client database instance is required in writeAction");
  }

  const state = thunkApi.getState() as import("../../app/store").RootState;
  const { currentServer, syncServers, currentUserId } =
    getRuntimeServerContext(state);

  const { data, customKey } = writeConfig;
  const userId = writeConfig.userId || currentUserId;
  const isSpaceMemberRecord = customKey.startsWith(SPACE_MEMBER_PREFIX);
  const recordUserId = isSpaceMemberRecord
    ? data.userId || getMemberUserIdFromSpaceMemberKey(customKey) || userId
    : userId;

  // 1. 基础参数校验
  if (!data || !customKey) {
    const errorMsg =
      "Invalid arguments for writeAction: data and customKey are required.";
    logger.error({ writeConfig }, errorMsg);
    toast.error(errorMsg);
    throw new Error(errorMsg);
  }

  // 2. 类型校验（保持原有行为：非法类型只告警，不阻塞）
  const VALID_TYPES = [
    DataType.MSG,
    DataType.CYBOT,
    DataType.DOC,
    DataType.DIALOG,
    DataType.NOTIFICATION,
    DataType.TOKEN,
    DataType.TRANSACTION,
    DataType.SPACE,
    DataType.SETTING,
    DataType.TABLE,
    DataType.TABLE_ROW,
    DataType.EMAIL,
  ];
  if (!data.type || !VALID_TYPES.includes(data.type)) {
    logger.warn(
      `Invalid data type "${data.type}" for writeAction with key ${customKey}. Proceeding anyway.`
    );
  }

  try {
    // 3. 规范化数据（时间字段 / dbKey / userId）
    const willSaveData = normalizeTimeFields({
      ...data,
      dbKey: customKey,
      userId: recordUserId,
    });

    // 4. 本地保存
    await saveToClientDb(clientDb, customKey, willSaveData);

    // 5. 计算远程服务器列表（currentServer + syncServers，带去重 + 离线判断）
    const servers = resolveAuthorityReplicationServers({
      currentServer,
      syncServers,
      dbKey: customKey,
      record: willSaveData,
      state,
    });

    const serverWriteConfig = {
      data: willSaveData,
      customKey,
      userId: recordUserId,
    };

    // 6. 后台异步同步到远程（若在线且有可用服务器）
    if (servers.length > 0) {
      logger.debug(
        `[writeAction] Initiating background sync for key: ${customKey} to ${servers.length} servers.`
      );
      scheduleWriteReplication(servers, serverWriteConfig, state);
    } else {
      logger.warn(
        { customKey },
        "[writeAction] No available servers, data only saved locally."
      );
    }

    return willSaveData;
  } catch (error: any) {
    const errorMessage = `Write action failed for ${customKey}: ${error?.message || "Unknown error"
      }`;
    logger.error("[writeAction] Error:", error);
    toast.error(`Failed to save data for ${customKey}.`);
    throw new Error(errorMessage);
  }
};
