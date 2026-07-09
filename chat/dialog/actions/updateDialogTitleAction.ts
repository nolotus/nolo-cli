// chat/dialogs/updateDialogTitleAction.ts

import { runLlm } from "../../../ai/agent/agentSlice";
import type { RootState } from "../../../app/store";
import {
  updateContentTitle,
} from "../../../create/space/spaceSlice";
import { normalizeSpaceId } from "../../../create/space/spaceKeys";
import { patch, selectById } from "../../../database/dbSlice";
import { extractCustomId } from "../../../core/prefix";
import { format } from "date-fns";
import { selectAllMsgs } from "../../messages/messageSlice";
import { serializeMessageContent } from "../../messages/messageContent";
import {
  BUILTIN_TITLE_LLM_CONFIG,
} from "./builtinDialogLlm";
import {
  shouldUpdateTitle,
} from "./updateDialogTitlePolicy";
import {
  buildDialogFallbackTitleFromMessages,
  resolveDialogTitle,
} from "../dialogTitle";

// --- 常量 ---
const MAX_MESSAGES_FOR_CONTEXT = 20;

const isAssistantToolStub = (msg: any) =>
  msg?.role === "assistant" &&
  (msg.content == null ||
    (typeof msg.content === "string" && msg.content.trim().length === 0) ||
    (Array.isArray(msg.content) && msg.content.length === 0)) &&
  Array.isArray(msg?.tool_calls) &&
  msg.tool_calls.length > 0;

const dedupeById = <T extends { id?: string }>(messages: T[]) => {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const id = typeof message.id === "string" ? message.id : "";
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const getMessageContextForTitle = (
  state: RootState,
  dialogKey: string,
  selectAllMessages: typeof selectAllMsgs = selectAllMsgs
) => {
  const allMsgs = selectAllMessages(state, extractCustomId(dialogKey));

  const flattened = Array.isArray(allMsgs)
    ? typeof (allMsgs as any).flat === "function"
      ? (allMsgs as any).flat()
      : (allMsgs as any).reduce(
        (acc: any[], cur: any) => acc.concat(cur),
        []
      )
    : [];

  const normalized = flattened
    .filter((msg: any) => msg?.role !== "tool" && !isAssistantToolStub(msg))
    .map((msg: any) => {
      const textContent = serializeMessageContent(msg?.content, "这里是一个图片");
      if (!textContent) return null;

      return {
        ...msg,
        content: textContent as string, // 之后只会用到 role + content
      };
    })
    .filter(Boolean) as Array<{ id?: string; role: any; content: string }>;

  const earlyUserTurns = normalized.filter((msg) => msg.role === "user").slice(0, 3);
  const recentTurns = normalized.slice(-12);

  return dedupeById([...earlyUserTurns, ...recentTurns]).slice(
    0,
    MAX_MESSAGES_FOR_CONTEXT
  );
};

type UpdateDialogTitleDeps = {
  runLlmAction?: typeof runLlm;
  patchAction?: typeof patch;
  selectDialogById?: typeof selectById;
  selectAllMessages?: typeof selectAllMsgs;
  updateSpaceContentTitle?: typeof updateContentTitle;
};

// --- 异步 Thunk Action ---
export const updateDialogTitleActionWithDeps = async (
  args: { dialogKey: string },
  thunkApi: { dispatch: any; getState: () => any; extra: any },
  deps: UpdateDialogTitleDeps = {}
) => {
  const {
    runLlmAction = runLlm,
    patchAction = patch,
    selectDialogById = selectById,
    selectAllMessages = selectAllMsgs,
    updateSpaceContentTitle = updateContentTitle,
  } = deps;
  const { dialogKey } = args;
  const { dispatch, getState } = thunkApi;
  const state = getState() as RootState;

  const dialogConfig = selectDialogById(state, dialogKey);
  if (
    !dialogConfig ||
    !shouldUpdateTitle(dialogConfig.createdAt, dialogConfig.updatedAt)
  ) {
    return dialogConfig;
  }

  const messageContext = getMessageContextForTitle(state, dialogKey, selectAllMessages);
  if (messageContext.length === 0) {
    return dialogConfig;
  }

  const content = JSON.stringify(
    messageContext.map((msg) => ({ role: msg.role, content: msg.content }))
  );

  const generatedTitle = await (dispatch as any)(
    runLlmAction({
      llmConfig: BUILTIN_TITLE_LLM_CONFIG,
      content,
      billingDialogKey: dialogKey,
    })
  ).unwrap();

  const fallbackTitle =
    buildDialogFallbackTitleFromMessages(messageContext) ||
    `Conversation on ${format(new Date(), "MMM d")}`;
  const title = resolveDialogTitle(generatedTitle, fallbackTitle);

  const spaceId =
    dialogConfig?.spaceId && normalizeSpaceId(dialogConfig.spaceId);
  if (spaceId) {
    (dispatch as any)((updateSpaceContentTitle as any)({ spaceId, contentKey: dialogKey, title }));
  }

  return await (dispatch as any)(
    patchAction({ dbKey: dialogKey, changes: { title } })
  ).unwrap();
};

export const updateDialogTitleAction = async (
  args: { dialogKey: string },
  thunkApi: { dispatch: any; getState: () => any; extra: any }
) =>
  updateDialogTitleActionWithDeps(args, thunkApi);
