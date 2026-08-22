import { randomUUID } from "node:crypto";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import type { AgentRuntimeToolCall } from "./types";
import {
  convertMessagesToResponsesInput,
  toResponsesTools,
  type ResponseInputItem,
} from "../integrations/openai/responsesHelpers";
import { parseSseDataLineObject } from "./sseDataLine";
import { readSseDataValues } from "./sseFrames";
import {
  aggregateResponsesStream,
  codexStreamFailureStatus,
  type CodexStreamFailure,
} from "./responsesSseStream";

export { codexStreamFailureStatus, type CodexStreamFailure };

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
  /** 流内 503（server_is_overloaded）的总尝试次数，默认 3（首次 + 2 次重试）。 */
  maxAttempts?: number;
  /** 注入退避等待，便于测试。 */
  sleep?: (ms: number) => Promise<unknown>;
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

function collectStableInstructions(
  messages: unknown[],
  fallbackPrompt?: string,
): string {
  const systemTexts: string[] = [];
  if (fallbackPrompt?.trim()) systemTexts.push(fallbackPrompt.trim());
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const role = String(message.role ?? "");
    if (role !== "system" && role !== "developer") continue;
    if (typeof message.content === "string") {
      const boundary = Number(message.stable_prefix_chars);
      const text = Number.isFinite(boundary) && boundary > 0
        ? message.content.slice(0, boundary)
        : message.content;
      if (text.trim()) systemTexts.push(text.trim());
    }
  }
  return systemTexts.join("\n\n");
}

function stablePromptCacheKey(parts: unknown[]): string {
  const value = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `nolo-codex-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Codex OAuth has a private Responses wire format. Unlike the public OpenAI /
 * DeepSeek Responses APIs, historical reasoning items use `summary` blocks.
 * Keep this conversion at the Codex boundary so the canonical message model
 * and the public Responses adapter remain provider-neutral.
 */
export function convertMessagesToCodexInput(
  messages: Parameters<typeof convertMessagesToResponsesInput>[0],
): ResponseInputItem[] {
  return convertMessagesToResponsesInput(messages).map((item) => {
    if (item.type !== "reasoning") return item;
    return {
      type: "reasoning",
      summary: item.content.map((part) => ({
        type: "summary_text",
        text: part.text,
      })),
    } as unknown as ResponseInputItem;
  });
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
  const input = convertMessagesToCodexInput(nonSystem as any);
  const instructions = collectInstructions(rawMessages, args.agentConfig.prompt);
  const stableInstructions = collectStableInstructions(rawMessages, args.agentConfig.prompt);
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
    // Keep routing stable across turns and request UUIDs. Growing input/history
    // is intentionally excluded; only stable request-prefix material belongs.
    prompt_cache_key: stablePromptCacheKey([model, stableInstructions, tools ?? []]),
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

/** 只有容量抖动值得重试；鉴权/配额/参数错误重试只会浪费一轮。 */
const RETRYABLE_CODEX_STREAM_STATUSES = new Set([503]);

/** 与 localRuntimeFetchRetry 的通用预算一致：首次 + 2 次重试。 */
const CODEX_STREAM_MAX_ATTEMPTS = 3;

const CODEX_STREAM_RETRY_BASE_DELAY_MS = 500;

async function readSseEvents(response: Response): Promise<Record<string, unknown>[]> {
  return readSseDataValues(response, (line) => {
    const ev = parseSseDataLineObject(line);
    return ev && !Array.isArray(ev) ? ev : null;
  });
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 单次 Codex 请求：不含重试，失败以 { status, body.error } 形式返回。 */
async function callCodexResponsesOnce(
  args: CodexResponsesCallArgs,
  accountId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const fetchImpl = args.fetchImpl ?? fetch;
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
  const { text, toolCalls, usage, failure } = aggregateResponsesStream(events);

  // 流内失败一律当失败上报，即使已经收到部分 text：半条被上游掐断的回复不该
  // 被当成完整回合喂回循环。调用方拿到的是真实状态码 + 上游原文。
  if (failure) {
    return {
      status: codexStreamFailureStatus(failure),
      body: {
        error: {
          message: failure.message,
          ...(failure.code ? { code: failure.code } : {}),
          ...(failure.type ? { type: failure.type } : {}),
        },
      },
    };
  }

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

/**
 * Call the Codex Responses endpoint and return an OpenAI chat.completion body.
 *
 * 容量抖动（`server_is_overloaded`）在这里就地重试：它藏在 HTTP 200 的 SSE 帧里，
 * 传输层的 fetchWithTransientRetry 看不见，只能由本函数负责。
 */
export async function fetchCodexResponsesCompletion(
  args: CodexResponsesCallArgs,
): Promise<{ status: number; body: Record<string, unknown> }> {
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

  const sleep = args.sleep ?? defaultSleep;
  const requestedMaxAttempts = Number(args.maxAttempts);
  const maxAttempts = Number.isFinite(requestedMaxAttempts)
    ? Math.min(10, Math.max(1, Math.floor(requestedMaxAttempts)))
    : CODEX_STREAM_MAX_ATTEMPTS;

  let result = await callCodexResponsesOnce(args, accountId);
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    if (!RETRYABLE_CODEX_STREAM_STATUSES.has(result.status)) break;
    if (args.signal?.aborted) break;
    await sleep(CODEX_STREAM_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    result = await callCodexResponsesOnce(args, accountId);
  }
  return result;
}

/** Detects a ChatGPT Codex OAuth agent (apiKeyRef "chatgpt"). */
export function isCodexOAuthAgent(
  agentConfig: Pick<AgentRuntimeAgentConfig, "apiKeyRef" | "provider"> | null | undefined,
): boolean {
  if (!agentConfig) return false;
  const apiKeyRef = asTrimmedLowercaseString(agentConfig.apiKeyRef);
  return apiKeyRef === "chatgpt";
}
