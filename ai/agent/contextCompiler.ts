// Simple deterministic hash for cache-key purposes (browser + server compatible)
function createHash(_algo: string) {
  let buf = "";
  return {
    update(s: string) { buf += s; return this; },
    digest(_enc: string) {
      // FNV-1a 32-bit, hex-padded to 8 chars
      let h = 0x811c9dc5;
      for (let i = 0; i < buf.length; i++) {
        h ^= buf.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
      }
      return h.toString(16).padStart(8, "0");
    },
  };
}

export type ContextLayerOwner =
  | "platform"
  | "agent"
  | "user"
  | "runtime";

export type ContextLayerCacheScope = "static" | "session" | "turn";

export type ContextLayer = {
  id: string;
  owner: ContextLayerOwner;
  content?: string | null;
  tokenBudget?: number;
  cacheScope?: ContextLayerCacheScope;
};

export type CompiledContextLayer = {
  id: string;
  owner: ContextLayerOwner;
  content: string;
  cacheScope: ContextLayerCacheScope;
  charCount: number;
  estimatedTokens: number;
  tokenBudget?: number;
  budgetStatus?: "within-budget" | "over-budget";
};

export type CompiledContext = {
  content: string;
  layers: CompiledContextLayer[];
  cacheProfile: {
    stablePrefixHash: string;
    stablePrefixLayerIds: string[];
    stablePrefixCharCount: number;
    stablePrefixEstimatedTokens: number;
  };
};

const hasLayerContent = (
  layer: ContextLayer
): layer is ContextLayer & { content: string } => Boolean(layer.content);

export const estimateContextTokens = (content: string): number =>
  Math.ceil(content.length / 4);

export const compileContextLayers = (
  layers: ContextLayer[]
): CompiledContext => {
  const compiledLayers = layers
    .filter(hasLayerContent)
    .map((layer): CompiledContextLayer => {
      const estimatedTokens = estimateContextTokens(layer.content);
      return {
        id: layer.id,
        owner: layer.owner,
        content: layer.content,
        cacheScope: layer.cacheScope ?? "turn",
        charCount: layer.content.length,
        estimatedTokens,
        tokenBudget: layer.tokenBudget,
        budgetStatus:
          typeof layer.tokenBudget === "number"
            ? estimatedTokens <= layer.tokenBudget
              ? "within-budget"
              : "over-budget"
            : undefined,
      };
    });
  const stablePrefixLayers: CompiledContextLayer[] = [];
  for (const layer of compiledLayers) {
    if (layer.cacheScope === "turn") break;
    stablePrefixLayers.push(layer);
  }
  const stablePrefixContent = stablePrefixLayers
    .map((layer) => layer.content)
    .join("\n\n");

  return {
    content: compiledLayers.map((layer) => layer.content).join("\n\n"),
    layers: compiledLayers,
    cacheProfile: {
      stablePrefixHash: createHash("sha256")
        .update(stablePrefixContent)
        .digest("hex"),
      stablePrefixLayerIds: stablePrefixLayers.map((layer) => layer.id),
      stablePrefixCharCount: stablePrefixContent.length,
      stablePrefixEstimatedTokens: estimateContextTokens(stablePrefixContent),
    },
  };
};
