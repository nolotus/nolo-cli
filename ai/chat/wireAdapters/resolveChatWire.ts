import { isOpenAiResponsesModel } from "../../../agent-runtime/platformProviderEndpoints";
import type { ChatWire } from "./types";

export interface ResolveChatWireInput {
  provider?: string;
  model?: string;
  endpointKey?: string;
  cliProvider?: string;
  customProviderUrl?: string;
  endpoint?: string;
}

export function resolveChatWire(agentOrInput?: ResolveChatWireInput | null): ChatWire {
  if (!agentOrInput) return "completions";

  const { provider, model, endpointKey, cliProvider, customProviderUrl, endpoint } = agentOrInput;

  // 1. cliProvider === "codex" → "codex"；cliProvider === "claude" → "anthropic"
  if (cliProvider === "codex") return "codex";
  if (cliProvider === "claude") return "anthropic";

  // 2. endpointKey === "responses" 或 endpoint/customProviderUrl URL 匹配 /responses(?:[/?#]|$)/ → "responses"
  const responsesUrlPattern = /\/responses(?:[/?#]|$)/;
  if (
    endpointKey === "responses" ||
    (endpoint && responsesUrlPattern.test(endpoint)) ||
    (customProviderUrl && responsesUrlPattern.test(customProviderUrl))
  ) {
    return "responses";
  }

  // 3. provider（小写）∈ {anthropic, claude} → "anthropic"
  const normProvider = provider ? provider.trim().toLowerCase() : "";
  if (normProvider === "anthropic" || normProvider === "claude") {
    return "anthropic";
  }

  // 4. 复用 platformProviderEndpoints 的 isOpenAiResponsesModel 判定
  if (isOpenAiResponsesModel({ provider, model, endpointKey })) {
    return "responses";
  }

  // 5. 其余（openai/openrouter/ollama/本地 localhost/默认）→ "completions"
  return "completions";
}
