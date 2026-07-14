// 文件: database/keys.ts

/* ===========================================================================
 *  keys.ts —— 统一的 Key 辅助函数集合
 *  1) 通用存储键（row / idx / dir / meta / view / 
 *  2) 现有业务键（user / tx / token / dialog / page / cybot …）
 *  3) 收藏（favorite）相关键（区分 id / key）
 * =========================================================================*/

import { ulid } from "./utils/ulid";
import { curry } from "rambda";
import { DataType } from "../create/types"; // 枚举：DIALOG / PAGE / CYBOT …

/* --------------------------------------------------------------------------
 * 基础工具
 * ------------------------------------------------------------------------*/

export const SEPARATOR = "-";

export const createKey = (...parts: (string | number)[]) =>
  parts.join(SEPARATOR);

export const splitKey = (key: string) => key.split(SEPARATOR);

/**
 * 判断一个 dbKey 是否是「表定义（TableMeta）」的 key
 * 形如：meta-{tenantId}-{tableId}
 */
export const isTableMetaKey = (key: string): boolean => {
  const parts = splitKey(key);
  return parts.length >= 3 && parts[0] === "meta";
};

/**
 * 判断一个 dbKey 是否是 Page 的 key
 * 形如：PAGE-{userId}-{pageId}
 */
export const isPageKey = (key: string): boolean => {
  const parts = splitKey(key);
  return parts.length >= 3 && parts[0] === DataType.DOC;
};

/**
 * 判断一个 dbKey 是否是 Dialog 的 key
 * 形如：dialog-{userId}-{dialogId} 或 dialog-{dialogId}-msg-{messageId}
 */
export const isDialogKey = (key: string): boolean => {
  const parts = splitKey(key);
  return parts.length >= 3 && parts[0] === DataType.DIALOG;
};

/**
 * 判断是否为 dialog **记录** key（排除消息 key）。
 * 记录：dialog-{userId}-{dialogId}
 * 消息：dialog-{dialogId}-msg-{messageId}
 */
export const isDialogRecordKey = (key: string): boolean => {
  if (typeof key !== "string" || !key.startsWith(`${DataType.DIALOG}-`)) {
    return false;
  }
  // Message keys always embed the "-msg-" segment after the dialogId.
  if (key.includes("-msg-")) return false;
  const parts = splitKey(key);
  return parts.length >= 3 && parts[0] === DataType.DIALOG;
};

/**
 * 判断 key 是否为指定 dialogId 的记录 key（非消息）。
 * 形如：dialog-{userId}-{dialogId}
 */
export const isDialogRecordKeyForId = (
  key: string,
  dialogId: string,
): boolean => {
  if (!dialogId || !isDialogRecordKey(key)) return false;
  return key.endsWith(`${SEPARATOR}${dialogId}`);
};

export const isTaskKey = (key: string): boolean => {
  const parts = splitKey(key);
  return parts.length >= 3 && parts[0] === DataType.TASK;
};

export const isAgentAutomationKey = (key: string): boolean => {
  return key.startsWith(`${DataType.AGENT_AUTOMATION}-`);
};

/**
 * 判断一个 dbKey 是否是 File/Image 的 key
 * 形如：file-{userId}-{fileId} 或 image-{userId}-{imageId}
 */
export const isFileKey = (key: string): boolean => {
  const parts = splitKey(key);
  return (
    parts.length >= 3 &&
    (parts[0] === DataType.FILE || parts[0] === DataType.IMAGE)
  );
};

/**
 * 判断一个 dbKey 是否是 Agent/Cybot 的 key
 * 形如：agent-{userId}-{agentId} 或 cybot-{userId}-{agentId}
 */
export const isAgentKey = (key: string): boolean => {
  const parts = splitKey(key);
  return (
    parts.length >= 3 &&
    (parts[0] === DataType.AGENT || parts[0] === DataType.CYBOT)
  );
};

/**
 * 判断一个 dbKey 是否是 App 的 key
 * 形如：app-{userId}-{appId}
 */
export const isAppKey = (key: string): boolean => {
  const parts = splitKey(key);
  return parts.length >= 2 && parts[0] === DataType.APP;
};

/**
 * 判断一个 dbKey 是否是 Email 的 key
 * 形如：email-{ownerId}-{emailId}
 */
export const isEmailKey = (key: string): boolean => {
  const parts = splitKey(key);
  return parts.length >= 3 && parts[0] === DataType.EMAIL;
};


/* --------------------------------------------------------------------------
 * 1. 通用存储键 —— 行 / 索引 / 目录 / 元数据 / 视图 / 触发器
 * ------------------------------------------------------------------------*/

/**
 * 行主键（表行）
 *
 * 形如：
 *   row-{tenantId}-{tableId}-{rowId}
 *
 * 设计原则：
 * - 统一以 "row" 前缀标识实体类型，便于全库扫描时按前缀过滤
 * - 以 tenantId 在前、tableId 在后，便于：
 *   - 按租户导出/删除：row-{tenantId}-
 *   - 按 (tenantId, tableId) 扫描整张表：row-{tenantId}-{tableId}-
 */
export const rowKey = {
  /** 生成新行主键 + rowId */
  create: (tenantId: string, tableId: string) => {
    const rowId = ulid();
    return { dbKey: createKey("row", tenantId, tableId, rowId), rowId };
  },

  /** 单行键 */
  single: (tenantId: string, tableId: string, rowId: string) =>
    createKey("row", tenantId, tableId, rowId),

  /** 整张表的范围（gte / lte）—— 供批量操作使用 */
  range: (tenantId: string, tableId: string) => {
    const start = createKey("row", tenantId, tableId, "");
    return {
      gte: start,
      lte: start + "\uffff",
    };
  },

  /** 旧接口（start / end）—— 与早期代码兼容 */
  rangeOfTable: (tenantId: string, tableId: string) => {
    const start = createKey("row", tenantId, tableId, "");
    return {
      start,
      end: start + "\uffff",
    };
  },

  /** 某个租户的所有行范围 */
  rangeOfTenant: (tenantId: string) => {
    const start = createKey("row", tenantId, "");
    return {
      start,
      end: start + "\uffff",
    };
  },
};

/**
 * 二级索引键（表行索引用）
 *
 * 形如：
 *   idx-{tenantId}-{tableId}-{indexName}-{indexKey}-{rowId}
 *
 * 说明：
 * - 与 rowKey 一致，tenantId 在前、tableId 在后
 * - 某表所有索引：
 *     prefix: idx-{tenantId}-{tableId}-
 * - 某索引名前缀：
 *     idx-{tenantId}-{tableId}-{indexName}-{indexKeyPrefix}
 */
export const idxKey = {
  /** 写入单条索引 */
  put: (
    tenantId: string,
    tableId: string,
    indexName: string,
    indexKey: string,
    rowId: string
  ) => createKey("idx", tenantId, tableId, indexName, indexKey, rowId),

  /** 某一索引名前缀的范围（start / end）—— 供前缀扫描 */
  range: (
    tenantId: string,
    tableId: string,
    indexName: string,
    indexKeyPrefix = ""
  ) => {
    const start = createKey(
      "idx",
      tenantId,
      tableId,
      indexName,
      indexKeyPrefix
    );
    return { start, end: start + "\uffff" };
  },

  /** 整张表所有索引的范围（gte / lte）—— 供整表删除 */
  prefix: (tenantId: string, tableId: string) => {
    const start = createKey("idx", tenantId, tableId, "");
    return {
      gte: start,
      lte: start + "\uffff",
    };
  },

  /** 某个租户的所有索引范围 */
  rangeOfTenant: (tenantId: string) => {
    const start = createKey("idx", tenantId, "");
    return {
      start,
      end: start + "\uffff",
    };
  },
};

/**
 * 元数据键（表定义 TableMeta）
 *
 * 形如：
 *   meta-{tenantId}-{tableId}
 */
export const metaKey = Object.assign(
  (tenantId: string, tableId: string) => createKey("meta", tenantId, tableId),
  {
    /** 某个租户的所有表定义范围 */
    rangeOfTenant: (tenantId: string) => {
      const start = createKey("meta", tenantId, "");
      return {
        start,
        end: start + "\uffff",
      };
    },
  }
);

/**
 * 视图键（TableView）
 *
 * 形如：
 *   view-{tenantId}-{tableId}-{viewId}
 *
 * 用途：
 * - 为某张表定义多个视图（grid / kanban / calendar 等）
 * - 视图本身作为独立实体存储，便于按表/租户管理
 */
export const viewKey = {
  /** 创建一个新视图 key + viewId（由调用方生成或传入） */
  create: (tenantId: string, tableId: string, viewId?: string) => {
    const id = viewId || ulid();
    const dbKey = createKey("view", tenantId, tableId, id);
    return { dbKey, id };
  },

  /** 某一视图的单键 */
  single: (tenantId: string, tableId: string, viewId: string) =>
    createKey("view", tenantId, tableId, viewId),

  /** 某张表下面的所有视图范围 */
  rangeOfTable: (tenantId: string, tableId: string) => {
    const start = createKey("view", tenantId, tableId, "");
    return {
      start,
      end: start + "\uffff",
    };
  },

  /** 某个租户的所有视图范围 */
  rangeOfTenant: (tenantId: string) => {
    const start = createKey("view", tenantId, "");
    return {
      start,
      end: start + "\uffff",
    };
  },
};



/* --------------------------------------------------------------------------
 * 2. 业务侧原有键（保持完全兼容）
 * ------------------------------------------------------------------------*/

export const DB_PREFIX = {
  USER: "user:",
} as const;

/* ---- OAuth Credential ---- */
export const createOAuthCredentialKey = (userId: string, provider: string) =>
  createKey("oauth", userId, provider);

export const oauthCredentialUserRange = (userId: string) => ({
  start: createKey("oauth", userId, ""),
  end: createKey("oauth", userId, "\uffff"),
});

/* ---- User ---- */
// TODO(keys): 目前 user 相关 key 没有统一的前缀（如 "user-settings-"），
//             将来如果需要按实体类型/租户范围扫描，可以考虑加前缀做一次轻量重构。
export const createUserKey = {
  settings: (userId: string) => createKey(userId, "settings"),
  profile: (userId: string) => createKey(userId, "profile"),
};

/**
 * 用户级“寄存器 / 指针”key。
 *
 * 用于存放跨服务器 sticky 的小型决策状态（如默认 space 指针），
 * 避免把这类高价值字段长期埋在整份 settings blob 里做粗粒度 LWW。
 */
export const createUserPreferenceKey = {
  single: (userId: string, preferenceName: string) =>
    createKey("user", "pref", userId, preferenceName),
  authorityHome: (userId: string) =>
    createKey("user", "pref", userId, "authority_home"),
  defaultSpace: (userId: string) =>
    createKey("user", "pref", userId, "space_default"),
  defaultAgent: (userId: string) =>
    createKey("user", "pref", userId, "agent_default"),
  rangeOfUser: (userId: string) => ({
    start: createKey("user", "pref", userId, ""),
    end: createKey("user", "pref", userId, "\uffff"),
  }),
};

/* ---- Memory ---- */
export const createMemoryKey = (
  ownerType: "user" | "space" | "system",
  ownerId: string,
  memoryId: string
) => createKey("mem", ownerType, ownerId, memoryId);

export const createMemoryOwnerIndexKey = (
  ownerType: "user" | "space" | "system",
  ownerId: string,
  createdAt: string,
  memoryId: string
) => createKey("memidx", "owner", ownerType, ownerId, createdAt, memoryId);

export const createMemorySubjectKindIndexKey = (
  subjectType: "user" | "agent" | "space" | "project" | "system",
  subjectId: string,
  kind: "episodic" | "semantic" | "procedural",
  createdAt: string,
  memoryId: string
) =>
  createKey(
    "memidx",
    "subject",
    subjectType,
    subjectId,
    kind,
    createdAt,
    memoryId
  );

export const isMemoryKey = (key: string): boolean => {
  const parts = splitKey(key);
  return parts.length >= 4 && parts[0] === "mem";
};

export const memoryOwnerRange = (
  ownerType: "user" | "space" | "system",
  ownerId: string
) => ({
  start: createKey("memidx", "owner", ownerType, ownerId, ""),
  end: createKey("memidx", "owner", ownerType, ownerId, "\uffff"),
});

export const memorySubjectKindRange = (
  subjectType: "user" | "agent" | "space" | "project" | "system",
  subjectId: string,
  kind: "episodic" | "semantic" | "procedural"
) => ({
  start: createKey("memidx", "subject", subjectType, subjectId, kind, ""),
  end: createKey("memidx", "subject", subjectType, subjectId, kind, "\uffff"),
});

/* ---- Transaction ---- */
// 结构为 tx-{userId}-{txId}，与表 key 的租户在前原则一致
export const createTransactionKey = {
  record: curry((userId: string, txId: string) =>
    createKey("tx", userId, txId)
  ),
  index: (txId: string) => createKey("tx", "index", txId),
  range: (userId: string) => ({
    start: createKey("tx", userId, ""),
    end: createKey("tx", userId, "\uffff"),
  }),
};

/* ---- Token ---- */
// TODO(keys): token 统计相关 key 已经带有 "token" 前缀，整体结构还算统一，
//             将来如果需要按 tenant 维度聚合，再考虑是否引入 tenantId 作为前缀第二位。
export const createTokenKey = {
  record: curry((userId: string, timestamp: number) =>
    createKey("token", userId, timestamp.toString())
  ),
  range: (userId: string, timestamp: number) => ({
    start: createKey("token", userId, timestamp.toString()),
    end: createKey("token", userId, (timestamp + 86_400_000).toString()),
  }),
  /** 某个用户的所有 Token 记录范围 */
  rangeOfUser: (userId: string) => ({
    start: createKey("token", userId, ""),
    end: createKey("token", userId, "\uffff"),
  }),
};

/* ---- Token Stats ---- */
export const createTokenStatsKey = Object.assign(
  (userId: string, dateKey: string) =>
    createKey("token", "stats", "day", "user", userId, dateKey),
  {
    /** 某个用户的所有统计记录范围 */
    rangeOfUser: (userId: string) => ({
      start: createKey("token", "stats", "day", "user", userId, ""),
      end: createKey("token", "stats", "day", "user", userId, "\uffff"),
    }),
  }
);

/* ---- Dialog ---- */
// TODO(keys): Dialog 相关 key 使用 DataType.DIALOG 前缀，结构为
//             dialog-{userId}-{dialogId} / dialog-{dialogId}-msg-{messageId}，
//             已经与其它实体类型的前缀策略对齐，可以保持。
export const createDialogKey = Object.assign(
  (userId: string) => createKey(DataType.DIALOG, userId, ulid()),
  {
    /** O(1) 单条 dialog 记录 key */
    single: (userId: string, dialogId: string) =>
      createKey(DataType.DIALOG, userId, dialogId),
    /** 某用户全部 dialog 记录范围（不含其它用户；消息 key 不在此前缀下） */
    rangeOfUser: (userId: string) => ({
      start: createKey(DataType.DIALOG, userId, ""),
      end: createKey(DataType.DIALOG, userId, "\uffff"),
    }),
  }
);

/* ---- Dialog agent list index (write-path secondary index) ---- */
//
// Reverse-chrono list of a user's non-automation dialogs for one agentKey:
//   dialogidx-agent-{userId}-{agentKey}-{invertedUpdatedAt13}-{dialogId}
//
// invertedUpdatedAt = pad(TIMESTAMP_MAX - updatedAtMs, 13) so lexicographic
// ascending scan = newest updatedAt first (exact sort for index-backed lists).
// Value points at the dialog record key for O(1) get per page row.
export const DIALOG_AGENT_LIST_INDEX_PREFIX = "dialogidx";
const DIALOG_LIST_TIMESTAMP_MAX = 9_999_999_999_999;

export type DialogAgentListIndexValue = {
  dialogKey: string;
  dialogId: string;
  updatedAtMs: number;
};

export type DialogAgentListIndexOp =
  | { type: "put"; key: string; value: DialogAgentListIndexValue }
  | { type: "del"; key: string };

export function parseDialogUpdatedAtMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && /^\d+(\.\d+)?$/.test(value.trim())) {
      return Math.max(0, Math.floor(asNumber));
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  return 0;
}

/** Lexicographic ascending = newest first when used as key segment. */
export function toDialogListInvertedTimestamp(updatedAt: unknown): string {
  const ms = Math.min(
    DIALOG_LIST_TIMESTAMP_MAX,
    parseDialogUpdatedAtMs(updatedAt),
  );
  return String(DIALOG_LIST_TIMESTAMP_MAX - ms).padStart(13, "0");
}

export function createDialogAgentListIndexKey(args: {
  userId: string;
  agentKey: string;
  updatedAt: unknown;
  dialogId: string;
}): string {
  const userId = args.userId.trim();
  const agentKey = args.agentKey.trim();
  const dialogId = args.dialogId.trim();
  if (!userId || !agentKey || !dialogId) return "";
  return createKey(
    DIALOG_AGENT_LIST_INDEX_PREFIX,
    "agent",
    userId,
    agentKey,
    toDialogListInvertedTimestamp(args.updatedAt),
    dialogId,
  );
}

export function createDialogAgentListIndexRange(
  userId: string,
  agentKey: string,
): { start: string; end: string } {
  const normalizedUserId = userId.trim();
  const normalizedAgentKey = agentKey.trim();
  if (!normalizedUserId || !normalizedAgentKey) {
    return { start: "", end: "" };
  }
  const start = createKey(
    DIALOG_AGENT_LIST_INDEX_PREFIX,
    "agent",
    normalizedUserId,
    normalizedAgentKey,
    "",
  );
  return { start, end: `${start}\uffff` };
}

/**
 * Expand agent-/cybot- aliases so list-by either form hits the same membership.
 */
export function expandDialogAgentListIndexAliases(agentKey: string): string[] {
  const key = agentKey.trim();
  if (!key) return [];
  const aliases = new Set<string>([key]);
  if (key.startsWith("agent-")) {
    aliases.add(`cybot-${key.slice("agent-".length)}`);
  } else if (key.startsWith("cybot-")) {
    aliases.add(`agent-${key.slice("cybot-".length)}`);
  }
  return Array.from(aliases);
}

/** Agent keys that should own a list-index row for this dialog. */
export function collectDialogAgentListIndexAgentKeys(record: {
  primaryAgentKey?: unknown;
  cybots?: unknown;
}): string[] {
  const keys = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    for (const alias of expandDialogAgentListIndexAliases(trimmed)) {
      keys.add(alias);
    }
  };
  add(record.primaryAgentKey);
  if (Array.isArray(record.cybots)) {
    for (const item of record.cybots) add(item);
  }
  return Array.from(keys);
}

/**
 * Whether a dialog should appear in agent dialog lists (mirrors list filter:
 * exclude automation evidence).
 */
export function isDialogAgentListIndexable(
  record: Record<string, unknown> | null | undefined,
): boolean {
  if (!record || typeof record !== "object") return false;
  if (
    record.triggerType === "automation_run" ||
    record.triggerType === "scheduled_run"
  ) {
    return false;
  }
  if (record.parentAutomationKey) return false;
  if (record.parentTaskKey) return false;
  return true;
}

function resolveDialogIdForIndex(
  dialogKey: string,
  dialogId: string | undefined,
  record: Record<string, unknown> | null | undefined,
): string {
  if (dialogId && dialogId.trim()) return dialogId.trim();
  if (typeof record?.id === "string" && record.id.trim()) return record.id.trim();
  // dialog-{userId}-{dialogId} — dialogId is the final segment for record keys.
  const parts = splitKey(dialogKey);
  if (parts.length >= 3 && parts[0] === DataType.DIALOG && !dialogKey.includes("-msg-")) {
    return parts[parts.length - 1] ?? "";
  }
  return "";
}

function buildDialogAgentListIndexKeySet(args: {
  userId: string;
  dialogKey: string;
  dialogId: string;
  record: Record<string, unknown>;
}): Map<string, DialogAgentListIndexValue> {
  const map = new Map<string, DialogAgentListIndexValue>();
  if (!args.userId.trim() || !args.dialogKey.trim() || !args.dialogId.trim()) {
    return map;
  }
  if (!isDialogAgentListIndexable(args.record)) return map;
  const updatedAtMs = parseDialogUpdatedAtMs(args.record.updatedAt);
  const value: DialogAgentListIndexValue = {
    dialogKey: args.dialogKey,
    dialogId: args.dialogId,
    updatedAtMs,
  };
  for (const agentKey of collectDialogAgentListIndexAgentKeys(args.record)) {
    const key = createDialogAgentListIndexKey({
      userId: args.userId,
      agentKey,
      updatedAt: updatedAtMs,
      dialogId: args.dialogId,
    });
    if (key) map.set(key, value);
  }
  return map;
}

/**
 * Maintain reverse-chrono agent list index rows when a dialog is written.
 * Deletes stale (agent, invertedTs) keys when membership or updatedAt changes.
 */
export function buildDialogAgentListIndexOps(args: {
  userId: string | null | undefined;
  dialogKey: string;
  dialogId?: string;
  nextRecord: Record<string, unknown> | null | undefined;
  previousRecord?: Record<string, unknown> | null;
}): DialogAgentListIndexOp[] {
  const userId = typeof args.userId === "string" ? args.userId.trim() : "";
  const dialogKey = args.dialogKey.trim();
  if (!userId || !dialogKey) return [];

  const dialogId = resolveDialogIdForIndex(
    dialogKey,
    args.dialogId,
    args.nextRecord ?? args.previousRecord ?? null,
  );
  if (!dialogId) return [];

  const previousMap =
    args.previousRecord && typeof args.previousRecord === "object"
      ? buildDialogAgentListIndexKeySet({
          userId,
          dialogKey,
          dialogId: resolveDialogIdForIndex(
            dialogKey,
            args.dialogId,
            args.previousRecord,
          ) || dialogId,
          record: args.previousRecord,
        })
      : new Map<string, DialogAgentListIndexValue>();

  const nextMap =
    args.nextRecord && typeof args.nextRecord === "object"
      ? buildDialogAgentListIndexKeySet({
          userId,
          dialogKey,
          dialogId,
          record: args.nextRecord,
        })
      : new Map<string, DialogAgentListIndexValue>();

  const ops: DialogAgentListIndexOp[] = [];
  for (const key of previousMap.keys()) {
    if (!nextMap.has(key)) {
      ops.push({ type: "del", key });
    }
  }
  for (const [key, value] of nextMap) {
    ops.push({ type: "put", key, value });
  }
  return ops;
}

export const createTaskKey = Object.assign(
  (userId: string) => createKey(DataType.TASK, userId, ulid()),
  {
    rangeOfUser: (userId: string) => ({
      start: createKey(DataType.TASK, userId, ""),
      end: createKey(DataType.TASK, userId, "\uffff"),
    }),
  }
);

export const createAgentAutomationKey = Object.assign(
  (userId: string) => createKey(DataType.AGENT_AUTOMATION, userId, ulid()),
  {
    rangeOfUser: (userId: string) => ({
      start: createKey(DataType.AGENT_AUTOMATION, userId, ""),
      end: createKey(DataType.AGENT_AUTOMATION, userId, "\uffff"),
    }),
  }
);

export const agentAutomationKey = createAgentAutomationKey;

/**
 * Secondary index: agent automations by ownerAgentKey.
 *
 *   agent-automation-owner-idx-{userId}-{ownerAgentKey}-{automationId}
 *
 * Value points at the primary automation key so list-by-agent is O(agent)
 * instead of user-range scan + value filter.
 */
export const AGENT_AUTOMATION_OWNER_INDEX_PREFIX =
  "agent-automation-owner-idx";

export type AgentAutomationOwnerIndexValue = {
  automationKey: string;
  automationId: string;
  userId: string;
  ownerAgentKey: string;
};

export const createAgentAutomationOwnerIndexKey = Object.assign(
  (userId: string, ownerAgentKey: string, automationId: string) =>
    createKey(
      AGENT_AUTOMATION_OWNER_INDEX_PREFIX,
      userId,
      ownerAgentKey,
      automationId,
    ),
  {
    rangeOfAgent: (userId: string, ownerAgentKey: string) => {
      const start = createKey(
        AGENT_AUTOMATION_OWNER_INDEX_PREFIX,
        userId,
        ownerAgentKey,
        "",
      );
      return { start, end: `${start}\uffff` };
    },
  },
);

export function buildAgentAutomationOwnerIndexValue(args: {
  userId: string;
  ownerAgentKey: string;
  automationId: string;
  automationKey: string;
}): AgentAutomationOwnerIndexValue {
  return {
    automationKey: args.automationKey,
    automationId: args.automationId,
    userId: args.userId,
    ownerAgentKey: args.ownerAgentKey,
  };
}

export function isAgentAutomationOwnerIndexKey(key: string): boolean {
  return key.startsWith(`${AGENT_AUTOMATION_OWNER_INDEX_PREFIX}-`);
}

/* ---- Notification ---- */
export const createNotificationKey = {
  single: (userId: string, notificationId: string) =>
    createKey(DataType.NOTIFICATION, userId, notificationId),
  rangeOfUser: (userId: string) => ({
    start: createKey(DataType.NOTIFICATION, userId, ""),
    end: createKey(DataType.NOTIFICATION, userId, "\uffff"),
  }),
};

export const emailKey = {
  create: (ownerId: string) => {
    const emailId = ulid();
    return { dbKey: createKey(DataType.EMAIL, ownerId, emailId), emailId };
  },
  single: (ownerId: string, emailId: string) =>
    createKey(DataType.EMAIL, ownerId, emailId),
  rangeOfOwner: (ownerId: string) => ({
    start: createKey(DataType.EMAIL, ownerId, ""),
    end: createKey(DataType.EMAIL, ownerId, "\uffff"),
  }),
};

export const createDialogMessageKeyAndId = (
  dialogId: string,
  ulidFn: () => string = ulid
): { key: string; messageId: string } => {
  const messageId = ulidFn();
  const key = createKey(DataType.DIALOG, dialogId, "msg", messageId);
  return { key, messageId };
};

/**
 * 某个对话下所有消息的 key 范围
 * 形如：DIALOG-{dialogId}-msg-{messageId}
 */
export const dialogMessageRange = (dialogId: string) => ({
  start: createKey(DataType.DIALOG, dialogId, "msg", ""),
  end: createKey(DataType.DIALOG, dialogId, "msg", "\uffff"),
});

/* ---- Page ---- */
// TODO(keys): Page key 目前为 PAGE-{userId}-{pageId}，与 Dialog 一致，
//             后续如果有“空间 Space 维度”的独立前缀，可以评估是否要引入 spaceId。
export const createPageKey = {
  create: (userId: string) => {
    const id = ulid();
    return { dbKey: createKey(DataType.DOC, userId, id), id };
  },
  rangeOfUser: (userId: string) => ({
    start: createKey(DataType.DOC, userId, ""),
    end: createKey(DataType.DOC, userId, "\uffff"),
  }),
};

/* ---- Cybot / Agent ---- */
// TODO(keys): Agent/Cybot 已采用 DataType.CYBOT 前缀 + userId/cybotId，
//             后续如果引入多租户组织层，可以考虑把 orgId 作为第二位前缀。
export const createCybotKey = {
  private: curry((userId: string, cybotId: string) =>
    createKey(DataType.CYBOT, userId, cybotId)
  ),
  public: (cybotId: string) => createKey(DataType.CYBOT, "pub", cybotId),
  rangeOfUser: (userId: string) => ({
    start: createKey(DataType.CYBOT, userId, ""),
    end: createKey(DataType.CYBOT, userId, "\uffff"),
  }),
};

/**
 * 推荐使用：新的 Agent Key 系列
 * 使用 DataType.AGENT ("agent") 前缀
 */
export const createAgentKey = {
  private: curry((userId: string, agentId: string) =>
    createKey(DataType.AGENT, userId, agentId)
  ),
  public: (agentId: string) => createKey(DataType.AGENT, "pub", agentId),
  rangeOfUser: (userId: string) => ({
    start: createKey(DataType.AGENT, userId, ""),
    end: createKey(DataType.AGENT, userId, "\uffff"),
  }),
};

/**
 * 公开 Agent 列表范围（现有）
 * CYBOT-pub-{id}
 */
export const pubAgentKeys = {
  single: (cybotId: string) => createKey(DataType.CYBOT, "pub", cybotId),
  list: () => ({
    start: createKey(DataType.CYBOT, "pub", ""),
    end: createKey(DataType.CYBOT, "pub", "\uffff"),
  }),
  /** 同时获取 cybot-pub 和 agent-pub 两个前缀的范围 */
  allPublicRanges: () => [
    {
      start: createKey(DataType.CYBOT, "pub", ""),
      end: createKey(DataType.CYBOT, "pub", "\uffff"),
    },
    {
      start: createKey(DataType.AGENT, "pub", ""),
      end: createKey(DataType.AGENT, "pub", "\uffff"),
    },
  ],
};

/* ---- Share (re-exported from share/keys) ---- */
export { shareKey } from "../share/keys";

/* --------------------------------------------------------------------------
 * 3. 收藏（Favorite）相关键 —— 显式区分 id / key
 * ------------------------------------------------------------------------*/

const FAV_PREFIX = "fav";

// 类型区分：AgentId 是“逻辑 ID”（比如 cybotId），AgentKey 是“存储键 / dbKey”
export type AgentId = string;
export type AgentKey = string;
// TODO(keys): 将来如果 Page/File 也有单独逻辑 ID，可以在这里增加 PageId/FileId 类型。

/**
 * 收藏关系：
 *
 * 当前实际使用的是「按 agentKey 存」的版本（byKey）：
 *   - Agent：fav-agent-key-{userId}-{agentKey}
 *   - Page ：fav-page-key-{userId}-{pageKey}
 *
 * 预留了一套「按逻辑 ID 存」的前缀（byId），将来如果有更抽象的逻辑 ID，可以切换到该版本。
 */
export const createFavoriteKey = {
  /* ---------- Agent 收藏（按 agentKey 存，当前使用） ---------- */

  /**
   * 某个用户收藏了某个 Agent 实例（用完整的 agentKey/dbKey）
   * key: fav-agent-key-{userId}-{agentKey}
   */
  agentByKey: (userId: string, agentKey: AgentKey) =>
    createKey(FAV_PREFIX, "agent", "key", userId, agentKey),

  /**
   * 查询某用户收藏的所有 Agent（基于 agentKey 版本）
   * 范围: [fav-agent-key-{userId}-, fav-agent-key-{userId}-\uffff]
   */
  agentKeyRangeOfUser: (userId: string) => ({
    start: createKey(FAV_PREFIX, "agent", "key", userId, ""),
    end: createKey(FAV_PREFIX, "agent", "key", userId, "\uffff"),
  }),

  userRangeOfAgentKey: (agentKey: AgentKey) => ({
    start: createKey(FAV_PREFIX, "agent", "key", "by-agent", agentKey, ""),
    end: createKey(FAV_PREFIX, "agent", "key", "by-agent", agentKey, "\uffff"),
  }),
  agentByKeyReverse: (agentKey: AgentKey, userId: string) =>
    createKey(FAV_PREFIX, "agent", "key", "by-agent", agentKey, userId),

  /* ---------- Agent 收藏（按 agentId 存，预留，将来可用） ---------- */

  /**
   * 某个用户收藏了某个逻辑 AgentId（当前未使用，预留）
   * key: fav-agent-id-{userId}-{agentId}
   */
  agentById: (userId: string, agentId: AgentId) =>
    createKey(FAV_PREFIX, "agent", "id", userId, agentId),

  /** 查询某用户收藏的所有 AgentId（预留） */
  agentIdRangeOfUser: (userId: string) => ({
    start: createKey(FAV_PREFIX, "agent", "id", userId, ""),
    end: createKey(FAV_PREFIX, "agent", "id", userId, "\uffff"),
  }),

  userRangeOfAgentId: (agentId: AgentId) => ({
    start: createKey(FAV_PREFIX, "agent", "id", "by-agent", agentId, ""),
    end: createKey(FAV_PREFIX, "agent", "id", "by-agent", agentId, "\uffff"),
  }),
  agentByIdReverse: (agentId: AgentId, userId: string) =>
    createKey(FAV_PREFIX, "agent", "id", "by-agent", agentId, userId),

  /* ---------- Page 收藏（同样区分 key / id，当前可以只用 byKey） ---------- */

  // Page byKey: fav-page-key-{userId}-{pageKey}
  pageByKey: (userId: string, pageKey: string) =>
    createKey(FAV_PREFIX, "page", "key", userId, pageKey),

  pageKeyRangeOfUser: (userId: string) => ({
    start: createKey(FAV_PREFIX, "page", "key", userId, ""),
    end: createKey(FAV_PREFIX, "page", "key", userId, "\uffff"),
  }),

  userRangeOfPageKey: (pageKey: string) => ({
    start: createKey(FAV_PREFIX, "page", "key", "by-page", pageKey, ""),
    end: createKey(FAV_PREFIX, "page", "key", "by-page", pageKey, "\uffff"),
  }),
  pageByKeyReverse: (pageKey: string, userId: string) =>
    createKey(FAV_PREFIX, "page", "key", "by-page", pageKey, userId),

  // Page byId（预留）
  pageById: (userId: string, pageId: string) =>
    createKey(FAV_PREFIX, "page", "id", userId, pageId),

  pageIdRangeOfUser: (userId: string) => ({
    start: createKey(FAV_PREFIX, "page", "id", userId, ""),
    end: createKey(FAV_PREFIX, "page", "id", userId, "\uffff"),
  }),

  userRangeOfPageId: (pageId: string) => ({
    start: createKey(FAV_PREFIX, "page", "id", "by-page", pageId, ""),
    end: createKey(FAV_PREFIX, "page", "id", "by-page", pageId, "\uffff"),
  }),

  pageByIdReverse: (pageId: string, userId: string) =>
    createKey(FAV_PREFIX, "page", "id", "by-page", pageId, userId),

  /** 从 dbKey 中解析出目标标识符 (agentKey/agentId/pageKey/pageId) */
  getIdentifierFromKey: (key: string) => {
    const parts = key.split(SEPARATOR);
    // 结构: fav-{type}-{mode}-{userId}-{targetIdentifier...}
    return parts.slice(4).join(SEPARATOR);
  },
};

/**
 * 收藏统计：
 * - Agent byKey：fav-agent-count-key-{agentKey}（当前实际使用）
 * - Agent byId ：fav-agent-count-id-{agentId}（预留）
 * - Page 同理
 */
export const createFavoriteStatsKey = {
  // 被多少人收藏的 Agent（按 agentKey 统计，当前实际使用）
  agentByKey: (agentKey: AgentKey) =>
    createKey(FAV_PREFIX, "agent-count", "key", agentKey),

  // 预留：按逻辑 AgentId 统计
  agentById: (agentId: AgentId) =>
    createKey(FAV_PREFIX, "agent-count", "id", agentId),

  // Page：按 pageKey 统计（预留）
  pageByKey: (pageKey: string) =>
    createKey(FAV_PREFIX, "page-count", "key", pageKey),

  pageById: (pageId: string) =>
    createKey(FAV_PREFIX, "page-count", "id", pageId),
};


export const jobKey = {
  create: (tenantId: string, jobId?: string) => {
    const id = jobId || ulid();
    const dbKey = createKey("job", tenantId, id);
    return { dbKey, id };
  },
  single: (tenantId: string, jobId: string) =>
    createKey("job", tenantId, jobId),
  rangeOfTenant: (tenantId: string) => {
    const start = createKey("job", tenantId, "");
    return { start, end: start + "\uffff" };
  },
};

/* --------------------------------------------------------------------------
 * 4. 文件（Blob / File / Stats）相关 key
 * ------------------------------------------------------------------------*/

/**
 * Blob 主记录：
 *   blob-{sha256}
 *
 * 说明：
 * - 以 sha256 唯一标识物理内容
 * - 用于查重和 refCount 管理
 */
export const blobKey = (sha256: string): string => createKey("blob", sha256);

/**
 * File 主记录：
 *   file-{tenantId}-{fileId}
 *
 * 说明：
 * - tenantId 在前，便于按租户范围扫描 / 清理
 * - fileId 通常为 ulid
 */
export const fileKey = {
  single: (tenantId: string, fileId: string): string =>
    createKey("file", tenantId, fileId),

  rangeOfTenant: (tenantId: string): { start: string; end: string } => {
    const start = createKey("file", tenantId, "");
    return {
      start,
      end: start + "\uffff",
    };
  },
};

/**
 * File 反查索引：
 *   file-id-{fileId} -> { tenantId, fileId }
 *
 * 说明：
 * - 便于通过 fileId（URL 里只有这个）快速找到 tenant 维度的主记录
 * - 避免通过全库扫描来反查 tenantId
 */
export const fileIdIndexKey = (fileId: string): string =>
  createKey("file", "id", fileId);

/** 从 fileKey 中解析出 fileId */
export const getFileIdFromKey = (key: string) => {
  const parts = key.split(SEPARATOR);
  return parts[2]; // file-{userId}-{fileId}
};


/**
 * 文件统计：
 *
 * - 按租户 + 日：
 *   file-stat-tenant-{tenantId}-{dateKey}
 *
 * - 按模型 + 日（AI 生成）：
 *   file-stat-model-{modelName}-{dateKey}
 *
 * 说明：
 * - 仅存聚合数字，不重复存 metadata
 * - dateKey 建议使用 "YYYYMMDD"
 */
export const fileStatKey = {
  tenantPerDay: (tenantId: string, dateKey: string): string =>
    createKey("file", "stat", "tenant", tenantId, dateKey),

  modelPerDay: (modelName: string, dateKey: string): string =>
    createKey("file", "stat", "model", modelName, dateKey),
};
