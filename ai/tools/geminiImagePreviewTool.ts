// 文件路径: ai/tools/geminiImagePreviewTool.ts

import { callToolApi } from "./toolApiClient";
import { fileKey } from "../../database/keys";
import { buildDatabaseFileContentUrl } from "../../database/fileUrl";
import { extractCustomId } from "../../core/prefix";

const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview" as const;

type GeminiImageModel =
    | "gemini-3.1-flash-image-preview"
    | "gemini-3-pro-image-preview";

type GeminiImageArg = {
    /**
     * data 可以是：
     * - 纯 Base64（无 data: 前缀）
     * - 完整 dataURL（data:image/png;base64,xxx）
     * - http(s) URL（由服务端拉取并转 Base64）
     *
     * 对于“用户在对话中上传的图片”，推荐直接使用对应 image_url.url。
     */
    data: string;
    mimeType?: string;
};

type GeminiImageCommonArgs = {
    prompt: string;
    images?: GeminiImageArg[];
    aspectRatio?: string;
    imageSize?: "1K" | "2K" | "4K";
};

const selectCurrentDialogKeyFromState = (state: any): string | null =>
    typeof state?.dialog?.currentDialogKey === "string" ? state.dialog.currentDialogKey : null;

const selectCurrentSpaceIdFromState = (state: any): string | null =>
    typeof state?.space?.currentSpaceId === "string" ? state.space.currentSpaceId : null;

const selectUserIdFromState = (state: any): string | null =>
    typeof state?.auth?.currentUser?.userId === "string" ? state.auth.currentUser.userId : null;

const selectCurrentServerFromState = (state: any): string | null =>
    typeof state?.settings?.currentServer === "string" ? state.settings.currentServer : null;

async function addImageContentToSpace(input: {
    thunkApi: any;
    spaceId: string;
    contentKey: string;
    title: string;
}) {
    const injectedAddContentAction = input.thunkApi?.extra?.addContentAction;
    const addContentAction =
        typeof injectedAddContentAction === "function"
            ? injectedAddContentAction
            : (await import("../../create/space/content/addContentAction")).addContentAction;
    await addContentAction(
        {
            spaceId: input.spaceId,
            contentKey: input.contentKey,
            title: input.title,
            type: "image",
        },
        { dispatch: input.thunkApi.dispatch, getState: input.thunkApi.getState }
    );
}

const buildGeminiImageLlmContext = ({
    result,
    userId,
    currentServer,
}: {
    result: any;
    userId?: string | null;
    currentServer?: string | null;
}): string | undefined => {
    const files = Array.isArray(result?.files) ? result.files : [];
    if (files.length === 0) return undefined;

    const lines = [
        "The image generation tool produced the following reusable images.",
        "If you mention, embed, or tabulate these images in a later reply, reuse these exact references and never invent placeholder/example URLs.",
    ];

    for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        const bareFileId =
            typeof file?.fileId === "string" && file.fileId.trim()
                ? file.fileId.trim()
                : "";
        const fileDbKey =
            userId && bareFileId ? fileKey.single(userId, bareFileId) : "";
        const fileUrl = buildDatabaseFileContentUrl(
            currentServer,
            fileDbKey || bareFileId
        );
        const originalName =
            typeof file?.metadata?.originalName === "string"
                ? file.metadata.originalName.trim()
                : "";
        const prompt =
            typeof file?.metadata?.prompt === "string"
                ? file.metadata.prompt.trim()
                : "";

        lines.push(`image ${index + 1}:`);
        if (bareFileId) lines.push(`- fileId: ${bareFileId}`);
        if (fileDbKey) lines.push(`- fileDbKey: ${fileDbKey}`);
        if (fileUrl) lines.push(`- url: ${fileUrl}`);
        if (originalName) lines.push(`- name: ${originalName}`);
        if (prompt) lines.push(`- prompt: ${prompt}`);
    }

    return lines.join("\n");
};

/* ============================================================================
 * 工具 Schema（供 LLM 调用）
 *   - geminiFlashImage: 默认的 2.5 文生图工具
 *   - geminiProImagePreview: 3 Pro 图像编辑/合成工具
 *
 * 决策逻辑放在提示词层，而不是工具内部逻辑：
 *   - 提示 LLM：简单“生成新图片”用 geminiFlashImage
 *   - 基于现有图片的复杂编辑 / 多图合成用 geminiProImagePreview
 * ========================================================================== */

/**
 * 3.1 文生图 / 轻量编辑：
 * - 适用于「根据文字生成新图片」或「对单张图片做简单修改」场景。
 * - 当用户只提供文字、或只是简单风格/颜色调整优先使用本工具。
 * - 如果需要参考当前对话中用户上传的图片，请在调用时显式传入 images：
 *   - 对每张相关图片，把对应的 image_url.url 或 Base64/dataURL 写入 images[i].data。
 */
export const geminiFlashImageFunctionSchema = {
    name: "geminiFlashImage",
    description: [
        "使用 Gemini 3.1 Flash 图片模型，根据文字说明和可选的输入图片生成图像。",
        "",
        "使用建议（面向模型）：",
        "1. 当用户只是描述希望生成怎样的图片（当前轮没有图片或不需要基于现有图片做复杂编辑）时，优先使用本工具。",
        "2. 当用户上传了一张或多张图片，只需要做简单的风格调整、颜色修改、加一些小元素时，也可以使用本工具，并在 images 中显式传入这些图片。",
        "3. 如果用户明确要进行复杂编辑、精细修图或多图合成，再考虑使用 geminiProImagePreview。",
        "",
        "关于 images：",
        "- 如果是纯文生图：可以不传 images 字段，或传空数组。",
        "- 如果要参考当前对话中用户上传的图片：请在调用时显式构造 images 数组，",
        "  对每一张图片，将该图片在消息中的 image_url.url（或对应的 Base64/dataURL）填入 images[*].data。",
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            prompt: {
                type: "string",
                description: [
                    "描述要生成图片的文字提示。",
                    "示例：",
                    '  - "生成一只坐在沙发上的可爱橘猫，卡通风格"',
                    '  - "给用户上传的这张头像加一个圣诞帽，并做成卡通风格"',
                ].join("\n"),
            },
            images: {
                type: "array",
                description: [
                    "可选的输入图片数组。",
                    "",
                    "用法：",
                    "1. 纯文生图：不传 images，或传空数组。",
                    "2. 需要参考当前轮用户上传的图片时：",
                    "   - 遍历当前用户消息中的相关 image_url，",
                    "   - 对每张图片构造元素 { data: 该图片的 URL 或 Base64/dataURL }，",
                    "   - 通常直接将 image_url.url 原样填入 data 即可。",
                    "",
                    "data 字段支持三种形式：",
                    "  - 不带 data: 前缀的 Base64；",
                    "  - 完整 dataURL（例如 data:image/png;base64,AAAA...）；",
                    "  - http(s) 图片 URL（例如对话消息中的 image_url.url）。",
                ].join("\n"),
                items: {
                    type: "object",
                    properties: {
                        data: {
                            type: "string",
                            description: [
                                "图片数据字符串，可为以下之一：",
                                "1) 纯 Base64（不带 data: 前缀）；",
                                "2) 完整 dataURL，例如 \"data:image/png;base64,AAAA...\"；",
                                "3) http(s) 图片 URL，例如对话消息中的 image_url.url。",
                            ].join("\n"),
                        },
                        mimeType: {
                            type: "string",
                            description: [
                                "可选的 MIME 类型，例如 image/png 或 image/jpeg。",
                                "如果 data 是 http(s) URL 或完整 dataURL，可不填。",
                            ].join("\n"),
                        },
                    },
                    required: ["data"],
                },
            },
            aspectRatio: {
                type: "string",
                description:
                    '生成图片的宽高比，例如 "5:4"、"16:9"、"1:1"。不指定则默认 "5:4"。',
            },
            imageSize: {
                type: "string",
                description:
                    '生成图片的分辨率大小，支持 "1K" | "2K" | "4K"。不指定则默认 "2K"。',
            },
        },
        required: ["prompt"],
    },
};

/**
 * 3 Pro 图像编辑 / 多图合成：
 * - 适用于「基于一张或多张输入图片进行复杂编辑或合成」场景。
 * - 当用户明确要“修改这张图”、“把几张图合成一张”、“精细修图”等，请优先使用本工具。
 * - 调用时应显式传入 images，并确保至少包含一张与用户意图相关的图片。
 */
export const geminiProImagePreviewFunctionSchema = {
    name: "geminiProImagePreview",
    description: [
        "使用 Gemini 3 Pro Image Preview 模型，对一张或多张输入图片进行复杂编辑、合成或高级图像处理。",
        "",
        "使用建议（面向模型）：",
        "1. 当用户希望“修改现有图片”或“把多张图片合成一张”等复杂场景时，优先使用本工具。",
        "2. 调用时应在 images 数组中显式传入本轮用户消息中相关的图片：",
        "   - 对每一张需要参与编辑/合成的图片，将其 image_url.url（或对应的 Base64/dataURL）写入 images[*].data。",
        "3. 如果用户只是在文字上描述想要什么图片、且不依赖现有图片，请优先使用 geminiFlashImage。",
        "",
        "注意：",
        "- 这个模型设计为“编辑 / 合成”场景，通常需要至少一张输入图片。",
        "- 如果没有 images 而尝试调用，后端可能会返回错误。",
    ].join("\n"),
    parameters: {
        type: "object",
        properties: {
            prompt: {
                type: "string",
                description: [
                    "描述如何基于输入图片进行编辑或合成的文字说明。",
                    "示例：",
                    '  - "把这只黄色的猫咪的毛色改成蓝色，保持背景不变"',
                    '  - "把这几张合照中的人合成到同一张办公室场景里，他们在一起合影"',
                ].join("\n"),
            },
            images: {
                type: "array",
                description: [
                    "用于编辑或合成的输入图片数组（强烈建议至少包含一张图片）。",
                    "",
                    "用法：",
                    "1. 遍历当前用户消息中与本次编辑需求相关的 image_url，",
                    "2. 对每一张图片构造元素 { data: 该图片的 URL 或 Base64/dataURL }，",
                    "3. 通常直接使用 image_url.url 作为 data 即可。",
                    "",
                    "data 字段支持：",
                    "  - 纯 Base64；",
                    "  - 完整 dataURL；",
                    "  - http(s) 图片 URL。",
                ].join("\n"),
                items: {
                    type: "object",
                    properties: {
                        data: {
                            type: "string",
                            description: [
                                "图片数据字符串，可为以下之一：",
                                "1) 纯 Base64（不带 data: 前缀）；",
                                "2) 完整 dataURL，例如 \"data:image/png;base64,AAAA...\"；",
                                "3) http(s) 图片 URL，例如对话消息中的 image_url.url。",
                            ].join("\n"),
                        },
                        mimeType: {
                            type: "string",
                            description:
                                "可选的 MIME 类型，例如 image/png 或 image/jpeg。",
                        },
                    },
                    required: ["data"],
                },
            },
            aspectRatio: {
                type: "string",
                description:
                    '生成图片的宽高比，例如 "5:4"、"16:9"、"1:1"。不指定则默认 "5:4"。',
            },
            imageSize: {
                type: "string",
                description:
                    '生成图片的分辨率大小，支持 "1K" | "2K" | "4K"。不指定则默认 "2K"。',
            },
        },
        required: ["prompt"],
    },
};


/* ============================================================================
 * Executor 工厂：根据固定模型生成对应的工具函数
 * ========================================================================== */

const createGeminiImageExecutor =
    (model: GeminiImageModel) =>
        async (
            args: GeminiImageCommonArgs,
            thunkApi: any
        ): Promise<{ rawData: any; displayData: string }> => {
            const { prompt, images = [], aspectRatio, imageSize } = args;

            const trimmedPrompt = prompt?.trim();
            if (!trimmedPrompt) {
                throw new Error("prompt 不能为空");
            }

            const state = thunkApi.getState();
            const currentDialogKey = selectCurrentDialogKeyFromState(state);
            const dialogId = currentDialogKey
                ? extractCustomId(currentDialogKey)
                : undefined;

            const result = await callToolApi(
                thunkApi,
                "/api/gemini-image-preview",
                { prompt: trimmedPrompt, images, aspectRatio, imageSize, model, dialogId },
                { withAuth: true }
            );

            // 将生成的图片自动加入当前 space
            const spaceId = selectCurrentSpaceIdFromState(state);
            const userId = selectUserIdFromState(state);
            const currentServer = selectCurrentServerFromState(state);

            if (spaceId && userId && result?.files?.length) {
                for (let i = 0; i < result.files.length; i++) {
                    const f = result.files[i];
                    if (!f.fileId) continue;
                    const contentKey = fileKey.single(userId, f.fileId);
                    const title = f.metadata?.originalName || `AI Image ${i + 1}`;
                    try {
                        await addImageContentToSpace({ thunkApi, spaceId, contentKey, title });
                    } catch (err) {
                        console.warn("[geminiImageExecutor] Failed to add image to space:", err);
                    }
                }
            }

            const displayText: string =
                result?.text ||
                "已根据提供的文字（以及可选的输入图片）生成新的图像。";
            const llmContext = buildGeminiImageLlmContext({
                result,
                userId,
                currentServer,
            });

            return {
                rawData: result,
                displayData: displayText,
                llmContext,
            };
        };

/* ============================================================================
 * 具体工具执行函数（供工具注册使用）
 * ========================================================================== */

/**
 * geminiFlashImage:
 * - 使用 gemini-3.1-flash-image-preview
 * - 适用于文生图或轻量级基于图片的修改
 */
export const geminiFlashImageFunc = createGeminiImageExecutor(
    "gemini-3.1-flash-image-preview"
);

/**
 * geminiProImagePreview:
 * - 使用 gemini-3-pro-image-preview
 * - 适用于基于一张或多张图片的复杂编辑、合成
 */
export const geminiProImagePreviewFunc = createGeminiImageExecutor(
    "gemini-3-pro-image-preview"
);
