import type { Model } from "./types";

// 备注: 因为是中文(国内服务直接人民币计价)，所以不用乘以 7
const MIMO_V25_PRO_PRICE = {
  input: 3,
  output: 6,
  cachingRead: 0.025,
  cachingWrite: 0,
};

const MIMO_V25_PRICE = {
  input: 1,
  output: 2,
  cachingRead: 0.02,
  cachingWrite: 0,
};

const MIMO_LEGACY_PRICE = {
  input: 7,
  output: 21,
  cachingRead: 1.4,
  cachingWrite: 0,
};

const MIMO_TTS_FREE = {
  input: 0,
  output: 0,
  cachingRead: 0,
  cachingWrite: 0,
};

const MIMO_TEXT_MODELS = [
  {
    name: "mimo-v2.5-pro",
    displayName: "Xiaomi: MiMo V2.5 Pro",
  },
  {
    name: "mimo-v2.5",
    displayName: "Xiaomi: MiMo V2.5",
  },
  {
    name: "mimo-v2-pro",
    displayName: "Xiaomi: MiMo V2 Pro",
  },
  {
    name: "mimo-v2-omni",
    displayName: "Xiaomi: MiMo V2 Omni",
    hasAudio: true,
  },
];

const MIMO_TTS_MODELS = [
  {
    name: "mimo-v2.5-tts-voiceclone",
    displayName: "Xiaomi: MiMo V2.5 TTS VoiceClone",
  },
  {
    name: "mimo-v2.5-tts-voicedesign",
    displayName: "Xiaomi: MiMo V2.5 TTS VoiceDesign",
  },
  {
    name: "mimo-v2.5-tts",
    displayName: "Xiaomi: MiMo V2.5 TTS",
  },
  {
    name: "mimo-v2-tts",
    displayName: "Xiaomi: MiMo V2 TTS",
  },
];

export const mimoModels: Model[] = [
  ...MIMO_TEXT_MODELS.map((model): Model => {
    let price = MIMO_LEGACY_PRICE;
    if (model.name === "mimo-v2.5-pro") price = MIMO_V25_PRO_PRICE;
    else if (model.name === "mimo-v2.5") price = MIMO_V25_PRICE;
    
    return {
      ...model,
      hasVision: true,
      price,
      maxOutputTokens: 131072,
      contextWindow: 1048576,
      supportsTool: true,
      supportsReasoningEffort: true,
      description: "MiMo platform chat model.",
    };
  }),
  ...MIMO_TTS_MODELS.map((model): Model => ({
    ...model,
    hasVision: false,
    hasAudio: true,
    price: model.name.includes("v2.5") ? MIMO_TTS_FREE : MIMO_LEGACY_PRICE,
    maxOutputTokens: 32768,
    contextWindow: 32768,
    supportsTool: false,
    supportsReasoningEffort: false,
    description: "MiMo platform TTS model.",
  })),
];
