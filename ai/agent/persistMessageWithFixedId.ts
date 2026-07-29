import { DataType } from "../../create/types";
import { write } from "../../database/dbSlice";
import { addUserMessage } from "../../chat/messages/messageSlice";
import type { Message } from "../../chat/messages/types";

export async function persistMessageWithFixedId(
  dispatch: any,
  message: Message
): Promise<void> {
  dispatch(addUserMessage(message));

  const { controller, ...messageToWrite } = message;

  try {
    const writeRequest = dispatch(
      write({
        data: {
          ...messageToWrite,
          type: DataType.MSG,
        },
        customKey: message.dbKey,
      })
    );

    if (writeRequest && typeof writeRequest.unwrap === "function") {
      await writeRequest.unwrap();
      return;
    }

    await writeRequest;
  } catch (error) {
    console.error(
      "[persistMessageWithFixedId] Failed to persist fixed-id message:",
      error
    );
  }
}
