import { getModelConfig } from "./providers";

export const isResponseAPIModel = (agentConfig: { provider: string; endpointKey?: string; model?: string }) => {
  // Only OpenAI speaks the Responses wire format. DeepSeek did too until the
  // official DeepSeek provider was retired; its models now run on nolo
  // (Ollama Cloud), which is plain chat.completions.
  const provider = agentConfig.provider?.trim().toLowerCase();
  if (provider !== "openai") return false;
  if (agentConfig.endpointKey === "responses") return true;
  if (!agentConfig.model) return false;

  try {
    return getModelConfig("openai", agentConfig.model).endpointKey === "responses";
  } catch {
    return false;
  }
};
