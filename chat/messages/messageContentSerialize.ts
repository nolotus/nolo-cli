// packages/chat/messages/messageContentSerialize.ts

/**
 * 将 Message.content 归一化为纯文本:
 * - string → 直接使用
 * - OpenAI 风格数组 → 拼接 text 片段，image_url 替换为占位符
 * - 其他 → null
 *
 * 纯函数，不包含任何 Redux/Web UI/runtime 依赖
 */
export const serializeMessageContent = (
  content: any,
  imagePlaceholder = "[图片]"
): string | null => {
  if (typeof content === "string") {
    return content.trim() || null;
  }

  if (Array.isArray(content)) {
    const fragments: string[] = [];

    for (const part of content) {
      if (!part || typeof part !== "object") continue;

      if (part.type === "text" && typeof part.text === "string") {
        const text = part.text.trim();
        if (text) fragments.push(text);
      } else if (part.type === "image_url") {
        fragments.push(imagePlaceholder);
      }
    }

    const joined = fragments.join("\n").trim();
    return joined || null;
  }

  return null;
};
