import { selectCurrentServer } from "../../app/settings/settingSlice";
import { getIsDesktopApp } from "../../app/utils/env";
import { selectIdentityToken } from "identity/selectors";
import type { RootState } from "../../app/store";
import type { CliProvider } from "./cliExecutor";
import { isCliProvider } from "./cliProviders";

type CliChatAction = "start" | "turn" | "get" | "close";

type CliChatRequestBase = {
  cliProvider?: CliProvider;
  model?: string;
  systemPrompt?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  enableThinking?: boolean;
  thinkingBudget?: number;
};

function getCliChatRequestConfig(thunkApi: any) {
  const state = thunkApi.getState() as RootState;
  const currentServer = selectCurrentServer(state);
  const token = selectIdentityToken(state);
  if (!currentServer) throw new Error("无法获取当前服务器地址。");
  return { currentServer, token };
}

/** Desktop shell is served by the local host; CLI must hit same-origin so the
 *  local host can spawn the user's CLI (cloud cannot). Do not use currentServer
 *  here — resolveDesktopSafeServer rewrites local URLs to cloud on desktop. */
function resolveCliChatUrl(currentServer: string): string {
  if (getIsDesktopApp()) return "/api/cli/chat";
  return `${currentServer}/api/cli/chat`;
}

function resolveCliScanUrl(): string {
  // Scan only makes sense against the local desktop host (spawn + PATH).
  // Non-desktop callers should skip before fetching.
  return "/api/cli/scan";
}

async function postCliChat(
  thunkApi: any,
  body: Record<string, any>,
  signal?: AbortSignal,
): Promise<Response> {
  const { currentServer, token } = getCliChatRequestConfig(thunkApi);
  return fetch(resolveCliChatUrl(currentServer), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
}

export async function startCliChatSession(
  thunkApi: any,
  args: CliChatRequestBase & { systemPrompt?: string; cliProvider?: CliProvider },
) {
  const response = await postCliChat(thunkApi, {
    action: "start" satisfies CliChatAction,
      cliProvider: args.cliProvider,
      model: args.model,
      systemPrompt: args.systemPrompt,
      reasoningEffort: args.reasoningEffort,
      temperature: args.temperature,
      topP: args.topP,
      frequencyPenalty: args.frequencyPenalty,
      presencePenalty: args.presencePenalty,
      maxTokens: args.maxTokens,
      enableThinking: args.enableThinking,
      thinkingBudget: args.thinkingBudget,
    });
  return response.json();
}

export async function getCliChatSession(
  thunkApi: any,
  args: { sessionId: string },
) {
  const response = await postCliChat(thunkApi, {
    action: "get" satisfies CliChatAction,
    sessionId: args.sessionId,
  });
  return response.json();
}

export async function closeCliChatSession(
  thunkApi: any,
  args: { sessionId: string },
) {
  const response = await postCliChat(thunkApi, {
    action: "close" satisfies CliChatAction,
    sessionId: args.sessionId,
  });
  return response.json();
}

export async function runCliChatTurnNonStreaming(
  thunkApi: any,
  args: CliChatRequestBase & {
    prompt: string;
    sessionId: string;
  },
  signal?: AbortSignal,
) {
  const response = await postCliChat(
    thunkApi,
    {
      action: "turn" satisfies CliChatAction,
      sessionId: args.sessionId,
      prompt: args.prompt,
      model: args.model,
      stream: false,
    },
    signal,
  );
  return response.json();
}

export function createCliChatTurnStream(
  thunkApi: any,
  args: CliChatRequestBase & {
    prompt: string;
    sessionId?: string;
  },
  signal?: AbortSignal,
) {
  return postCliChat(
    thunkApi,
    args.sessionId
      ? {
          action: "turn" satisfies CliChatAction,
          sessionId: args.sessionId,
          prompt: args.prompt,
          model: args.model,
          reasoningEffort: args.reasoningEffort,
          temperature: args.temperature,
          topP: args.topP,
          frequencyPenalty: args.frequencyPenalty,
          presencePenalty: args.presencePenalty,
          maxTokens: args.maxTokens,
          enableThinking: args.enableThinking,
          thinkingBudget: args.thinkingBudget,
        }
      : {
          prompt: args.prompt,
          model: args.model,
          cliProvider: args.cliProvider,
          systemPrompt: args.systemPrompt,
          reasoningEffort: args.reasoningEffort,
          temperature: args.temperature,
          topP: args.topP,
          frequencyPenalty: args.frequencyPenalty,
          presencePenalty: args.presencePenalty,
          maxTokens: args.maxTokens,
          enableThinking: args.enableThinking,
          thinkingBudget: args.thinkingBudget,
        },
    signal,
  );
}

/**
 * Desktop-only: ask local host which whitelist CLIs are on PATH.
 * Non-desktop → [] (no local host to probe). Failures → [] (manual pick).
 */
export async function scanInstalledClis(
  thunkApi?: any,
  signal?: AbortSignal,
): Promise<CliProvider[]> {
  if (!getIsDesktopApp()) return [];

  let token: string | undefined;
  try {
    if (thunkApi?.getState) {
      token = selectIdentityToken(thunkApi.getState() as RootState) || undefined;
    }
  } catch {
    // Logged-out desktop still scans via trusted same-origin.
  }

  try {
    const response = await fetch(resolveCliScanUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: "{}",
      signal,
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { installed?: unknown };
    if (!Array.isArray(data?.installed)) return [];
    return data.installed.filter(isCliProvider);
  } catch {
    return [];
  }
}
