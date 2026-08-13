/**
 * CLI-local dialog title generation via Nolo platform chat proxy or direct providers.
 *
 * Mirrors the web path (`updateDialogTitleAction` → `runLlm` with
 * `BUILTIN_TITLE_LLM_CONFIG`): calls either the platform chat proxy or direct
 * OpenAI-compatible local providers (e.g. Ollama/OpenAI).
 *
 * Degrades gracefully to fallback title on any error or missing auth/config.
 */

import { BUILTIN_TITLE_LLM_CONFIG } from "../chat/dialog/actions/builtinDialogLlm";
import { normalizeDialogTitle } from "../chat/dialog/dialogTitle";
import type { AgentRuntimeChatMessage } from "./types";

type EnvLike = Record<string, string | undefined>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type GenerateLocalDialogTitleInput = {
  messages: AgentRuntimeChatMessage[];
  env: EnvLike;
  agentConfig?: any;
  /** Resolved platform chat provider config (from resolvePlatformChatProviderConfig). */
  resolveProviderConfig?: (args: {
    agentConfig: any;
    env: EnvLike;
  }) => Promise<any>;
  /** Optional fallback resolver for direct OpenAI-compatible local providers (e.g. Ollama/OpenAI). */
  resolveDirectProviderConfig?: (args: {
    agentConfig: any;
    env: EnvLike;
  }) => Promise<any>;
  /** Builds the { url, init } request pair for the platform chat proxy. */
  buildRequest?: (args: {
    providerConfig: any;
    messages: AgentRuntimeChatMessage[];
    stream?: boolean;
  }) => { url: string; init: RequestInit };
  /** Parses the non-streaming JSON response into { content, ... }. */
  parseResponse?: (args: { providerConfig: any; data: any }) => { content: string };
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
 * Generate a dialog title by calling platform chat proxy or direct LLM provider.
 * Returns a fallback title on any failure.
 */
export async function generateLocalDialogTitle(
  input: GenerateLocalDialogTitleInput,
): Promise<GenerateLocalDialogTitleResult> {
  const { env, messages, fallbackTitle } = input;
  const timeoutMs = input.timeoutMs ?? 15_000;

  // Context selection: 1-2 early user turns + 8-10 recent turns
  const normalized = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m, index) => ({
      id: (m as any).id || `msg-${index}`,
      role: m.role,
      content: typeof m.content === "string" ? m.content : extractText(m.content),
    }))
    .filter((m) => Boolean(m.content.trim()));

  if (normalized.length === 0) {
    return { title: fallbackTitle, source: "fallback" };
  }

  const earlyUserTurns = normalized.filter((m) => m.role === "user").slice(0, 2);
  const recentTurns = normalized.slice(-10);
  const seen = new Set<string>();
  const visibleMessages = [...earlyUserTurns, ...recentTurns]
    .filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    })
    .map((m) => {
      const content = m.content.length > 500 ? `${m.content.slice(0, 500)}...` : m.content;
      return { role: m.role, content };
    });

  while (visibleMessages.length > 1 && JSON.stringify(visibleMessages).length > 4000) {
    visibleMessages.shift();
  }

  if (visibleMessages.length === 0) {
    return { title: fallbackTitle, source: "fallback" };
  }

  // 1. Try platform chat proxy if available
  if (input.resolveProviderConfig && input.buildRequest && input.parseResponse) {
    try {
      const providerConfig = await input.resolveProviderConfig({
        agentConfig: { ...BUILTIN_TITLE_LLM_CONFIG, key: BUILTIN_TITLE_LLM_CONFIG.id },
        env,
      });

      if (providerConfig?.authToken) {
        const request = input.buildRequest({
          providerConfig,
          messages: [
            {
              role: "user",
              content: JSON.stringify(visibleMessages),
            },
          ],
          stream: false,
        });

        const res = await input.fetchImpl(request.url, {
          ...request.init,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          const raw = await res.text().catch(() => "");
          const data = safeParseJson(raw);
          if (data) {
            const parsed = input.parseResponse({ providerConfig, data });
            const generated = normalizeDialogTitle(parsed.content);
            if (generated) {
              return { title: generated, source: "llm" };
            }
          }
        }
      }
    } catch {
      // Platform proxy failed; proceed to direct provider fallback if provided.
    }
  }

  // 2. Try direct local OpenAI-compatible provider if available
  if (input.resolveDirectProviderConfig) {
    try {
      // HIGH-1(a): the custom branch of buildProviderExecutionPlan only pulls
      // keys from credentialBroker / apiKeyRef / agentConfig.apiKey and never
      // from env (resolveOpenAiCompatibleApiKey). When we synthesize a
      // directAgentConfig from BUILTIN_TITLE_LLM_CONFIG (apiSource:"custom"),
      // propagate the env key onto agentConfig.apiKey so the custom branch
      // picks it up — otherwise a real OpenAI endpoint (api.openai.com) gets
      // apiKey:"" and always 401s. We do NOT touch providerResolution.ts, so
      // the custom branch's general credential priority is preserved.
      const envApiKey =
        env.OPENAI_API_KEY || env.NOLO_LOCAL_OPENAI_API_KEY || "";
      const directAgentConfig =
        input.agentConfig && input.agentConfig.apiSource !== "platform"
          ? {
              ...input.agentConfig,
              // Fill env key only when the caller's agentConfig has no key of
              // its own; never overwrite an explicit agentConfig.apiKey.
              ...(envApiKey && !input.agentConfig.apiKey
                ? { apiKey: envApiKey }
                : {}),
            }
          : {
              ...BUILTIN_TITLE_LLM_CONFIG,
              apiSource: "custom",
              useServerProxy: false,
              key: BUILTIN_TITLE_LLM_CONFIG.id,
              ...(envApiKey ? { apiKey: envApiKey } : {}),
            };

      const directConfig = await input.resolveDirectProviderConfig({
        agentConfig: directAgentConfig,
        env,
      });

      if (directConfig?.endpoint) {
        const apiKeyHeader = directConfig.apiKeyHeader || "Authorization";
        const apiKey = directConfig.apiKey || "";

        // HIGH-1(b): a remote auth endpoint (e.g. api.openai.com) with no key
        // is doomed to 401 — skip the fetch entirely and degrade to fallback
        // instead of burning a guaranteed-failing request. Local ollama /
        // localhost endpoints with no key are legitimate (no auth required),
        // so they must NOT be skipped here.
        if (!apiKey && isRemoteAuthEndpoint(directConfig.endpoint)) {
          return { title: fallbackTitle, source: "fallback" };
        }

        const authValue =
          apiKeyHeader.toLowerCase() === "authorization" && apiKey && !apiKey.startsWith("Bearer ")
            ? `Bearer ${apiKey}`
            : apiKey;

        const headers: Record<string, string> = {
          "content-type": "application/json",
          ...(apiKey ? { [apiKeyHeader]: authValue } : {}),
        };

        const res = await input.fetchImpl(directConfig.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: directConfig.model || input.agentConfig?.model || BUILTIN_TITLE_LLM_CONFIG.model,
            messages: [
              { role: "system", content: BUILTIN_TITLE_LLM_CONFIG.prompt },
              { role: "user", content: JSON.stringify(visibleMessages) },
            ],
            stream: false,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          const raw = await res.text().catch(() => "");
          const data = safeParseJson(raw);
          const rawContent = data?.choices?.[0]?.message?.content ?? "";
          const generated = normalizeDialogTitle(rawContent);
          if (generated) {
            return { title: generated, source: "llm" };
          }
        }
      }
    } catch {
      // Direct provider fallback failed; degrade to fallback title.
    }
  }

  return { title: fallbackTitle, source: "fallback" };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part: any) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text") return part.text ?? "";
        return "[图片]";
      })
      .filter(Boolean);
    return parts.join(" ");
  }
  if (content && typeof content === "object") {
    const part = content as any;
    if (part.type === "text") return part.text ?? "";
    return "[图片]";
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

/**
 * HIGH-1(b): detect endpoints that require a bearer and will 401 without one.
 * Real OpenAI / hosted auth endpoints (api.openai.com, *.openai.azure.com,
 * api.deepseek.com, generativelanguage.googleapis.com, etc.) reject
 * unauthenticated requests. Local ollama / lmstudio / 127.0.0.1 / localhost /
 * private LAN IPs are intentionally NOT flagged — they legitimately serve
 * without auth. We err on the side of "not doomed" (only flag obvious
 * remote auth hosts) so we never skip a working local provider.
 */
function isRemoteAuthEndpoint(endpoint: string): boolean {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  // Local / private addresses: never require auth, never skip.
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return false;
  }
  // Known remote auth providers: a missing key means guaranteed 401.
  if (
    host === "api.openai.com" ||
    host.endsWith(".openai.com") ||
    host.endsWith(".openai.azure.com") ||
    host === "api.deepseek.com" ||
    host === "api.anthropic.com" ||
    host === "generativelanguage.googleapis.com" ||
    host === "api.together.xyz" ||
    host === "api.groq.com" ||
    host === "openrouter.ai" ||
    host === "api.mistral.ai"
  ) {
    return true;
  }
  // Heuristic: any other public hostname — be conservative and DO NOT skip,
  // because we can't prove it's auth-required (could be a self-hosted no-auth
  // endpoint). Skipping only on a known auth-required host avoids false kills.
  return false;
}
