/**
 * OpenCode Go's OpenAI-family route rejects the standard `image_url` object.
 *
 * The gateway at https://opencode.ai/zen/go/v1 accepts, for `gpt-*` models,
 * only the bare-string form of an image part:
 *
 *   ✅ { type: "image_url", image_url: "data:image/png;base64,…" }   → 200
 *   ❌ { type: "image_url", image_url: { url: "data:image/png;…" } } → 400
 *
 * The 400 body is shaped like a success (`choices[0].message` with no content
 * and no `error` field), so the failure surfaces as an unexplained HTTP 400.
 * Measured 2026-08-03 against gpt-5.6-luna with both data: and https: URLs.
 *
 * The inverse is true elsewhere on the same gateway — glm-5.2 answers 422 and
 * minimax-m3 answers 400 for the bare-string form — so this rewrite is scoped
 * to the `gpt-*` models on opencode.ai and must not be applied globally.
 *
 * Dependency-free so both `agent-runtime` (CLI / desktop local runtime) and
 * `integrations/openai` (web / server loop) can share one definition.
 */
import { asTrimmedLowercaseString } from "../trimmedLowercaseString";
import { isImageUrlPart } from "./imageParts";

/** Whether this provider/model pair needs `image_url` as a bare string. */
export function requiresBareImageUrl(args: {
  endpoint?: string;
  provider?: string;
  model?: string;
}): boolean {
  const model = asTrimmedLowercaseString(args.model);
  if (!model.startsWith("gpt-")) return false;

  const provider = asTrimmedLowercaseString(args.provider);
  if (provider === "opencode-go") return true;

  // 只认 Go 的订阅路径。OpenCode Zen（按量付费，/zen/v1）是另一条线路，
  // 没实测过，不能顺手把它一起改写。
  return asTrimmedLowercaseString(args.endpoint).includes("opencode.ai/zen/go");
}

/**
 * Rewrite `image_url: { url }` parts to `image_url: url`, leaving every other
 * part (and any already-bare image part) untouched. Non-array content — the
 * plain-string message body — passes through unchanged.
 */
export function toBareImageUrlContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;

  let changed = false;
  const parts = content.map((part) => {
    if (!isImageUrlPart(part)) return part;
    const imageUrl = part.image_url;
    if (!imageUrl || typeof imageUrl !== "object") return part;
    const url = (imageUrl as { url?: unknown }).url;
    if (typeof url !== "string" || !url) return part;
    changed = true;
    return { ...part, image_url: url };
  });

  return changed ? parts : content;
}

/** Apply {@link toBareImageUrlContent} across a list of chat messages. */
export function toBareImageUrlMessages<T extends { content?: unknown }>(
  messages: readonly T[],
): T[] {
  return messages.map((message) => {
    const content = toBareImageUrlContent(message.content);
    return content === message.content ? message : { ...message, content };
  });
}
