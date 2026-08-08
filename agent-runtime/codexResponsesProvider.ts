import { randomUUID } from "node:crypto";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type { AgentRuntimeToolCall } from "./types";
import {
  convertMessagesToResponsesInput,
  toResponsesTools,
} from "../integrations/openai/responsesHelpers";
import { parseSseDataLineObject } from "./sseDataLine";
import { readSseDataValues } from "./sseFrames";

/**
 * ChatGPT Codex (subscription OAuth) provider.
 *
 * Codex-with-a-ChatGPT-account does NOT use api.openai.com/chat/completions — it
 * uses the ChatGPT backend Responses API at `/backend-api/codex/responses` with
 * the OAuth bearer token plus a `chatgpt-account-id` header. This module
 * translates an OpenAI chat.completions body into a Responses request, calls the
 * Codex endpoint, and aggregates the SSE stream back into an OpenAI
 * chat.completion-shaped body (mirroring antigravityCloudCodeProvider).
 *
 * Wire fingerprint notes (2026-08-04 live check):
 * - Current Plus account returns real `usage_limit_reached`, not Claude-style
 *   policy 429, even with honest/no-originator headers.
 * - We still send Codex-compatible SSE headers + `client_metadata` so the
 *   request shape stays closer to oh-my-pi / codex-rs than a bare bearer call.
 */

export const CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";

/** Pinned Codex client version used by oh-my-pi / recent Codex CLI wire. */
export const CODEX_CLIENT_VERSION = "0.144.1";

/** Official Codex login/request originator (Nolo auth flow uses the same value). */
export const CODEX_ORIGINATOR = "codex_cli_rs";

export const CODEX_OPENAI_BETA = "responses=experimental";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

/** Process-stable installation id for Codex client_metadata. */
const CODEX_INSTALLATION_ID = randomUUID();

/** Extracts chatgpt_account_id from the access-token JWT (namespaced claim). */
export function decodeCodexAccountId(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64").toString("utf8"),
    ) as Record<string, unknown>;
    const claim = payload[OPENAI_AUTH_CLAIM];
    const value =
      claim && typeof claim === "object"
        ? (claim as Record<string, unknown>).chatgpt_account_id
        : undefined;
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

export type CodexResponsesCallArgs = {
  agentConfig: AgentRuntimeAgentConfig;
  accessToken: string;
  accountId?: string;
  openAiBody: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

type CodexRequestIdentity = {
  sessionId: string;
  threadId: string;
  windowId: string;
  turnId: string;
  turnMetadataJson: string;
  clientMetadata: Record<string, string>;
};

export function createCodexRequestIdentity(
  installationId: string = CODEX_INSTALLATION_ID,
): CodexRequestIdentity {
  const sessionId = randomUUID();
  const threadId = randomUUID();
  const windowId = randomUUID();
  const turnId = randomUUID();
  const turnMetadata = {
    installation_id: installationId,
    session_id: sessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: "turn",
    turn_started_at_unix_ms: Date.now(),
  };
  const turnMetadataJson = JSON.stringify(turnMetadata);
  return {
    sessionId,
    threadId,
    windowId,
    turnId,
    turnMetadataJson,
    clientMetadata: {
      "x-codex-installation-id": installationId,
      session_id: sessionId,
      thread_id: threadId,
      "x-codex-window-id": windowId,
      turn_id: turnId,
      "x-codex-turn-metadata": turnMetadataJson,
    },
  };
}

export function buildCodexCompatibilityHeaders(
  identity: CodexRequestIdentity,
  accountId: string,
): Record<string, string> {
  return {
    Authorization: "", // filled by caller with bearer token
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": CODEX_OPENAI_BETA,
    originator: CODEX_ORIGINATOR,
    version: CODEX_CLIENT_VERSION,
    session_id: identity.sessionId,
    conversation_id: identity.sessionId,
    "x-client-request-id": identity.sessionId,
    "session-id": identity.sessionId,
    "thread-id": identity.threadId,
    "x-codex-window-id": identity.windowId,
    "x-codex-turn-metadata": identity.turnMetadataJson,
  };
}

function collectInstructions(
  messages: unknown[],
  agentPrompt: string | undefined,
): string {
  const systemTexts: string[] = [];
  const prompt = agentPrompt?.trim();
  if (prompt) systemTexts.push(prompt);
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const role = String((raw as { role?: unknown }).role ?? "");
    if (role !== "system" && role !== "developer") continue;
    const content = (raw as { content?: unknown }).content;
    const stringContent = asOptionalTrimmedString(content);
    if (stringContent) {
      systemTexts.push(stringContent);
    } else if (Array.isArray(content)) {
      const text = content
        .filter(
          (p): p is { type: "text"; text: string } =>
            !!p && (p as { type?: unknown }).type === "text",
        )
        .map((p) => p.text)
        .join("\n")
        .trim();
      if (text) systemTexts.push(text);
    }
  }
  return systemTexts.join("\n\n");
}

export function buildCodexRequestBody(
  args: CodexResponsesCallArgs,
  identity: CodexRequestIdentity = createCodexRequestIdentity(),
): Record<string, unknown> {
  const rawMessages = Array.isArray(args.openAiBody.messages)
    ? (args.openAiBody.messages as unknown[])
    : [];
  // system/developer messages become `instructions`; the rest become `input`.
  const nonSystem = rawMessages.filter((m) => {
    const role = m && typeof m === "object" ? String((m as { role?: unknown }).role) : "";
    return role !== "system" && role !== "developer";
  });
  const input = convertMessagesToResponsesInput(nonSystem as any);
  const instructions = collectInstructions(rawMessages, args.agentConfig.prompt);
  const model =
    asOptionalTrimmedString(args.openAiBody.model) ??
    asOptionalTrimmedString(args.agentConfig.model) ??
    "gpt-5.5";
  const tools = toResponsesTools(
    Array.isArray(args.openAiBody.tools) ? (args.openAiBody.tools as any[]) : undefined,
  );

  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    store: false,
    prompt_cache_key: identity.sessionId,
    client_metadata: identity.clientMetadata,
  };
  if (instructions) body.instructions = instructions;
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  return body;
}

function aggregateResponsesStream(events: Record<string, unknown>[]) {
  let text = "";
  const toolCalls: AgentRuntimeToolCall[] = [];
  let usage: Record<string, unknown> | undefined;

  for (const ev of events) {
    const type = String(ev.type ?? "");
    if (type === "response.output_text.delta" && typeof ev.delta === "string") {
      text += ev.delta;
      continue;
    }
    if (type === "response.output_item.done") {
      const item = ev.item as Record<string, unknown> | undefined;
      if (item && item.type === "function_call") {
        const name = typeof item.name === "string" ? item.name : "";
        if (name) {
          toolCalls.push({
            id:
              typeof item.call_id === "string" && item.call_id
                ? item.call_id
                : `${name}_${toolCalls.length}`,
            type: "function",
            function: {
              name,
              arguments: typeof item.arguments === "string" ? item.arguments : "{}",
            },
          });
        }
      }
      continue;
    }
    if (type === "response.completed") {
      const response = ev.response as Record<string, unknown> | undefined;
      const u = response?.usage as Record<string, unknown> | undefined;
      if (u) {
        const prompt = typeof u.input_tokens === "number" ? u.input_tokens : 0;
        const completion = typeof u.output_tokens === "number" ? u.output_tokens : 0;
        const total =
          typeof u.total_tokens === "number" ? u.total_tokens : prompt + completion;
        usage = {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: total,
        };
      }
    }
  }
  return { text, toolCalls, usage };
}

async function readSseEvents(response: Response): Promise<Record<string, unknown>[]> {
  return readSseDataValues(response, (line) => {
    const ev = parseSseDataLineObject(line);
    return ev && !Array.isArray(ev) ? ev : null;
  });
}

/** Call the Codex Responses endpoint and return an OpenAI chat.completion body. */
export async function fetchCodexResponsesCompletion(
  args: CodexResponsesCallArgs,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const accountId = args.accountId?.trim() || decodeCodexAccountId(args.accessToken);
  if (!accountId) {
    return {
      status: 401,
      body: {
        error: {
          message:
            "ChatGPT Codex credential is missing chatgpt_account_id. Re-run `nolo auth chatgpt`.",
        },
      },
    };
  }

  const identity = createCodexRequestIdentity();
  const body = buildCodexRequestBody(args, identity);
  const headers = buildCodexCompatibilityHeaders(identity, accountId);
  headers.Authorization = `Bearer ${args.accessToken}`;
  const response = await fetchImpl(CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: args.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    return {
      status: response.status,
      body: { error: { message: errorText || response.statusText } },
    };
  }

  const events = await readSseEvents(response);
  const { text, toolCalls, usage } = aggregateResponsesStream(events);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    status: 200,
    body: {
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      ...(usage ? { usage } : {}),
    },
  };
}

/** Detects a ChatGPT Codex OAuth agent (apiKeyRef "chatgpt"). */
export function isCodexOAuthAgent(
  agentConfig: Pick<AgentRuntimeAgentConfig, "apiKeyRef" | "provider"> | null | undefined,
): boolean {
  if (!agentConfig) return false;
  const apiKeyRef = asTrimmedLowercaseString(agentConfig.apiKeyRef);
  return apiKeyRef === "chatgpt";
}
