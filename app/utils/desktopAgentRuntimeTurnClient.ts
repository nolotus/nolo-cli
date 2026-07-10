import type {
  AgentRuntimeMessageContent,
  LocalAgentTurnResult,
} from "../../agent-runtime";
import type { LocalAgentToolEvent } from "../../agent-runtime/localLoop";

export type DesktopAgentRuntimeTurnResult =
  | {
      ok: true;
      result: LocalAgentTurnResult;
    }
  | {
      ok: false;
      error: string;
    };

type LlmConfigOverride = {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
};

type RunDesktopAgentRuntimeTurnArgs = {
  agentRef: string;
  input: AgentRuntimeMessageContent;
  runtimeContext?: Record<string, any> | null;
  continueDialogId?: string;
  cwd?: string;
  restrictShellToWorkspace?: boolean;
  fetchImpl?: typeof fetch;
  llmConfigOverride?: LlmConfigOverride;
};

function buildDesktopAgentRuntimeTurnBody(args: RunDesktopAgentRuntimeTurnArgs) {
  const continueDialogId =
    typeof args.continueDialogId === "string"
      ? args.continueDialogId.trim()
      : "";

  return {
    agentRef: args.agentRef,
    input: args.input,
    ...(args.runtimeContext ? { runtimeContext: args.runtimeContext } : {}),
    ...(continueDialogId ? { continueDialogId } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
    ...(args.restrictShellToWorkspace ? { restrictShellToWorkspace: true } : {}),
    ...(args.llmConfigOverride ? { llmConfigOverride: args.llmConfigOverride } : {}),
  };
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
  ...args
}: RunDesktopAgentRuntimeTurnArgs): AsyncGenerator<DesktopStreamEvent, void, unknown> {
  try {
    const response = await fetchImpl("/api/desktop/agent-runtime/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDesktopAgentRuntimeTurnBody(args)),
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
        const { done, value } = await reader.read();
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
      yield {
        type: "error",
        error: error instanceof Error ? error.message : "Stream read error",
      };
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    yield {
      type: "error",
      error: error instanceof Error ? error.message : "Network error failed to connect to local server",
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
      error: error instanceof Error ? error.message : "Failed to run desktop agent runtime turn",
    };
  }
}
