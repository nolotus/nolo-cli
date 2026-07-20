import { callToolApi } from "./toolApiClient";
import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import { selectIdentityUserId } from "identity/selectors";
import { selectCurrentServer } from "../../app/settings/settingSlice";
import { selectCurrentDialogKey } from "../../chat/dialog/dialogSlice";
import { addContentAction } from "../../create/space/content/addContentAction";
import { ContentType } from "../../app/types";
import { fileKey } from "../../database/keys";
import { buildDatabaseFileContentUrl } from "../../database/fileUrl";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedString } from "../../core/trimmedString";
import { extractCustomId } from "../../core/prefix";

const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1.5" as const;
const DEFAULT_OPENAI_IMAGE_MODEL_V2 = "gpt-image-2" as const;

type OpenAIImageInput = {
  data: string;
  mimeType?: string;
};

type OpenAIImageArgs = {
  prompt: string;
  operation?: "generate" | "edit";
  images?: OpenAIImageInput[];
  mask?: OpenAIImageInput;
  size?: "1024x1024" | "1024x1536" | "1536x1024" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
  outputFormat?: "png" | "jpeg" | "webp";
  outputCompression?: number;
  moderation?: "low" | "auto";
  n?: number;
};

const buildOpenAIImageLlmContext = ({
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
    "If you mention, embed, or tabulate these images later, reuse these exact references and never invent placeholder URLs.",
  ];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const bareFileId = asOptionalTrimmedString(file?.fileId) ?? "";
    const fileDbKey =
      userId && bareFileId ? fileKey.single(userId, bareFileId) : "";
    const fileUrl = buildDatabaseFileContentUrl(
      currentServer,
      fileDbKey || bareFileId
    );
    const originalName = asTrimmedString(file?.metadata?.originalName);

    lines.push(`image ${index + 1}:`);
    if (bareFileId) lines.push(`- fileId: ${bareFileId}`);
    if (fileDbKey) lines.push(`- fileDbKey: ${fileDbKey}`);
    if (fileUrl) lines.push(`- url: ${fileUrl}`);
    if (originalName) lines.push(`- name: ${originalName}`);
  }

  return lines.join("\n");
};

export const openAIGptImageFunctionSchema = {
  name: "openAIGptImage",
  description: [
    "使用 OpenAI GPT Image 1.5 生成或编辑图片。",
    "",
    "使用建议（面向模型）：",
    "1. 当用户要为当前项目生成插画、封面、配图、海报、Logo 草图、背景素材时，优先使用本工具。",
    "2. 如果用户提供了现有图片并要求改图、延展、换背景、加元素，也使用本工具，并在 images 中显式传入相关图片。",
    "3. 这是单轮图片生成/编辑工具；如果只是分析图片内容，不要调用它。",
    "",
    "关于 images：",
    "- 不传 images：文生图。",
    "- 传 images：走图片编辑接口。",
    "- images[*].data 支持 Base64、data URL、或 http(s) URL。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "生成或编辑图片的提示词。",
      },
      images: {
        type: "array",
        description: "可选输入图片。传入后会按图片编辑模式处理。",
        items: {
          type: "object",
          properties: {
            data: {
              type: "string",
              description: "图片数据，可为 Base64、data URL、或 http(s) URL。",
            },
            mimeType: {
              type: "string",
              description: "可选 MIME 类型，例如 image/png 或 image/jpeg。",
            },
          },
          required: ["data"],
        },
      },
      size: {
        type: "string",
        description:
          '输出尺寸，可选 "1024x1024"、"1024x1536"、"1536x1024"、"auto"。',
      },
      quality: {
        type: "string",
        description:
          '输出质量，可选 "low"、"medium"、"high"、"auto"。',
      },
      background: {
        type: "string",
        description:
          '背景，可选 "transparent"、"opaque"、"auto"。',
      },
      outputFormat: {
        type: "string",
        description: '输出格式，可选 "png"、"jpeg"、"webp"。',
      },
      outputCompression: {
        type: "number",
        description: "JPEG/WebP 输出压缩率，0-100。",
      },
      moderation: {
        type: "string",
        description: '内容过滤级别，可选 "low" 或 "auto"。',
      },
      n: {
        type: "number",
        description: "一次生成的图片数量。",
      },
    },
    required: ["prompt"],
  },
};

export const openAIGptImageGenerateFunctionSchema = {
  ...openAIGptImageFunctionSchema,
  name: "openAIGptImageGenerate",
  description:
    "使用 OpenAI GPT Image 2 生成新图片。适合文生图，以及把参考图作为灵感来源生成新画面。GPT Image 2 当前不支持 transparent background，默认传 background: \"opaque\"。如果 outputFormat 是 png（或未显式改成 jpeg/webp），不要传 outputCompression。",
};

export const openAIGptImageEditFunctionSchema = {
  ...openAIGptImageFunctionSchema,
  name: "openAIGptImageEdit",
  description:
    "使用 OpenAI GPT Image 2 编辑现有图片。适合单图编辑、多图参考合成，以及带 mask 的精确修改。优先复用用户已上传的原始 http(s) 图片 URL，不要自己手写 data URL 或重编码缩略图。GPT Image 2 当前不支持 transparent background，默认传 background: \"opaque\"。如果 outputFormat 是 png（或未显式改成 jpeg/webp），不要传 outputCompression。",
};

const runOpenAIImageTool = async (
  args: OpenAIImageArgs,
  thunkApi: any,
  model: string
): Promise<{ rawData: any; displayData: string; llmContext?: string }> => {
  const trimmedPrompt = args.prompt?.trim();
  if (!trimmedPrompt) {
    throw new Error("prompt 不能为空");
  }

  const state = thunkApi.getState();
  const currentDialogKey = selectCurrentDialogKey(state);
  const dialogId = currentDialogKey
    ? extractCustomId(currentDialogKey)
    : undefined;

  const result = await callToolApi(
    thunkApi,
    "/api/openai-image",
    {
      prompt: trimmedPrompt,
      operation: args.operation,
      images: Array.isArray(args.images) ? args.images : [],
      mask: args.mask,
      size: args.size,
      quality: args.quality,
      background: args.background,
      outputFormat: args.outputFormat,
      outputCompression: args.outputCompression,
      moderation: args.moderation,
      n: args.n,
      model,
      dialogId,
    },
    { withAuth: true }
  );

  const spaceId = selectCurrentSpaceId(state);
  const userId = selectIdentityUserId(state);
  const currentServer = selectCurrentServer(state);

  if (spaceId && userId && result?.files?.length) {
    for (let i = 0; i < result.files.length; i += 1) {
      const file = result.files[i];
      if (!file?.fileId) continue;
      const contentKey = fileKey.single(userId, file.fileId);
      const title = file.metadata?.originalName || `OpenAI Image ${i + 1}`;
      try {
        await addContentAction(
          { spaceId, contentKey, title, type: ContentType.IMAGE },
          { dispatch: thunkApi.dispatch, getState: thunkApi.getState }
        );
      } catch (error) {
        console.warn("[openAIGptImageFunc] Failed to add image to space:", error);
      }
    }
  }

  const llmContext = buildOpenAIImageLlmContext({
    result,
    userId,
    currentServer,
  });

  return {
    rawData: result,
    displayData:
      result?.text || "已使用 OpenAI GPT Image 生成新的图片资源。",
    llmContext,
  };
};

export const openAIGptImageGenerateFunc = async (
  args: OpenAIImageArgs,
  thunkApi: any
): Promise<{ rawData: any; displayData: string; llmContext?: string }> => {
  return runOpenAIImageTool(
    { ...args, operation: "generate" },
    thunkApi,
    DEFAULT_OPENAI_IMAGE_MODEL_V2
  );
};

export const openAIGptImageEditFunc = async (
  args: OpenAIImageArgs,
  thunkApi: any
): Promise<{ rawData: any; displayData: string; llmContext?: string }> => {
  return runOpenAIImageTool(
    { ...args, operation: "edit" },
    thunkApi,
    DEFAULT_OPENAI_IMAGE_MODEL_V2
  );
};

export const openAIGptImageFunc = async (
  args: OpenAIImageArgs,
  thunkApi: any
): Promise<{ rawData: any; displayData: string; llmContext?: string }> => {
  return runOpenAIImageTool(args, thunkApi, DEFAULT_OPENAI_IMAGE_MODEL);
};
