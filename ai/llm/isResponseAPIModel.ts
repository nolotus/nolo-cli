import { getModelConfig } from "./providers";

export const isResponseAPIModel = (agentConfig: { provider: string; endpointKey?: string; model?: string }) => {
  if (agentConfig.provider !== "openai") return false;
  if (agentConfig.endpointKey === "responses") return true;
  if (!agentConfig.model) return false;

  try {
    return getModelConfig("openai", agentConfig.model).endpointKey === "responses";
  } catch {
    return false;
  }
};
