/**
 * Predicate: does this agent only support live audio mode and
 * cannot be used through normal text chat completions?
 *
 * Returns `true` when the agent's model is a live-preview variant that
 * will fail if sent through ordinary OpenAI-compatible text completions.
 */
export function isLiveAudioOnlyAgent(agent: {
  defaultInteractionMode?: string;
  provider?: string;
  model?: string;
}): boolean {
  if (agent.defaultInteractionMode !== "live_audio") return false;

  const provider = String(agent.provider || "").toLowerCase();
  const model = String(agent.model || "").toLowerCase();

  // Google live-preview models are live-only
  if (provider === "google" && model.includes("live")) return true;

  // Gemini Live / native audio models are live-only.
  if (model.includes("live-preview") || model.includes("live-001")) return true;
  if (model.includes("native-audio")) return true;

  return false;
}
