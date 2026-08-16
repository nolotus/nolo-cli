import { estimateTokenCount } from "../context/tokenUtils";
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
  /** Stable prefix (static + session layers before first turn) joined. */
  stablePrefixContent: string;
  /** Dynamic suffix (turn layers) joined. */
  dynamicContent: string;
  layers: CompiledContextLayer[];
  cacheProfile: {
    stablePrefixHash: string;
    stablePrefixLayerIds: string[];
    stablePrefixCharCount: number;
    stablePrefixEstimatedTokens: number;
    /**
     * static/session 层因为排在某个 turn 层之后而掉出稳定前缀的 id 列表。
     *
     * 稳定前缀是**连续**的：一旦出现 turn 层，其后所有层——哪怕标了
     * static/session——都不再进入前缀。这类错序不会报错，只会静默让
     * prefix cache 命中率下降，事后极难归因。把它显式算出来，调用方
     * 可以断言为空（见 buildSystemPrompt.test.ts）或落到观测里。
     *
     * 非空时有两种成因，排查需同时考虑：
     * 1. 某个 static/session 层被排到了 turn 层之后；
     * 2. 某个本应稳定的层被**误标成 turn**，于是它之后的稳定层全部掉出前缀。
     *    （此时列出的是受害者，真正的元凶是它前面那个新变成 turn 的层。）
     */
    misorderedLayerIds: string[];
  };
};

const hasLayerContent = (
  layer: ContextLayer
): layer is ContextLayer & { content: string } => Boolean(layer.content);

/**
 * 上下文层的 token 估算。
 *
 * 委托给 `ai/context/tokenUtils` 的唯一实现——它是中文感知的
 * （中文 1.5 tok/字，其他 0.25 tok/字符）。此处原本是平铺 `length / 4`，
 * 对非中文与前者等价，但对中文低估约 6 倍。本仓库的 system prompt 大量是中文，
 * 低估会让 `stablePrefixEstimatedTokens` 这个落库的观测字段失真。
 */
export const estimateContextTokens = (content: string): number =>
  estimateTokenCount(content);

export const compileContextLayers = (
  layers: ContextLayer[]
): CompiledContext => {
  const compiledLayers: CompiledContextLayer[] = [];
  for (const layer of layers) {
    if (!hasLayerContent(layer)) continue;
    const estimatedTokens = estimateContextTokens(layer.content);
    compiledLayers.push({
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
    });
  }
  const stablePrefixLayers: CompiledContextLayer[] = [];
  for (const layer of compiledLayers) {
    if (layer.cacheScope === "turn") break;
    stablePrefixLayers.push(layer);
  }
  const stablePrefixContent = stablePrefixLayers
    .map((layer) => layer.content)
    .join("\n\n");

  const dynamicLayers = compiledLayers.slice(stablePrefixLayers.length);
  const dynamicContent = dynamicLayers
    .map((layer) => layer.content)
    .join("\n\n");

  // 掉出前缀的 static/session 层 = 排序错误的证据（见 misorderedLayerIds 注释）。
  const misorderedLayerIds = dynamicLayers
    .filter((layer) => layer.cacheScope !== "turn")
    .map((layer) => layer.id);

  return {
    content: compiledLayers.map((layer) => layer.content).join("\n\n"),
    stablePrefixContent,
    dynamicContent,
    layers: compiledLayers,
    cacheProfile: {
      stablePrefixHash: createHash("sha256")
        .update(stablePrefixContent)
        .digest("hex"),
      stablePrefixLayerIds: stablePrefixLayers.map((layer) => layer.id),
      stablePrefixCharCount: stablePrefixContent.length,
      stablePrefixEstimatedTokens: estimateContextTokens(stablePrefixContent),
      misorderedLayerIds,
    },
  };
};
