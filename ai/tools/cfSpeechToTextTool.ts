// packages/ai/tools/cfSpeechToTextTool.ts
// Cloudflare Workers AI Whisper 语音转文字工具
// Docs: https://developers.cloudflare.com/workers-ai/models/whisper/

import { callToolApi } from "./toolApiClient";

export const cfSpeechToTextFunctionSchema = {
  name: "cfSpeechToText",
  description:
    "使用 Cloudflare Workers AI (@cf/openai/whisper) 将音频文件转换为文字。" +
    "支持多种语言，自动识别语言。接受公开可访问的音频 URL。" +
    "价格：$0.00045/分钟，适合偶发的语音转写任务。",
  parameters: {
    type: "object",
    properties: {
      audioUrl: {
        type: "string",
        description: "音频文件的公开访问 URL（支持 mp3、wav、flac、ogg 等格式）。",
      },
    },
    required: ["audioUrl"],
  },
};

export async function cfSpeechToTextFunc(
  args: { audioUrl: string },
  thunkApi: any
): Promise<{ rawData: any; displayData: string }> {
  const { audioUrl } = args;

  if (!audioUrl || typeof audioUrl !== "string") {
    throw new Error("必须提供有效的 audioUrl");
  }

  const data = await callToolApi<{
    text: string;
    wordCount?: number;
    words?: Array<{ word: string; start: number; end: number }>;
    vtt?: string;
    source: string;
  }>(thunkApi, "/api/cf-speech-to-text", { audioUrl }, { withAuth: true });

  return {
    rawData: data,
    displayData:
      `🎤 语音转文字完成\n- 来源: ${data.source}\n- 字数: ${data.wordCount ?? "?"}\n\n` +
      `**转录内容：**\n\n${data.text}`,
  };
}
