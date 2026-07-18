import { isVoiceModel } from "./isVoiceModel";

/**
 * Predicate: does this agent only support live audio mode and
 * cannot be used through normal text chat completions?
 *
 * Returns `true` when the agent is configured for live audio AND its model is
 * a live-preview / native-audio variant that would fail through ordinary
 * OpenAI-compatible text completions.
 */
export function isLiveAudioOnlyAgent(agent: {
  defaultInteractionMode?: string;
  provider?: string;
  model?: string;
}): boolean {
  if (agent.defaultInteractionMode !== "live_audio") return false;
  return isVoiceModel(agent.model, agent.provider);
}