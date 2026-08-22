// packages/ai/agent/imagePreprocessing.ts
//
// Vision 预处理管道：纯文本 LLM 收到图片时，先用一个便宜的 vision 模型把图片
// 描述成文字，替换 image_url part，让文本 LLM 能"看到"图片内容。
//
// 设计原则：
// - 共享逻辑在此文件，两条路径（local runtime / web stream）各自提供 describeImage 回调
// - 失败时返回原始 messages（不阻断），由调用方 fallback 到剥离/拒绝
// - 一次批量描述调用：所有图片的 url 传给同一个 vision 请求，返回的统一描述替换所有 image_url part

import type { AgentRuntimeChatMessage, AgentRuntimeMessageContent } from "../../agent-runtime/types";
import { PUBLIC_QWEN_37_FLASH_AGENT_KEY } from "../../core/builtinAgents";
import { resolveBuiltinPlatformAgentConfig } from "../../agent-runtime/builtinPlatformAgentConfigs";
import type { AgentRuntimeAgentConfig, AgentRuntimeHostAdapter } from "../../agent-runtime/hostAdapter";
import { PLATFORM_HOSTED_QWEN_37_FLASH_MODEL } from "../llm/platformHosted";
import { resolveAgentImageInputSupport } from "../llm/agentCapabilities";

/** 默认 vision 预处理 agent key（Qwen 3.7 Flash，便宜视觉模型） */
export const DEFAULT_IMAGE_PREPROCESSOR_AGENT_KEY = PUBLIC_QWEN_37_FLASH_AGENT_KEY;

/** 描述图片的 prompt — 针对用户故事优化：大部分是界面截图或生活照片 */
const DESCRIBE_IMAGE_PROMPT = `你是一个专业的图片描述助手。请极其详细地描述这张图片，目标是让一个看不到图片的 AI 助手能完全理解图片内容。

请按以下结构描述：

1. **图片类型**：这是界面截图、照片、图表、文档、还是其他类型？

2. **如果是界面截图**：
   - 列出所有可见的 UI 元素：标题栏、导航菜单、按钮、输入框、列表项等
   - 逐个描述每个元素的文字内容和位置（如"左上角"、"右侧栏"）
   - 描述颜色主题、布局结构、当前状态（如选中、hover、loading）
   - 如果有弹窗/对话框/通知，完整记录其文字内容

3. **如果是生活照片**：
   - 场景/环境：室内/室外、地点类型、时间感（白天/夜晚）
   - 人物：人数、姿势、表情、穿着、动作
   - 物体：前景/背景中的所有显著物体
   - 光线、天气、氛围

4. **如果是图表/数据图**：
   - 图表类型（柱状图/折线图/饼图等）
   - 坐标轴标签、数值范围、单位
   - 关键数据点和趋势
   - 图例、标题

5. **所有可见文字**：逐字记录图片中出现的所有文字（UI 文字、路牌、标签、水印等），保留原文。

6. **颜色和布局**：主色调、布局结构、空间关系。

请尽可能详细，不要遗漏任何可见信息。`;

/**
 * 从消息数组中提取所有 image_url 的 url。
 */
export function extractImageUrlsFromMessages(messages: AgentRuntimeChatMessage[]): string[] {
  const urls: string[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (
        part &&
        typeof part === "object" &&
        part.type === "image_url" &&
        part.image_url &&
        typeof part.image_url.url === "string" &&
        part.image_url.url.trim()
      ) {
        urls.push(part.image_url.url);
      }
    }
  }
  return urls;
}

/**
 * 判断消息数组中是否包含 image_url part。
 */
export function hasImageInRuntimeMessages(messages: AgentRuntimeChatMessage[]): boolean {
  return extractImageUrlsFromMessages(messages).length > 0;
}

/**
 * describeImage 回调签名：接收一组 image url，返回文字描述（或 null 表示失败）。
 */
export type DescribeImageFn = (imageUrls: string[]) => Promise<string | null>;

/** 内存级图片描述缓存：相同 URL 组在同会话或多次循环迭代中只调一次视觉模型 */
const IMAGE_DESCRIPTION_CACHE = new Map<string, string>();

export function clearImageDescriptionCache(): void {
  IMAGE_DESCRIPTION_CACHE.clear();
}

function cacheKeyForUrls(urls: string[]): string {
  return urls.slice().sort().join("||");
}

/**
 * 核心：用 vision 模型把消息中的 image_url part 替换为文字描述。
 *
 * - 无 image_url → 原样返回
 * - describeImage 返回 null（失败）→ 原样返回（调用方 fallback）
 * - describeImage 成功 → 所有 image_url part 替换为 `[图片描述] {text}` text part
 *
 * 一次批量描述：所有图片的 url 传给同一个 vision 请求，返回的统一描述替换所有 image_url part。
 */
export async function preprocessImagesForTextOnlyAgent(
  messages: AgentRuntimeChatMessage[],
  describeImage: DescribeImageFn,
): Promise<AgentRuntimeChatMessage[]> {
  const imageUrls = extractImageUrlsFromMessages(messages);
  if (imageUrls.length === 0) return messages;

  const key = cacheKeyForUrls(imageUrls);
  let description = IMAGE_DESCRIPTION_CACHE.get(key);

  if (!description) {
    // 调用 vision 模型描述所有图片
    const rawDesc = await describeImage(imageUrls);
    if (rawDesc === null || !rawDesc.trim()) return messages;
    description = rawDesc.trim();
    IMAGE_DESCRIPTION_CACHE.set(key, description);
  }

  const descriptionText = `[图片描述] ${description}`;

  // 替换所有消息中的 image_url part 为描述文本
  return messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const hasImage = msg.content.some((p) => p?.type === "image_url");
    if (!hasImage) return msg;

    const newContent: AgentRuntimeMessageContent = msg.content
      .map((part) => {
        if (part && typeof part === "object" && part.type === "image_url") {
          return { type: "text" as const, text: descriptionText };
        }
        return part;
      })
      .filter((p) => p !== null && p !== undefined) as AgentRuntimeMessageContent;

    return { ...msg, content: newContent };
  });
}

/**
 * Local runtime 版 describeImage：通过 hostAdapter 解析 vision provider，
 * 用 provider.complete 调一次非流式 vision 模型调用。
 *
 * 参数不对称说明：本函数接收 AgentRuntimeAgentConfig 对象（因为 local
 * runtime 需要完整 config 来解析 provider），而 describeImageViaServerProxy
 * 只接收 agentKey string（因为 web 通过 server proxy 路由，只需 key）。
 * 两者共用 buildDescribeContentParts + resolveDefaultVisionModelConfig。
 *
 * 失败返回 null（不抛错，由调用方处理 fallback）。
 */
export async function describeImageWithLocalProvider(
  adapter: AgentRuntimeHostAdapter,
  imageUrls: string[],
  visionAgentConfig?: AgentRuntimeAgentConfig,
): Promise<string | null> {
  if (imageUrls.length === 0) return null;

  try {
    // 解析 vision agent 配置（默认 Qwen 3.7 Flash）
    const config = visionAgentConfig ?? resolveBuiltinPlatformAgentConfig(DEFAULT_IMAGE_PREPROCESSOR_AGENT_KEY);
    if (!config) {
      console.warn("[imagePreprocessing] vision agent config not found, skipping");
      return null;
    }

    const visionProvider = await adapter.resolveProvider(config);

    const result = await visionProvider.complete(
      [{ role: "user", content: buildDescribeContentParts(imageUrls) }],
      { timeoutMs: 30_000 },
    );

    const text = result.content?.trim();
    if (!text) return null;
    return text;
  } catch (error) {
    console.warn("[imagePreprocessing] vision describe failed, will fallback:", error);
    return null;
  }
}

/**
 * Web/server 版 describeImage：通过 server proxy 发非流式请求到 vision 模型。
 *
 * 失败返回 null（不抛错，由调用方处理 fallback）。
 */
export async function describeImageViaServerProxy(
  serverUrl: string,
  authToken: string,
  imageUrls: string[],
  visionAgentKey?: string,
): Promise<string | null> {
  if (imageUrls.length === 0) return null;

  const agentKey = visionAgentKey ?? DEFAULT_IMAGE_PREPROCESSOR_AGENT_KEY;
  const { model: visionModel, provider: visionProvider } = resolveDefaultVisionModelConfig(agentKey);

  try {
    const payload = {
      model: visionModel,
      messages: [{ role: "user", content: buildDescribeContentParts(imageUrls) }],
      stream: false,
      provider: visionProvider,
      agentKey,
      // server proxy 需要 url 字段，但 nolo 平台 agent 的上游由 server 端路由，
      // 这里放一个占位 url，server 端会根据 provider/model 覆盖。
      url: "https://api.ollama.com/v1/chat/completions",
    };

    const response = await fetch(`${serverUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      console.warn(`[imagePreprocessing] server proxy vision call failed: ${response.status}`);
      return null;
    }

    const data = await response.json() as any;
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
    return null;
  } catch (error) {
    console.warn("[imagePreprocessing] server proxy vision describe failed:", error);
    return null;
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────

type VisionContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/**
 * 构造 vision 描述请求的 content parts：prompt + 所有 image_url。
 * 被 describeImageWithLocalProvider 和 describeImageViaServerProxy 共用。
 */
export function buildDescribeContentParts(imageUrls: string[]): VisionContentPart[] {
  const parts: VisionContentPart[] = [{ type: "text", text: DESCRIBE_IMAGE_PROMPT }];
  for (const url of imageUrls) {
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

/**
 * 从 catalog 解析默认 vision 预处理 agent 的 model / provider。
 * 被 describeImageWithLocalProvider 和 describeImageViaServerProxy 共用。
 */
export function resolveDefaultVisionModelConfig(agentKey?: string): {
  model: string;
  provider: string;
  config: AgentRuntimeAgentConfig | null;
} {
  const key = agentKey ?? DEFAULT_IMAGE_PREPROCESSOR_AGENT_KEY;
  const config = resolveBuiltinPlatformAgentConfig(key);
  return {
    model: config?.model ?? PLATFORM_HOSTED_QWEN_37_FLASH_MODEL,
    provider: config?.provider ?? "nolo",
    config,
  };
}

/**
 * 剥离单条消息 content 里的 image_url parts。模型不支持图片输入时，发上去会 400。
 * 过滤后如果为空则返回占位文本，因为主流 Provider API 要求 user 消息 content 非空。
 */
export const IMAGE_OMITTED_PLACEHOLDER =
  "[Image content omitted: model does not support image input]";

export function stripImagePartsFromContent(
  content: AgentRuntimeMessageContent,
): AgentRuntimeMessageContent {
  if (!Array.isArray(content)) return content;
  const filtered = content.filter((part) => part?.type !== "image_url");
  if (filtered.length === 0) return IMAGE_OMITTED_PLACEHOLDER;
  return filtered as AgentRuntimeMessageContent;
}

export function stripImagePartsFromMessages<T extends { content: unknown }>(
  messages: T[],
): T[] {
  return messages.map((msg) => ({
    ...msg,
    content: stripImagePartsFromContent(msg.content as AgentRuntimeMessageContent),
  }));
}

/**
 * Web / Desktop / RN stream 路径的图片预处理 + 安全降级逻辑。
 *
 * 用于 streamAgentChatTurn.ts 中 Responses API 和 chat.completions 两条路径，
 * 泛型 T 携带消息的额外字段（id / dbKey 等），预处理只操作 content，
 * 不触碰其他字段。
 *
 * 行为：
 * - 模型支持 vision 或无图片：直接返回切分好的 stable/dynamic 消息
 * - 模型不支持 vision 且有图片：
 *   1. 优先调用 vision 预处理模型（如 Qwen 3.7 Flash）转写为详细文字描述
 *   2. 预处理失败或无连接/token 时，优雅降级剥离 image_url 替换为占位文本，
 *      绝不报错中断用户的会话。
 */
export async function tryPreprocessWebImageOrReject<T extends { id?: unknown; content: unknown }>(
  messages: T[],
  agentConfig: unknown,
  initialHistoryIds: Set<unknown>,
  serverUrl: string | null | undefined,
  authToken: string | null | undefined,
): Promise<{
  kind: "ok";
  messages: T[];
  stableMessages: T[];
  dynamicMessages: T[];
}> {
  const supportsVision = resolveAgentImageInputSupport(agentConfig as any);
  const hasImages = hasImageInRuntimeMessages(messages as unknown as AgentRuntimeChatMessage[]);
  const needsPreprocessing = !supportsVision && hasImages;
  if (!needsPreprocessing) {
    // 无需预处理——返回原消息切分
    const firstDynamicIdx = messages.findIndex((m) => m.id && !initialHistoryIds.has(m.id));
    const splitIdx = firstDynamicIdx === -1 ? messages.length : firstDynamicIdx;
    return {
      kind: "ok",
      messages,
      stableMessages: messages.slice(0, splitIdx),
      dynamicMessages: messages.slice(splitIdx),
    };
  }

  let finalMessages = messages;

  if (serverUrl && authToken) {
    try {
      const preprocessed = await preprocessImagesForTextOnlyAgent(
        messages as unknown as AgentRuntimeChatMessage[],
        (urls) => describeImageViaServerProxy(serverUrl, authToken, urls),
      );
      if (preprocessed !== (messages as unknown)) {
        finalMessages = preprocessed as unknown as T[];
      }
    } catch (e) {
      console.warn("[imagePreprocessing] web vision describe error:", e);
    }
  }

  // 预处理未成功（比如未登录/离线/vision 失败）：降级剥离 image_url，防止上游 400 崩溃
  if (finalMessages === messages) {
    finalMessages = stripImagePartsFromMessages(messages);
  }

  const newFirstDynamicIdx = finalMessages.findIndex((m) => m.id && !initialHistoryIds.has(m.id));
  const splitIdx = newFirstDynamicIdx === -1 ? finalMessages.length : newFirstDynamicIdx;
  return {
    kind: "ok",
    messages: finalMessages,
    stableMessages: finalMessages.slice(0, splitIdx),
    dynamicMessages: finalMessages.slice(splitIdx),
  };
}