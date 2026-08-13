import { resolveChatWire } from "../chat/wireAdapters";

/**
 * Whether an agent's client-side wire format is OpenAI Responses.
 *
 * Delegates to `resolveChatWire` (wireAdapters) — the single source of truth
 * for client wire resolution. Previously this file mirrored
 * `isOpenAiResponsesModel` (platformProviderEndpoints) with duplicated logic;
 * the mirror drift risk (failure mode F1: client/proxy format disagreement)
 * is why both now converge on `resolveChatWire`.
 *
 * Note: `resolveChatWire` additionally honors endpoint/customProviderUrl
 * matching /responses, so a custom provider pointing at a Responses endpoint
 * is now classified correctly (previously `false` for non-openai providers).
 */
export const isResponseAPIModel = (agentConfig: {
  provider: string;
  endpointKey?: string;
  model?: string;
  cliProvider?: string;
  customProviderUrl?: string;
  endpoint?: string;
}) => resolveChatWire(agentConfig) === "responses";
