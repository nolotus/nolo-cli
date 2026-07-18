import type { MessageContentPart } from "./types";

type MessageLike = {
  role?: string;
  content?: string | MessageContentPart[] | null;
};

export function separateThinkContent(contentBuffer: MessageContentPart[]) {
  let thinkContent = "";
  let normalContent = "";

  const combinedText = contentBuffer
    .flatMap((c) =>
      c.type === "text" && "text" in c && c.text ? [c.text] : [],
    )
    .join("");

  const thinkMatches = combinedText.match(/<think\b[^>]*>(.*?)<\/think>/gis);

  if (thinkMatches) {
    thinkContent = thinkMatches
      .map((m) => m.replace(/<think\b[^>]*>|<\/think>/gi, ""))
      .join("\n\n");

    normalContent = combinedText
      .replace(/<think\b[^>]*>.*?<\/think>/gis, "")
      .trim();
  } else {
    normalContent = combinedText;
  }

  return { thinkContent, normalContent };
}

export function countImageParts(
  content: string | MessageContentPart[] | null | undefined,
): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part?.type === "image_url").length;
}

export function summarizeMessagesForDebug(
  messages: Array<MessageLike> | null | undefined,
) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  return {
    count: safeMessages.length,
    roles: safeMessages.map((message) => message?.role ?? "unknown"),
    imageMessageCount: safeMessages.filter(
      (message) => countImageParts(message?.content ?? null) > 0,
    ).length,
  };
}

export function finalizeAssistantMessageContent(
  normalizedContentBuffer: MessageContentPart[],
  reasoningBuffer = "",
) {
  const { thinkContent: tagThink, normalContent } =
    separateThinkContent(normalizedContentBuffer);

  const thinkContent = `${tagThink}${reasoningBuffer}`.trim();
  const hasNonTextParts = normalizedContentBuffer.some(
    (part) => part && part.type && part.type !== "text",
  );

  return {
    thinkContent,
    textContent: normalContent || "",
    visibleContent: hasNonTextParts
      ? normalizedContentBuffer
      : normalContent || "",
    hasNonTextParts,
    imagePartCount: countImageParts(normalizedContentBuffer),
  };
}

export function appendSaveFailureToContent(
  content: string | MessageContentPart[] | null | undefined,
): string | MessageContentPart[] {
  const failureText = "[Failed to save message]";
  if (Array.isArray(content)) {
    return [...content, { type: "text", text: failureText }];
  }
  if (typeof content === "string" && content.length > 0) {
    return `${content}\n${failureText}`;
  }
  return failureText;
}
