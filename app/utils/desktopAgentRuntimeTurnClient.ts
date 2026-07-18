import { isAbortError } from "../../core/abortError";
import { toErrorMessage } from "../../core/errorMessage";
import { asTrimmedString } from "../../core/trimmedString";
import type {
  AgentRuntimeMessageContent,
  LocalAgentTurnResult,
} from "../../agent-runtime";
import type {
  DesktopAgentRuntimeAgentConfigSnapshot,
  DesktopAgentRuntimeDialogHistorySnapshot,
} from "../../agent-runtime/desktopRequestSnapshot";
import {
  assertDesktopAgentRuntimeTurnBodyHasNoRawSecrets,
  buildDesktopAgentRuntimeAgentConfigSnapshot,
  buildDesktopAgentRuntimeDialogHistorySnapshot,
} from "../../agent-runtime/desktopRequestSnapshot";
import type { LocalAgentToolEvent } from "../../agent-runtime/localLoop";
import { readStreamChunk } from "../../ai/chat/streamReader";

export type DesktopAgentRuntimeTurnResult =
  | {
      ok: true;
      result: LocalAgentTurnResult;
    }
  | {
      ok: false;
      error: string;
    };

type RunDesktopAgentRuntimeTurnArgs = {
  agentRef: string;
  input: AgentRuntimeMessageContent;
  runtimeContext?: Record<string, any> | null;
  continueDialogId?: string;
  cwd?: string;
  restrictShellToWorkspace?: boolean;
  workspaceToolsHint?: boolean;
  /**
   * Pre-built allowlisted snapshot, or a full agent record the client will sanitize.
   * Prefer passing the already-built snapshot from streamAgentChatTurn.
   */
  agentConfigSnapshot?: DesktopAgentRuntimeAgentConfigSnapshot | Record<string, unknown> | null;
  /**
   * Optional dialog history from webview state when host LevelDB has no dialog.
   */
  dialogHistorySnapshot?: DesktopAgentRuntimeDialogHistorySnapshot | null;
  /**
   * Raw client messages used to build dialogHistorySnapshot when snapshot is not pre-built.
   */
  dialogMessages?: unknown[];
  /** User stop / dialog abort. Cancels fetch + body reader when the webview stalls. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

/** Stable client error when a provided agent config cannot be snapshotted for the turn. */
export const DESKTOP_AGENT_CONFIG_SNAPSHOT_BUILD_FAILED =
  "desktop_agent_config_snapshot_invalid";

export function buildDesktopAgentRuntimeTurnBody(args: RunDesktopAgentRuntimeTurnArgs) {
  const continueDialogId = asTrimmedString(args.continueDialogId);

  let agentConfigSnapshot: DesktopAgentRuntimeAgentConfigSnapshot | undefined;
  if (args.agentConfigSnapshot && typeof args.agentConfigSnapshot === "object") {
    // Accept either a pre-built snapshot or a raw agent record.
    // Fail closed: when the client was given a config for the local Desktop path,
    // never silently omit the snapshot (host LevelDB is empty for owner=local).
    const built = buildDesktopAgentRuntimeAgentConfigSnapshot(
      args.agentConfigSnapshot,
      args.agentRef,
    );
    if (!built) {
      throw new Error(DESKTOP_AGENT_CONFIG_SNAPSHOT_BUILD_FAILED);
    }
    agentConfigSnapshot = built;
  }

  let dialogHistorySnapshot: DesktopAgentRuntimeDialogHistorySnapshot | undefined;
  if (args.dialogHistorySnapshot && typeof args.dialogHistorySnapshot === "object") {
    dialogHistorySnapshot = args.dialogHistorySnapshot;
  } else if (Array.isArray(args.dialogMessages) && continueDialogId) {
    dialogHistorySnapshot =
      buildDesktopAgentRuntimeDialogHistorySnapshot({
        dialogId: continueDialogId,
        messages: args.dialogMessages,
        currentInput: args.input,
      }) ?? undefined;
  }

  const body = {
    agentRef: args.agentRef,
    input: args.input,
    ...(args.runtimeContext ? { runtimeContext: args.runtimeContext } : {}),
    ...(continueDialogId ? { continueDialogId } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.restrictShellToWorkspace ? { restrictShellToWorkspace: true } : {}),
    ...(args.workspaceToolsHint ? { workspaceToolsHint: true } : {}),
    ...(agentConfigSnapshot ? { agentConfigSnapshot } : {}),
    ...(dialogHistorySnapshot ? { dialogHistorySnapshot } : {}),
  };

  assertDesktopAgentRuntimeTurnBodyHasNoRawSecrets(body);
  return body;
}

function normalizeDesktopAgentRuntimeTurnError(data: any) {
  return typeof data?.error === "string"
    ? data.error
    : "Failed to run desktop agent runtime turn";
}

export type DesktopStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; event: LocalAgentToolEvent }
  | { type: "done"; result: LocalAgentTurnResult }
  | { type: "error"; error: string };

export async function* runDesktopAgentRuntimeTurnStream({
  fetchImpl = fetch,
  signal,
  ...args
}: RunDesktopAgentRuntimeTurnArgs): AsyncGenerator<DesktopStreamEvent, void, unknown> {
  try {
    if (signal?.aborted) {
      yield { type: "error", error: "The operation was aborted." };
      return;
    }

    const response = await fetchImpl("/api/desktop/agent-runtime/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDesktopAgentRuntimeTurnBody(args)),
      signal,
    });

    if (!response.ok) {
      const data = await response.clone().json().catch(() => null);
      yield {
        type: "error",
        error: data
          ? normalizeDesktopAgentRuntimeTurnError(data)
          : `HTTP ${response.status}: ${response.statusText}`,
      };
      return;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const data = await response.json().catch(() => ({}));
      if (data?.ok === false) {
        yield { type: "error", error: normalizeDesktopAgentRuntimeTurnError(data) };
      } else if (data?.result) {
        yield { type: "done", result: data.result as LocalAgentTurnResult };
      } else {
        yield { type: "error", error: "Desktop runtime response did not include a result" };
      }
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "error", error: "Response body reader not available" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const readLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) return null;
      try {
        return JSON.parse(trimmed.slice(6)) as DesktopStreamEvent;
      } catch (e) {
        console.error("[desktop-client] Failed to parse stream line:", trimmed, e);
        return null;
      }
    };

    try {
      while (true) {
        if (signal?.aborted) {
          yield { type: "error", error: "The operation was aborted." };
          return;
        }
        const { done, value } = await readStreamChunk(reader, { signal });
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const event = readLine(line);
          if (event) yield event;
        }
      }
      buffer += decoder.decode();
      const event = readLine(buffer);
      if (event) yield event;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        yield { type: "error", error: "The operation was aborted." };
        return;
      }
      yield {
        type: "error",
        error: toErrorMessage(error),
      };
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      yield { type: "error", error: "The operation was aborted." };
      return;
    }
    yield {
      type: "error",
      error: toErrorMessage(error),
    };
  }
}

export async function runDesktopAgentRuntimeTurn(
  args: RunDesktopAgentRuntimeTurnArgs
): Promise<DesktopAgentRuntimeTurnResult> {
  try {
    let finalResult: LocalAgentTurnResult | null = null;
    let errorMsg: string | null = null;

    for await (const event of runDesktopAgentRuntimeTurnStream(args)) {
      if (event.type === "done") {
        finalResult = event.result;
      } else if (event.type === "error") {
        errorMsg = event.error;
      }
    }

    if (errorMsg) {
      return { ok: false, error: errorMsg };
    }
    if (!finalResult) {
      return { ok: false, error: "Stream closed without a result" };
    }

    return { ok: true, result: finalResult };
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
    };
  }
}
