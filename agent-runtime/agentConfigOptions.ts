import type { AgentRuntimeAgentConfig } from "./hostAdapter";

export function pickAgentRuntimeInferenceOptions(agentConfig: AgentRuntimeAgentConfig) {
  return {
    ...(agentConfig.temperature !== undefined ? { temperature: agentConfig.temperature } : {}),
    ...(agentConfig.top_p !== undefined ? { top_p: agentConfig.top_p } : {}),
    ...(agentConfig.frequency_penalty !== undefined ? { frequency_penalty: agentConfig.frequency_penalty } : {}),
    ...(agentConfig.presence_penalty !== undefined ? { presence_penalty: agentConfig.presence_penalty } : {}),
    ...(agentConfig.max_tokens !== undefined ? { max_tokens: agentConfig.max_tokens } : {}),
    ...(agentConfig.reasoning_effort ? { reasoning_effort: agentConfig.reasoning_effort } : {}),
  };
}
