import type { RawUsage } from "./types";

export const APPROX_CHARS_PER_TOKEN = 4;

/** 任意消息内容（string / 多模态数组 / null）→ 用于 token 估算的纯文本。 */
export const stringifyContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as any).text ?? "");
        }
        return "";
      })
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
};

export const estimateMissingUsage = ({
  content,
  minimumOutputTokens = 1,
}: {
  content: unknown;
  minimumOutputTokens?: number;
}): RawUsage => {
  const text = stringifyContent(content);
  const estimatedOutputTokens = Math.max(
    minimumOutputTokens,
    Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
  );

  return {
    input_tokens: 0,
    output_tokens: estimatedOutputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    billing_estimated: true,
  };
};
