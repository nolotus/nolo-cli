// 文件路径: packages/chat/messages/messageContent.ts

/*
 * ==================================================================
 *  /chat/messages/messageContent.ts
 *  - 负责处理 AI 流式内容 & 图片上传
 * ==================================================================
 */

import type { RootState } from "../../app/store";
import { upload } from "../../database/dbSlice";
import { getRuntimeServerContext } from "../../database/runtimeServerContext";
import { dataURLtoFile, waitForFileReady } from "../../app/utils/imageUtils";
import { buildMessageFileContentUrl } from "./fileUrl";

import { ContentType } from "../../app/types";
import { addContentAction } from "../../create/space/content/addContentAction";
import { stripDurableImageInlinePayload } from "./imagePayloadPersistence";

/** 判断 URL 是否为 data:image 开头的 dataURL */
const isDataUrlImage = (url: unknown): url is string =>
  typeof url === "string" && url.startsWith("data:image");

/**
 * 将生成的 dataURL 图片上传为文件，并返回最终 URL。
 * 失败时返回 null，避免把大 base64 图片持久化进 message。
 */
const uploadGeneratedImageDataUrl = async (
  url: string,
  dialogId: string,
  messageId: string,
  index: number,
  dispatch: any,
  getState: () => RootState,
  options?: { spaceId?: string; agentName?: string }
): Promise<string | null> => {
  const fileName = `generated-image-${dialogId}-${messageId}-${index}.png`;
  const file = dataURLtoFile(url, fileName);

  if (!file) {
    console.warn(
      "[messageContent] dataURLtoFile failed, drop generated image inline payload"
    );
    return null;
  }

  const customKey = `generated-image-${dialogId}-${messageId}-${index}`;

  let metadata: any;
  try {
    metadata = await dispatch(upload({ file, customKey }) as any).unwrap();
  } catch (err) {
    console.warn(
      "[messageContent] upload generated image failed, drop inline payload:",
      err
    );
    return null;
  }

  const state = getState() as RootState;
  const { currentServer } = getRuntimeServerContext(state);
  const fileId = (metadata?.dbKey || metadata?.id) as string | undefined;

  if (!currentServer || !fileId) {
    console.warn(
      "[messageContent] missing currentServer or fileId, drop inline payload",
      { currentServer, fileId }
    );
    return null;
  }

  // 如果提供了 spaceId，尝试保存到空间内容
  if (options?.spaceId) {
    try {
      const agentPrefix = options.agentName ? `[${options.agentName}] ` : "";
      const title = `${agentPrefix}Generated Image ${index + 1}`;

      await addContentAction({
        spaceId: options.spaceId,
        contentKey: fileId,
        title,
        type: ContentType.IMAGE,
      }, { dispatch, getState });

      console.log(`[messageContent] Saved generated image to space: ${options.spaceId}`);
    } catch (err) {
      console.error("[messageContent] Failed to save generated image to space:", err);
    }
  }

  const imageUrl = buildMessageFileContentUrl(currentServer, fileId);
  if (!imageUrl) {
    return null;
  }
  const ready = await waitForFileReady(imageUrl);

  if (!ready) {
    console.warn(
      "[messageContent] uploaded generated image not ready, drop inline payload:",
      imageUrl
    );
    return null;
  }

  return imageUrl;
};

/**
 * 遍历 assistant 的 contentBuffer：
 * - 对于 type === "image_url" 且 url 是 dataURL 的项：
 *   - 上传为文件
 *   - 把 url 替换成正式的文件 URL
 * - 其他内容保持不变
 */
export const normalizeAssistantContentBuffer = async (
  contentBuffer: any[],
  dialogId: string,
  messageId: string,
  dispatch: any,
  getState: () => RootState,
  options?: { spaceId?: string; agentName?: string }
): Promise<any[]> => {
  if (!Array.isArray(contentBuffer) || contentBuffer.length === 0) {
    return contentBuffer;
  }

  const updated = await Promise.all(
    contentBuffer.map(async (part, index) => {
      if (
        !part ||
        part.type !== "image_url" ||
        !part.image_url ||
        !isDataUrlImage(part.image_url.url)
      ) {
        return part;
      }

      const newUrl = await uploadGeneratedImageDataUrl(
        part.image_url.url,
        dialogId,
        messageId,
        index,
        dispatch,
        getState,
        options
      );

      if (!newUrl) {
        return {
          type: "text",
          text: "[图片保存失败，请重试生成图片]",
        };
      }

      return stripDurableImageInlinePayload({
        ...part,
        image_url: {
          ...part.image_url,
          url: newUrl,
        },
      });
    })
  );

  return updated;
};

/**
 * 将 Message.content 归一化为纯文本:
 * - string → 直接使用
 * - OpenAI 风格数组 → 拼接 text 片段，image_url 替换为占位符
 * - 其他 → null
 *
 * 共享函数：标题生成 / 摘要生成 / 上下文序列化均可复用
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
