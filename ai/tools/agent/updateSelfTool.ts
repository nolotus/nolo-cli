import type { RootState } from "../../../app/store";
import type { Agent } from "../../../app/types";
import { updateAgent } from "../../agent/agentSlice";
import {
  selectAutoApproveSelfUpdateFields,
} from "../../../app/settings/settingSlice";
import { selectUserId } from "../../../auth/authSlice";
import { selectCurrentDialogConfig } from "../../../chat/dialog/dialogSlice";
import { resolveMessageAgentKey } from "../../../chat/messages/messageAgent";
import { selectMsgById } from "../../../chat/messages/messageSlice";
import { asTrimmedNonEmptyStringArray } from "../../../core/stringArray";
import {
  type UpdateSelfToolArgs,
  agentUpdateFieldSchemaProperties,
  assertAgentUpdateConfirmation,
  buildPatch,
  buildRawDataWithUpdateInfo,
  buildUpdateThunkPreviousAgent,
  extractAgentId,
  fetchAgentByDbKey,
  formatUpdatedAgentOutput,
  listRequestedFields,
  validateUpdateArgs,
} from "./agentUpdateShared";

export const updateSelfToolFunctionSchema = {
  name: "updateSelf",
  description:
    "更新当前正在运行的 Agent 自己。低风险字段可直接更新，其他字段会先向用户确认。",
  parameters: {
    type: "object",
    properties: agentUpdateFieldSchemaProperties,
  },
};

const resolveCurrentAgentKey = (
  state: RootState,
  parentMessageId?: string,
): string | undefined => {
  const parentMessage = parentMessageId
    ? selectMsgById(state, parentMessageId)
    : undefined;
  const parentAgentKey = resolveMessageAgentKey(parentMessage);
  if (parentAgentKey) {
    return parentAgentKey;
  }

  const currentDialog = selectCurrentDialogConfig(state);
  return asTrimmedNonEmptyStringArray(currentDialog?.cybots)[0];
};

export async function updateSelfToolFunc(
  args: UpdateSelfToolArgs,
  thunkApi: any,
  runtime?: { parentMessageId?: string },
): Promise<{ rawData: Agent; displayData: string }> {
  const state = thunkApi.getState() as RootState;
  const userId = selectUserId(state);
  const db = (thunkApi.extra as any)?.db;

  validateUpdateArgs(userId);

  const currentAgentKey = resolveCurrentAgentKey(state, runtime?.parentMessageId);
  if (!currentAgentKey) {
    throw new Error("updateSelf 失败：无法识别当前正在运行的 Agent。");
  }

  const previousAgent = await fetchAgentByDbKey(currentAgentKey, db);
  if (!previousAgent) {
    throw new Error(`updateSelf 失败：未找到当前 Agent（${currentAgentKey}）。`);
  }

  const requestedFields = listRequestedFields(args);
  const autoApprovedFields = selectAutoApproveSelfUpdateFields(state);

  assertAgentUpdateConfirmation({
    scope: "self",
    requestedFields,
    confirmed: args.__confirmedSelfEvolution === true,
    autoApprovedFields,
  });

  const previousAgentForUpdate = buildUpdateThunkPreviousAgent(previousAgent, userId!);
  const agent = await thunkApi
    .dispatch(
      updateAgent({
        userId: userId!,
        agentId: extractAgentId(currentAgentKey),
        formData: buildPatch(args),
        previousAgent: previousAgentForUpdate,
      }),
    )
    .unwrap()
    .catch((e: any) => {
      throw new Error(`updateSelf 失败：${e?.message ?? "未知错误"}`);
    });

  // TODO: Future automation should prefer memory/doc capture before high-impact self
  // mutations, and add audit history for rollback. Keep this tool focused on execution.
  return {
    rawData: buildRawDataWithUpdateInfo(
      agent,
      previousAgentForUpdate,
      requestedFields,
    ) as any,
    displayData: formatUpdatedAgentOutput(agent),
  };
}
