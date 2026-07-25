// Wave15 — pure core for finalizeTransientMessageOnError decisions.
// Redux-free so TUI/CLI hosts can reuse the same keep/remove/markError rules.

import type { Message } from "./types";

export type FinalizeTransientOnErrorDecision =
  | { kind: "noop" }
  | { kind: "remove" }
  | {
      kind: "markError";
      changes: Partial<Message>;
    };

function messageHasDisplayContent(content: Message["content"]): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  return Array.isArray(content) && content.length > 0;
}

/**
 * Decide how to finalize a transient (or any) message after a stream/tool error.
 * Empty content → remove; non-empty → stop streaming + error metadata (preserve
 * existing metadata fields). Missing message → noop.
 */
export function resolveFinalizeTransientOnError(
  existing: Message | undefined,
  error?: string
): FinalizeTransientOnErrorDecision {
  if (!existing) return { kind: "noop" };

  if (!messageHasDisplayContent(existing.content)) {
    return { kind: "remove" };
  }

  return {
    kind: "markError",
    changes: {
      isStreaming: false,
      metadata: {
        ...((existing as any).metadata ?? {}),
        error: true,
        ...(error ? { message: error } : {}),
      },
    },
  };
}
