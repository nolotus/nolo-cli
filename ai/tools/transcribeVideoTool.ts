import { callToolApi } from "./toolApiClient";

export const transcribeVideoSchema = {
  name: "transcribeVideo",
  description:
    "将视频链接转写为带标点的文本与 SRT 字幕。支持 B 站分 P/合集（默认处理全部，也可指定 p）、YouTube 等 yt-dlp 平台；抖音需在桌面端浏览器使用。下载后不转码，保留原始音轨质量。",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "视频链接（B 站 / YouTube 等）。分 P 合集缺省会处理全部，结果里会列出 processedParts。",
      },
      p: {
        description:
          "可选，1-based 分 P 选择。传单个数字或数字数组；缺省=全部处理（绝不静默只抓第一个）。",
        oneOf: [
          { type: "number" },
          { type: "array", items: { type: "number" } },
        ],
      },
      language: {
        type: "string",
        description: "可选语言提示，默认 zh。",
      },
    },
    required: ["url"],
  },
};

export type TranscribeVideoToolInput = {
  url: string;
  p?: number | number[];
  language?: string;
};

export async function transcribeVideoFunc(
  input: TranscribeVideoToolInput,
  thunkApi: any
): Promise<any> {
  const url = typeof input?.url === "string" ? input.url.trim() : "";
  if (!url) {
    throw new Error("必须提供有效的 url");
  }

  const body: Record<string, unknown> = { url };
  if (input.p !== undefined) body.p = input.p;
  if (input.language !== undefined) body.language = input.language;

  const data = await callToolApi(thunkApi, "/api/transcribe-video", body, {
    withAuth: true,
  });

  const processed =
    Array.isArray(data?.processedParts) && data.processedParts.length
      ? data.processedParts.join(",")
      : "?";
  const available = data?.availableParts ?? "?";
  const preview = String(data?.text || "").slice(0, 240);

  return {
    summary: `视频转写完成（处理分 P: ${processed} / 共 ${available}）`,
    title: data?.title,
    duration: data?.duration,
    text: data?.text || "",
    srt: data?.srt || "",
    degradedChunks: data?.degradedChunks ?? 0,
    processedParts: data?.processedParts,
    availableParts: data?.availableParts,
    parts: data?.parts,
    displayData:
      `🎬 视频转写完成\n` +
      `- 标题: ${data?.title ?? "?"}\n` +
      `- 处理分 P: ${processed}（共 ${available}）\n` +
      `- 降级块: ${data?.degradedChunks ?? 0}\n\n` +
      `**正文预览：**\n\n${preview}${String(data?.text || "").length > 240 ? "…" : ""}`,
    rawData: data,
  };
}
