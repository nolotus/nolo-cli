// Wave21 — pure policy for resuming a suspended summary task during initMsgs.
//
// initMsgs 在拿到远端消息后会扫描 db entities，找出当前 dialog 并判断其
// `summaryPending` 是否成立、是否持有可恢复的 `dbKey`。这部分决策与 Redux
// dispatch / thunk 副作用无关，抽成纯函数后可独立单测（照抄 messageSlice
// 原内联逻辑 ~643–651）。

import { DataType } from "../../create/types";
import type { DialogConfig } from "../../app/types";

/**
 * Find the `DialogConfig` for `dialogId` inside the db entity map.
 *
 * Mirrors the original inline find: walk `Object.values(entities ?? {})`,
 * keep only entries that are objects whose `type === DataType.DIALOG` and
 * `id === dialogId`.
 */
export function findDialogConfigByDialogId(
  entities: Record<string, unknown> | null | undefined,
  dialogId: string
): DialogConfig | undefined {
  return Object.values(entities ?? {}).find(
    (entity): entity is DialogConfig => {
      if (!entity || typeof entity !== "object") return false;
      const value = entity as { type?: unknown; id?: unknown };
      return value.type === DataType.DIALOG && value.id === dialogId;
    }
  );
}

export type InitMsgsSummaryResumeDecision =
  | { resume: false }
  | { resume: true; dialogKey: string };

/**
 * Decide whether initMsgs should resume a suspended summary task.
 *
 * Resume only when a matching dialog exists, its `summaryPending` flag is set,
 * and it carries a truthy `dbKey` to resume from. Otherwise no resume.
 */
export function resolveInitMsgsSummaryResume(input: {
  entities: Record<string, unknown> | null | undefined;
  dialogId: string;
}): InitMsgsSummaryResumeDecision {
  const dialogConfig = findDialogConfigByDialogId(input.entities, input.dialogId);

  if (dialogConfig && dialogConfig.summaryPending && dialogConfig.dbKey) {
    return { resume: true, dialogKey: dialogConfig.dbKey };
  }
  return { resume: false };
}