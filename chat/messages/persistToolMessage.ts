// Shared durable write path for role=tool messages.
// Web (toolThunks / completions) and desktop local runtime must both use this
// so refresh always reloads the same trajectory UI.

import { asOptionalTrimmedString } from "../../core/optionalString";
import { DataType } from "../../create/types";
import { write } from "../../database/dbSlice";
import type { Message } from "./types";

export type PersistableToolMessage =
  | Message
  | (Record<string, unknown> & {
      id?: unknown;
      dbKey?: unknown;
      isStreaming?: unknown;
    });

export type PersistToolMessageOptions = {
  /**
   * When set, overrides message.isStreaming on the written record.
   * Running tool rows write with true; completed/error rows with false.
   */
  isStreaming?: boolean;
  /**
   * When true, log and swallow write failures.
   * Callers (web toolThunks, desktop turn end, invalid-tool placeholders) pass
   * soft so a LevelDB/write glitch never masquerades as a tool execution failure.
   */
  soft?: boolean;
};

/**
 * Persist one tool message to LevelDB (+ server replication via write action).
 * Strips non-serializable `controller` and forces role/type for durable history.
 */
export async function persistToolMessage(
  dispatch: any,
  message: PersistableToolMessage,
  options: PersistToolMessageOptions = {}
): Promise<void> {
  const id = asOptionalTrimmedString((message as any)?.id);
  const dbKey = asOptionalTrimmedString((message as any)?.dbKey);
  if (!id || !dbKey) {
    const err = new Error(
      `[persistToolMessage] missing id/dbKey (id=${String(id)} dbKey=${String(dbKey)})`
    );
    if (options.soft) {
      console.error(err.message);
      return;
    }
    throw err;
  }

  const { controller: _controller, ...rest } = message as any;
  const isStreaming =
    options.isStreaming !== undefined
      ? options.isStreaming
      : Boolean(rest.isStreaming);

  try {
    const writeRequest = dispatch(
      write({
        data: {
          ...rest,
          id,
          dbKey,
          role: "tool" as const,
          isStreaming,
          type: DataType.MSG,
        },
        customKey: dbKey,
      })
    );
    if (writeRequest && typeof writeRequest.unwrap === "function") {
      await writeRequest.unwrap();
      return;
    }
    await writeRequest;
  } catch (error) {
    console.error("[persistToolMessage] write failed", { id, dbKey, error });
    if (!options.soft) throw error;
  }
}

/** Persist many tool rows in order (desktop turn end / batch). */
export async function persistToolMessages(
  dispatch: any,
  messages: Iterable<PersistableToolMessage>,
  options: PersistToolMessageOptions = {}
): Promise<void> {
  for (const message of messages) {
    await persistToolMessage(dispatch, message, options);
  }
}
