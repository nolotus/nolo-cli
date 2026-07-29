import { callToolApi } from "./toolApiClient";

const SHARED_PARAMS = {
  type: "object",
  properties: {
    audioUrl: {
      type: "string",
      description:
        "音频来源：内部文件 ID (file-... 或 ULID)、公开 http/https URL，或 base64 data URI（data:audio/...;base64,...）。支持 mp3、wav、m4a、ogg、flac 等常见格式。",
    },
    language: {
      type: "string",
      description:
        "可选，指定音频语言以提升精度（如 'zh'、'en'、'ja'）。不指定则自动检测。",
    },
  },
  required: ["audioUrl"],
};

// ── whisper-large-v3-turbo（快速、便宜）──────────────────

export const whisperTurboSchema = {
  name: "whisper_turbo",
  description:
    "使用 openai/whisper-large-v3-turbo 对音频进行语音转文字（ASR）。速度快、价格低（$0.0002/min），适合大多数场景的实时或批量转录。",
  parameters: SHARED_PARAMS,
};

export const whisperTurboFunc = async (
  input: any,
  thunkApi: any
): Promise<any> => {
  const { audioUrl, language } = input;
  const data = await callToolApi(
    thunkApi,
    "/api/whisper-turbo",
    { audioUrl, language },
    { withAuth: true }
  );
  return {
    summary: "Transcription completed",
    text: data.text || "",
    language: data.language,
    duration: data.duration,
    rawData: data,
  };
};

// ── whisper-large-v3（高精度）────────────────────────────

export const whisperV3Schema = {
  name: "whisper_v3",
  description:
    "使用 openai/whisper-large-v3 对音频进行高精度语音转文字（ASR）。精度更高（尤其多语言/中文），价格稍高（$0.00045/min），适合对准确率要求严格的场景。",
  parameters: SHARED_PARAMS,
};

export const whisperV3Func = async (
  input: any,
  thunkApi: any
): Promise<any> => {
  const { audioUrl, language } = input;
  const data = await callToolApi(
    thunkApi,
    "/api/whisper-v3",
    { audioUrl, language },
    { withAuth: true }
  );
  return {
    summary: "Transcription completed",
    text: data.text || "",
    language: data.language,
    duration: data.duration,
    rawData: data,
  };
};
