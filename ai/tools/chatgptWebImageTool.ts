import { callToolApi } from "./toolApiClient";
import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import { selectIdentityUserId } from "identity/selectors";
import { selectCurrentServer } from "../../app/settings/settingSlice";
import { selectCurrentDialogConfig, selectCurrentDialogKey } from "../../chat/dialog/dialogSlice";
import { addContentAction } from "../../create/space/content/addContentAction";
import { ContentType } from "../../app/types";
import { fileKey } from "../../database/keys";
import { buildDatabaseFileContentUrl } from "../../database/fileUrl";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asNonEmptyStringArray } from "../../core/stringArray";
import { asTrimmedString } from "../../core/trimmedString";
import { extractCustomId } from "../../core/prefix";

type ChatgptWebImageArgs = {
  prompt: string;
  n?: number;
};

const buildChatgptWebImageLlmContext = ({
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

export const chatgptWebImageGenerateFunctionSchema = {
  name: "chatgptWebImageGenerate",
  description: [
    "使用主人本机 ChatGPT 网页订阅生图；仅内部。",
    "Generate images via the owner's local ChatGPT web subscription; internal only.",
    "失败勿 fallback OpenAI API。Do not fall back to the OpenAI Images API on failure.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "生成图片的提示词 / Image generation prompt.",
      },
      n: {
        type: "number",
        description: "一次生成的图片数量（可选，当前忽略，默认 1）。",
      },
    },
    required: ["prompt"],
  },
};

export const chatgptWebImageGenerateFunc = async (
  args: ChatgptWebImageArgs,
  thunkApi: any
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

  const dialogConfig = selectCurrentDialogConfig(state) as
    | { cybots?: unknown }
    | null
    | undefined;
  const agentKey = asNonEmptyStringArray(dialogConfig?.cybots)[0];

  const result = await callToolApi(
    thunkApi,
    "/api/chatgpt-web-image",
    {
      prompt: trimmedPrompt,
      dialogId,
      ...(agentKey ? { agentKey } : {}),
    },
    { withAuth: true, agentKey }
  );

  const spaceId = selectCurrentSpaceId(state);
  const userId = selectIdentityUserId(state);
  const currentServer = selectCurrentServer(state);

  if (spaceId && userId && result?.files?.length) {
    for (let i = 0; i < result.files.length; i += 1) {
      const file = result.files[i];
      if (!file?.fileId) continue;
      const contentKey = fileKey.single(userId, file.fileId);
      const title =
        file.metadata?.originalName || `ChatGPT Web Image ${i + 1}`;
      try {
        await addContentAction(
          { spaceId, contentKey, title, type: ContentType.IMAGE },
          { dispatch: thunkApi.dispatch, getState: thunkApi.getState }
        );
      } catch (error) {
        console.warn(
          "[chatgptWebImageGenerateFunc] Failed to add image to space:",
          error
        );
      }
    }
  }

  const llmContext = buildChatgptWebImageLlmContext({
    result,
    userId,
    currentServer,
  });

  return {
    rawData: result,
    displayData: result?.text || "已生成图片",
    llmContext,
  };
};
