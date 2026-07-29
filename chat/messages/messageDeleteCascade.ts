// Wave15 — pure core for deleteMessage cascade planning.
// When deleting a tool message, optionally also remove the parent assistant
// tool-stub if no sibling tool messages remain. Redux/db I/O stays in the thunk.

import type { Message } from "./types";
import { isAssistantToolStub } from "./web/assistantReplyPendingState";

export type DeleteMessageCascadePlan = {
  /** Primary message id (may be undefined if only dbKey matched oddly). */
  id?: string;
  /** Extra assistant stub id to remove from the entity adapter. */
  extraRemoveId?: string;
  /** Extra stub dbKey to delete from durable store. */
  extraRemoveDbKey?: string;
};

/**
 * Given the message being deleted (looked up by dbKey) and the dialog's
 * entities map, decide which in-memory ids / extra dbKeys to remove.
 */
export function planDeleteMessageCascade(
  msg: Message | undefined,
  entities: Record<string, Message | undefined>
): DeleteMessageCascadePlan {
  const msgId = msg?.id;
  let extraRemoveId: string | undefined;
  let extraRemoveDbKey: string | undefined;

  if (msg?.role === "tool" && msg.parentMessageId) {
    const parent = entities[msg.parentMessageId];

    if (parent && parent.role === "assistant" && isAssistantToolStub(parent)) {
      const hasOtherToolMsgs = Object.values(entities).some(
        (m) =>
          m &&
          m.role === "tool" &&
          m.parentMessageId === msg.parentMessageId &&
          m.dbKey !== msg.dbKey
      );

      if (!hasOtherToolMsgs) {
        extraRemoveId = parent.id;
        extraRemoveDbKey = parent.dbKey as string | undefined;
      }
    }
  }

  return { id: msgId, extraRemoveId, extraRemoveDbKey };
}
