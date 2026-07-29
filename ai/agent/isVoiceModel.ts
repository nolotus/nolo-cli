/**
 * Predicate: is this model a live / native-audio voice model that only works
 * through realtime voice sessions (not ordinary text chat completions)?
 *
 * Pure model-name check — does not depend on `defaultInteractionMode`.
 * The agent edit form uses this to derive the interaction mode from the
 * selected model instead of asking the user to pick it manually.
 */
export function isVoiceModel(
  model?: string | null,
  provider?: string | null,
): boolean {
  const providerLower = String(provider || "").toLowerCase();
  const modelLower = String(model || "").toLowerCase();

  // Google live-preview models are live-only.
  if (providerLower === "google" && modelLower.includes("live")) return true;

  // Gemini Live / native audio models are live-only.
  if (modelLower.includes("live-preview")) return true;
  if (modelLower.includes("live-001")) return true;
  if (modelLower.includes("native-audio")) return true;

  return false;
}