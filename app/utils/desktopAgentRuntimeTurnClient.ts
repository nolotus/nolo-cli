import type {
  AgentRuntimeMessageContent,
  LocalAgentTurnResult,
} from "../../agent-runtime";

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
  fetchImpl?: typeof fetch;
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
  };
}

function normalizeDesktopAgentRuntimeTurnError(data: any) {
  return typeof data?.error === "string"
    ? data.error
    : "Failed to run desktop agent runtime turn";
}

export async function runDesktopAgentRuntimeTurn({
  fetchImpl = fetch,
  ...args
}: RunDesktopAgentRuntimeTurnArgs): Promise<DesktopAgentRuntimeTurnResult> {
  try {
    const response = await fetchImpl("/api/desktop/agent-runtime/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildDesktopAgentRuntimeTurnBody(args)),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      return {
        ok: false,
        error: normalizeDesktopAgentRuntimeTurnError(data),
      };
    }
    return {
      ok: true,
      result: data.result as LocalAgentTurnResult,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? error.message
        : "Failed to run desktop agent runtime turn",
    };
  }
}
