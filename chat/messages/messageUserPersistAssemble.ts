import { createDialogMessageKeyAndId } from "../../database/keys";
import type { Message } from "./types";
import { resolveMessageOwner } from "./resolveMessageOwner";

/**
 * Wave12 redux-deprecation — pure assembly of a persisted user message.
 *
 * Extracted from `prepareAndPersistMessage` (messageSlice) so the
 * owner-resolution + key/id + full-message shape logic is unit-testable
 * without dispatching Redux thunks. Behaviour is unchanged:
 *   1. resolve owner via {@link resolveMessageOwner}
 *      (dialogConfig.userId → dialog-key owner → current account → "local")
 *   2. derive `dbKey` + `id` from `dialogId` via
 *      {@link createDialogMessageKeyAndId}
 *   3. spread the caller's message and set `id` / `dbKey` / `userId`
 *
 * The thunk keeps owning refs / `addUserMessage` / `write`; this helper only
 * shapes the record. It does NOT mutate the input message (role/content are
 * preserved verbatim via the spread).
 */
export function assemblePersistedUserMessage(input: {
  message: Omit<Message, "id" | "dbKey" | "userId">;
  dialogId: string;
  dialogKey: string;
  currentAccountUserId: string | null;
  dialogConfigUserId: string | null;
}): {
  fullMessage: Message;
  dialogId: string;
  dialogKey: string;
} {
  const {
    message,
    dialogId,
    dialogKey,
    currentAccountUserId,
    dialogConfigUserId,
  } = input;

  const userId = resolveMessageOwner({
    dialogConfigUserId,
    dialogKey,
    currentAccountUserId,
  });

  const { key: messageDbKey, messageId } = createDialogMessageKeyAndId(
    dialogId
  );

  const fullMessage: Message = {
    ...message,
    id: messageId,
    dbKey: messageDbKey,
    userId,
  };

  return { fullMessage, dialogId, dialogKey };
}