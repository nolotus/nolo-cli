import type { ResponsesConversationState } from "./types";

export type ResponsesStateAgentIdentity = {
  provider?: unknown;
  model?: unknown;
};

/** Only OpenAI supports durable previous_response_id conversation state. */
export function supportsResponsesConversationState(
  agent: ResponsesStateAgentIdentity,
): boolean {
  return normalizeIdentityPart(agent.provider) === "openai";
}

const normalizeIdentityPart = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export function normalizeResponsesConversationState(
  value: unknown,
): ResponsesConversationState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const provider = normalizeIdentityPart(raw.provider);
  const model = normalizeIdentityPart(raw.model);
  const responseId = typeof raw.responseId === "string" ? raw.responseId.trim() : "";
  if (!provider || !model || !responseId) return null;
  return { provider, model, responseId };
}

export function selectResponsesConversationState(
  value: unknown,
  agent: ResponsesStateAgentIdentity,
): ResponsesConversationState | null {
  if (!supportsResponsesConversationState(agent)) return null;
  const state = normalizeResponsesConversationState(value);
  if (!state) return null;
  if (state.provider !== normalizeIdentityPart(agent.provider)) return null;
  if (state.model !== normalizeIdentityPart(agent.model)) return null;
  return state;
}

export function updateResponsesConversationState(
  agent: ResponsesStateAgentIdentity,
  responseId: unknown,
): ResponsesConversationState | null {
  if (!supportsResponsesConversationState(agent)) return null;
  const provider = normalizeIdentityPart(agent.provider);
  const model = normalizeIdentityPart(agent.model);
  const normalizedResponseId =
    typeof responseId === "string" ? responseId.trim() : "";
  if (!provider || !model || !normalizedResponseId) return null;
  return { provider, model, responseId: normalizedResponseId };
}

/** Retry statelessly only when the provider explicitly rejects stored state. */
export function isResponsesConversationStateRejection(
  status: number,
  responseBody: unknown,
): boolean {
  if (![400, 404, 409].includes(status)) return false;
  const text = typeof responseBody === "string"
    ? responseBody.trim().toLowerCase()
    : "";
  if (!text) return false;
  const mentionsResponseState =
    /previous[\s_-]*response/.test(text) ||
    /response[\s_-]*(?:id|state)/.test(text);
  const rejectsState =
    /not[\s_-]*found/.test(text) ||
    /does not exist/.test(text) ||
    /invalid/.test(text) ||
    /expired/.test(text) ||
    /unknown/.test(text);
  return mentionsResponseState && rejectsState;
}
