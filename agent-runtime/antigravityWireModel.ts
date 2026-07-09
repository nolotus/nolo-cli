/**
 * Maps logical Antigravity model ids (e.g. gemini-3.1-pro) to Cloud Code Assist wire ids.
 * Ported from @oh-my-pi/pi-catalog variant-collapse + wire profiles (budget transport, default effort).
 */

export type AntigravityWireProfile = {
  modelEnum?: string;
  maxOutputTokens: number;
};

/** Routed upstream wire id + optional generation caps (OMP parity). */
export type ResolvedAntigravityWire = {
  wireModelId: string;
  profile?: AntigravityWireProfile;
};

const WIRE_PROFILES: Readonly<Record<string, AntigravityWireProfile>> = {
  "gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65536 },
  "gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
  "gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65536 },
  "gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535 },
  "gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
  "claude-sonnet-4-6": { maxOutputTokens: 64000 },
  "claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
  "gemini-2.5-flash": { maxOutputTokens: 65536 },
};

/**
 * Default effort for gemini-3.1-pro on Antigravity: low wire id (gemini-3.1-pro-low).
 * High effort would route to gemini-pro-agent per OMP; nolo agents default to low until effort is modeled.
 */
export function resolveAntigravityWireModel(logicalModelId: string): ResolvedAntigravityWire {
  const id = logicalModelId.trim();
  const lower = id.toLowerCase();

  if (lower === "gemini-3.1-pro" || lower === "gemini-3.1-pro-preview") {
    const wireModelId = "gemini-3.1-pro-low";
    return { wireModelId, profile: WIRE_PROFILES[wireModelId] };
  }

  if (WIRE_PROFILES[id]) {
    return { wireModelId: id, profile: WIRE_PROFILES[id] };
  }

  return { wireModelId: id };
}

export function getAntigravityWireProfile(wireModelId: string): AntigravityWireProfile | undefined {
  return WIRE_PROFILES[wireModelId];
}