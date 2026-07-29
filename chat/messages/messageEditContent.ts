import type { Message } from "./types";

/**
 * Build the edited content for a user message replay.
 *
 * Extracted verbatim from `messageSlice` (Wave12 redux-deprecation) so the
 * pure content-shaping logic is testable without the Redux slice. Behaviour is
 * unchanged:
 *   - string content → trimmed next text
 *   - array content → keep all non-text parts, prepend a new text part when
 *     the trimmed next text is non-empty (attachment-only edits are allowed)
 *   - anything else → trimmed next text
 *
 * `editUserMessageAndReplay` imports this; `messageSlice` re-exports it so
 * existing `import { buildEditedMessageContent } from "./messageSlice"` call
 * sites keep compiling.
 */
export const buildEditedMessageContent = (
  originalContent: Message["content"],
  nextText: string
): Message["content"] => {
  const trimmedText = nextText.trim();

  if (typeof originalContent === "string") {
    return trimmedText;
  }

  if (Array.isArray(originalContent)) {
    const nextParts = originalContent.filter(
      (part) => part && typeof part === "object" && part.type !== "text"
    );

    if (trimmedText) {
      nextParts.unshift({ type: "text", text: trimmedText } as any);
    }

    return nextParts;
  }

  return trimmedText;
};