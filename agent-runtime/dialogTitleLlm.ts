/**
 * CLI-local dialog title generation via the Nolo platform chat proxy.
 *
 * Mirrors the web path (`updateDialogTitleAction` → `runLlm` with
 * `BUILTIN_TITLE_LLM_CONFIG`) but without Redux: it calls the platform chat
 * proxy directly via `resolvePlatformChatProviderConfig` +
 * `buildPlatformChatCompletionRequest`, the same route CLI already uses for
 * agent inference.
 *
 * Login gate: the caller checks `AUTH_TOKEN` presence before invoking; this
 * function still guards via `canUsePlatformChatProvider(env)` so an unauthenticated
 * environment degrades to the fallback title instead of throwing.
 */

import { BUILTIN_TITLE_LLM_CONFIG } from "../chat/dialog/actions/builtinDialogLlm";
import { normalizeDialogTitle } from "../chat/dialog/dialogTitle";
import type { AgentRuntimeChatMessage } from "./types";

type EnvLike = Record<string, string | undefined>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GenerateLocalDialogTitleInput = {
  messages: AgentRuntimeChatMessage[];
  env: EnvLike;
  /** Resolved platform chat provider config (from resolvePlatformChatProviderConfig). */
  resolveProviderConfig: (args: {
    agentConfig: any;
    env: EnvLike;
  }) => Promise<any>;
  /** Builds the { url, init } request pair for the platform chat proxy. */
  buildRequest: (args: {
    providerConfig: any;
    messages: AgentRuntimeChatMessage[];
    stream?: boolean;
  }) => { url: string; init: RequestInit };
  /** Parses the non-streaming JSON response into { content, ... }. */
  parseResponse: (args: { providerConfig: any; data: any }) => { content: string };
  fetchImpl: FetchLike;
  /** Fallback title when LLM is unavailable or fails. */
  fallbackTitle: string;
  /** Abort timeout for the title LLM call (ms). */
  timeoutMs?: number;
};

export type GenerateLocalDialogTitleResult = {
  title: string;
  source: "llm" | "fallback";
};

/**
 * Generate a dialog title by calling the Nolo platform chat proxy with the
 * builtin title LLM config (deepseek-v4-flash). Returns a fallback title on
 * any failure (no auth, no env, network error, parse error).
 */
export async function generateLocalDialogTitle(
  input: GenerateLocalDialogTitleInput,
): Promise<GenerateLocalDialogTitleResult> {
  const { env, messages, fallbackTitle } = input;
  const timeoutMs = input.timeoutMs ?? 15_000;

  // Build the message content for the title LLM: a compact JSON of role+content.
  const visibleMessages = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : extractText(m.content),
    }));

  if (visibleMessages.length === 0) {
    return { title: fallbackTitle, source: "fallback" };
  }

  try {
    const providerConfig = await input.resolveProviderConfig({
      agentConfig: { ...BUILTIN_TITLE_LLM_CONFIG, key: BUILTIN_TITLE_LLM_CONFIG.id },
      env,
    });

    if (!providerConfig?.authToken) {
      return { title: fallbackTitle, source: "fallback" };
    }

    const request = input.buildRequest({
      providerConfig,
      messages: [
        {
          role: "user",
          content: JSON.stringify(
            visibleMessages.map((m) => ({ role: m.role, content: m.content })),
          ),
        },
      ],
      stream: false,
    });

    const res = await input.fetchImpl(request.url, {
      ...request.init,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return { title: fallbackTitle, source: "fallback" };
    }

    const raw = await res.text().catch(() => "");
    const data = safeParseJson(raw);
    if (!data) {
      return { title: fallbackTitle, source: "fallback" };
    }

    const parsed = input.parseResponse({ providerConfig, data });
    const generated = normalizeDialogTitle(parsed.content);

    if (!generated) {
      return { title: fallbackTitle, source: "fallback" };
    }

    return { title: generated, source: "llm" };
  } catch {
    return { title: fallbackTitle, source: "fallback" };
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => part.text ?? "")
      .join(" ");
  }
  return "";
}

function safeParseJson(raw: string): any | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}