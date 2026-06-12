import { ContentType } from "../../app/types";
import { addContentAction } from "../../create/space/content/addContentAction";
import { selectCurrentSpaceId } from "../../create/space/spaceSlice";
import { buildDatabaseFileContentUrl } from "../../database/fileUrl";
import { fileKey } from "../../database/keys";
import { selectCurrentServer } from "../../app/settings/settingSlice";
import { selectUserId } from "../../auth/authSlice";
import { callToolApi } from "./toolApiClient";

type RemotionRenderVideoArgs = {
  template?: "mobile-product" | "landscape-product" | "nolo-mobile-product" | "nolo-landscape-product";
  brand?: string;
  hook?: string;
  headline?: string;
  subline?: string;
  prompt?: string;
  cta?: string;
  outputName?: string;
};

export const remotionRenderVideoFunctionSchema = {
  name: "remotionRenderVideo",
  description: [
    "使用平台内 Remotion 模板渲染产品视频，并保存为可复用 MP4 文件。",
    "",
    "适用场景：",
    "- 用户要生成手机传播视频、产品介绍视频、欢迎页短片、Agent/AI 工作流演示视频。",
    "- 需要把文案、标题、输入框示例等参数化后产出 MP4。",
    "",
    "当前模板：",
    "- mobile-product: 9:16 竖版，适合手机传播。",
    "- landscape-product: 16:9 横版，适合官网/演示页。",
    "- 兼容旧别名 nolo-mobile-product / nolo-landscape-product。",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      template: {
        type: "string",
        enum: ["mobile-product", "landscape-product", "nolo-mobile-product", "nolo-landscape-product"],
        description: "视频模板。默认 mobile-product。",
      },
      brand: {
        type: "string",
        description: "品牌名，例如 Nolo.Chat、你的产品名、店铺名或活动名。",
      },
      hook: {
        type: "string",
        description: "竖版视频首屏钩子标题，例如“把一句想法，推进成结果”。",
      },
      headline: {
        type: "string",
        description: "横版视频主标题；竖版缺少 hook 时也会作为 hook 使用。",
      },
      subline: {
        type: "string",
        description: "横版视频副标题。",
      },
      prompt: {
        type: "string",
        description: "手机输入框里逐字打出的示例需求。",
      },
      cta: {
        type: "string",
        description: "结尾行动号召，例如“开始体验”。",
      },
      outputName: {
        type: "string",
        description: "输出文件名，建议以 .mp4 结尾。",
      },
    },
  },
};

export const remotionRenderVideoFunc = async (
  args: RemotionRenderVideoArgs,
  thunkApi: any
): Promise<{ rawData: any; displayData: string; llmContext?: string }> => {
  const result: any = await callToolApi(
    thunkApi,
    "/api/remotion/render",
    {
      template: args.template || "mobile-product",
      brand: args.brand,
      hook: args.hook,
      headline: args.headline,
      subline: args.subline,
      prompt: args.prompt,
      cta: args.cta,
      outputName: args.outputName,
    },
    { withAuth: true }
  );

  const state = thunkApi.getState();
  const userId = selectUserId(state);
  const spaceId = selectCurrentSpaceId(state);
  const currentServer = selectCurrentServer(state);
  const fileId = result?.fileId;
  const metadata = result?.metadata || {};
  const fileDbKey = userId && fileId ? fileKey.single(userId, fileId) : "";
  const url = buildDatabaseFileContentUrl(currentServer, fileDbKey || fileId);

  if (spaceId && fileDbKey) {
    try {
      await addContentAction(
        {
          spaceId,
          contentKey: fileDbKey,
          title: metadata.originalName || "Remotion video.mp4",
          type: ContentType.FILE,
          fileCategory: "video",
        } as any,
        { dispatch: thunkApi.dispatch, getState: thunkApi.getState }
      );
    } catch (error) {
      console.warn("[remotionRenderVideoFunc] Failed to add video to space:", error);
    }
  }

  const displayLines = [
    result?.text || "已使用 Remotion 生成视频。",
    fileId ? `- fileId: ${fileId}` : "",
    fileDbKey ? `- fileDbKey: ${fileDbKey}` : "",
    url ? `- url: ${url}` : "",
    metadata?.size ? `- size: ${metadata.size} bytes` : "",
    result?.template ? `- template: ${result.template}` : "",
  ].filter(Boolean);

  const llmContext = [
    "The Remotion video tool produced a reusable video file.",
    "Reuse these exact references when mentioning or embedding the video:",
    fileId ? `- fileId: ${fileId}` : "",
    fileDbKey ? `- fileDbKey: ${fileDbKey}` : "",
    url ? `- url: ${url}` : "",
    metadata?.originalName ? `- name: ${metadata.originalName}` : "",
    result?.template ? `- template: ${result.template}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    rawData: {
      ...result,
      fileDbKey,
      url,
    },
    displayData: displayLines.join("\n"),
    llmContext,
  };
};
