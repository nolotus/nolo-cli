/**
 * Phase 1 — Agent Call Plan resolver.
 *
 * Single source of truth for { authMethod, transport, upstreamWire, endpoint, headers }.
 * Both client and server derive their behavior from this descriptor so they can
 * never disagree.
 *
 * See plan: docs/plans/2026-07-03-provider-auth-wireformat-decoupling.md §4.1
 */

import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedLowercaseString } from "../core/trimmedLowercaseString";
import type { AgentRuntimeAgentConfig } from "./hostAdapter";
import { isAntigravityOAuthAgent, ANTIGRAVITY_CLOUD_CODE_BASE_URL } from "./antigravityOAuth";
import {
  isOpenAiResponsesModel,
  OPENAI_RESPONSES_ENDPOINT,
  resolvePlatformChatCompletionsEndpoint,
} from "./platformProviderEndpoints";
import { shouldUseServerProxy } from "./serverProxyPolicy";

// Inlined to avoid heavy transitive dependencies from codexResponsesProvider
// (which pulls in node:crypto + integrations/openai/responsesHelpers).
export const CODEX_RESPONSES_URL =
  "https://chatgpt.com/backend-api/codex/responses";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthMethod =
  | { kind: "platform-key" }
  | { kind: "custom-key" }
  | { kind: "oauth"; ref: "chatgpt" | "xai" | "antigravity" | "claude" }
  | { kind: "cli"; provider: string };

export type WireFormat =
  | "chat.completions"
  | "responses"
  | "gemini-cca"
  | "anthropic-messages"
  | "cli";

export type Transport = "direct" | "server-proxy";

export interface AgentCallPlan {
  authMethod: AuthMethod;
  transport: Transport;
  upstreamWire: WireFormat;
  /** Upstream URL (or "" for cli) */
  endpoint: string;
  /** Required HTTP headers like "chatgpt-account-id", "OpenAI-Beta", "originator" */
  requiredHeaders: string[];
  /** Pricing/label only — never drives routing/format */
  vendor: string;
}

/** The format the client actually serializes toward its immediate peer. */
export type ClientWire = "chat.completions" | "responses" | "cli";

/**
 * The format the CLIENT must serialize. This is the invariant that prevents the
 * client/proxy format disagreement (plan §4.2, failure mode F1) — derived from
 * the plan, never re-guessed from `provider`/model (that guessing is what the
 * `provider:"chatgpt"` hack abused).
 *
 * Two proxy behaviors exist, so `server-proxy` does NOT uniformly mean
 * chat.completions:
 * - TRANSLATING routes — the Nolo proxy has a dedicated translator that adapts
 *   the body: antigravity (gemini-cca) and Codex (responses + oauth:chatgpt).
 *   Here the client speaks `chat.completions` and the translator converts.
 * - PASS-THROUGH routes — direct calls AND the generic proxy path, which
 *   forwards the body UNCHANGED to the upstream URL. Here the client must
 *   already speak `upstreamWire` (e.g. platform openai-responses agents send
 *   `input` whether direct or proxied — the proxy just forwards to /v1/responses).
 *
 * This matches today's behavior exactly (equals `isResponseAPIModel` for every
 * agent). Making the generic proxy translate messages→input too (so ALL proxied
 * agents could speak chat.completions) is a separate, optional future step.
 */
export function resolveClientWire(plan: AgentCallPlan): ClientWire {
  if (plan.upstreamWire === "gemini-cca") return "chat.completions";
  if (plan.upstreamWire === "anthropic-messages") return "chat.completions";
  if (
    plan.upstreamWire === "responses" &&
    plan.authMethod.kind === "oauth" &&
    plan.authMethod.ref === "chatgpt"
  ) {
    return "chat.completions";
  }
  return plan.upstreamWire as ClientWire;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const XAI_CHAT_COMPLETIONS_URL = "https://api.x.ai/v1/chat/completions";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Headers required by the Codex (ChatGPT) Responses endpoint */
export const CODEX_REQUIRED_HEADERS = [
  "chatgpt-account-id",
  "OpenAI-Beta",
  "originator",
];

/**
 * Headers required by the Antigravity Cloud Code Assist endpoint.
 *
 * NOTE: the projectId is embedded in the JSON envelope by
 * `antigravityCloudCodeProvider`, NOT sent as an HTTP header — so we only
 * surface `User-Agent` here. Mirrors current behavior exactly.
 */
export const ANTIGRAVITY_REQUIRED_HEADERS = [
  "User-Agent", // antigravity-specific UA (matches getAntigravityUserAgent)
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EnvLike = Record<string, string | undefined>;

/** Transport proxy decision — shared pure seam in serverProxyPolicy. */
function agentShouldUseServerProxy(
  agentConfig: AgentRuntimeAgentConfig,
): boolean {
  return shouldUseServerProxy(agentConfig);
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export function resolveAgentCallPlan(
  agentConfig: AgentRuntimeAgentConfig,
  _env?: EnvLike,
): AgentCallPlan {
  const apiKeyRef = asTrimmedLowercaseString(agentConfig.apiKeyRef);
  const provider = asTrimmedLowercaseString(
    agentConfig.provider ?? agentConfig.apiSource,
  );

  // ── Antigravity (Google Cloud Code Assist) ──
  if (isAntigravityOAuthAgent(agentConfig)) {
    return {
      authMethod: { kind: "oauth", ref: "antigravity" },
      transport: "server-proxy",
      upstreamWire: "gemini-cca",
      endpoint: ANTIGRAVITY_CLOUD_CODE_BASE_URL,
      requiredHeaders: [...ANTIGRAVITY_REQUIRED_HEADERS],
      vendor: provider || "google-antigravity",
    };
  }

  // ── ChatGPT Codex (OAuth → Responses API) ──
  if (apiKeyRef === "chatgpt") {
    return {
      authMethod: { kind: "oauth", ref: "chatgpt" },
      transport: "server-proxy",
      upstreamWire: "responses",
      endpoint: CODEX_RESPONSES_URL,
      requiredHeaders: [...CODEX_REQUIRED_HEADERS],
      vendor: provider || "openai",
    };
  }

  // ── Claude Pro/Max (OAuth → Anthropic Messages API) ──
  if (apiKeyRef === "claude") {
    return {
      authMethod: { kind: "oauth", ref: "claude" },
      transport: "server-proxy",
      upstreamWire: "anthropic-messages",
      endpoint: ANTHROPIC_MESSAGES_URL,
      requiredHeaders: ["anthropic-version", "anthropic-beta"],
      vendor: provider || "anthropic",
    };
  }

  // ── xAI SuperGrok (OAuth → chat.completions) ──
  if (apiKeyRef === "xai") {
    return {
      authMethod: { kind: "oauth", ref: "xai" },
      transport: "server-proxy",
      upstreamWire: "chat.completions",
      endpoint: XAI_CHAT_COMPLETIONS_URL,
      requiredHeaders: [],
      vendor: provider || "xai",
    };
  }

  // ── CLI provider ──
  if (agentConfig.cliProvider || agentConfig.apiSource === "cli" || provider === "cli") {
    return {
      authMethod: { kind: "cli", provider: agentConfig.cliProvider || provider || "codex" },
      transport: "direct",
      upstreamWire: "cli",
      endpoint: "",
      requiredHeaders: [],
      vendor: provider || "cli",
    };
  }

  // ── Custom provider (customProviderUrl) ──
  if (agentConfig.customProviderUrl || agentConfig.apiSource === "custom") {
    const transport = agentShouldUseServerProxy(agentConfig) ? "server-proxy" : "direct";
    const endpoint = asOptionalTrimmedString(agentConfig.customProviderUrl) ?? "";

    // Determine upstreamWire from URL: /responses → responses, else chat.completions
    const upstreamWire: WireFormat = endpoint.includes("/responses")
      ? "responses"
      : "chat.completions";

    return {
      authMethod: { kind: "custom-key" },
      transport,
      upstreamWire,
      endpoint,
      requiredHeaders: [],
      vendor: provider || "custom",
    };
  }

  // ── Platform provider (default) ──
  const transport = agentShouldUseServerProxy(agentConfig) ? "server-proxy" : "direct";

  // OpenAI reasoning/responses models → responses wire
  const useResponses = isOpenAiResponsesModel({
    provider,
    model: agentConfig.model,
    endpointKey: (agentConfig as any).endpointKey,
  });

  const upstreamWire: WireFormat = useResponses ? "responses" : "chat.completions";

  // Compute endpoint for platform providers
  const endpoint = useResponses
    ? OPENAI_RESPONSES_ENDPOINT
    : resolvePlatformChatCompletionsEndpoint(provider) ?? "";

  return {
    authMethod: { kind: "platform-key" },
    transport,
    upstreamWire,
    endpoint,
    requiredHeaders: [],
    vendor: provider || "openai",
  };
}
