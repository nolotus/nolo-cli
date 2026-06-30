import type { Model } from "../../ai/llm/types";
import type { ImageSizeKey } from "../../ai/llm/imagePricing";
import { DEFAULT_GOOGLE_LIVE_AUDIO_MODEL } from "../../ai/agent/liveAudioModel";

const GOOGLE_IMAGE_ASPECT_RATIOS: NonNullable<Model["supportedAspectRatios"]> = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];

const GOOGLE_IMAGE_SIZES: ImageSizeKey[] = ["1K", "2K", "4K"];

const createGoogleImageModel = ({
  name,
  displayName,
  inputPrice,
  outputPrice,
  imageTokenPricePerMillion,
  imageOutputTokenEstimateBySize,
  pricePerImage,
  maxOutputTokens,
  contextWindow,
  imageGenerationWaitTimeSeconds,
  imageGenerationProfiles,
}: {
  name: string;
  displayName: string;
  inputPrice: number;
  outputPrice: number;
  imageTokenPricePerMillion?: number;
  imageOutputTokenEstimateBySize?: NonNullable<Model["imageOutputTokenEstimateBySize"]>;
  pricePerImage?: number;
  maxOutputTokens: number;
  contextWindow: number;
  imageGenerationWaitTimeSeconds?: Model["imageGenerationWaitTimeSeconds"];
  imageGenerationProfiles?: Model["imageGenerationProfiles"];
}): Model => ({
  name,
  displayName,
  provider: "google",
  hasVision: true,
  hasImageOutput: true,
  supportsImageOutput: true,
  supportsImageConfig: true,
  requiresImageModalities: true,
  defaultModalities: ["image", "text"],
  supportedAspectRatios: GOOGLE_IMAGE_ASPECT_RATIOS,
  supportedImageSizes: GOOGLE_IMAGE_SIZES,
  price: {
    input: inputPrice,
    output: outputPrice,
  },
  imageTokenPricePerMillion,
  imageOutputTokenEstimateBySize,
  pricePerImage,
  maxOutputTokens,
  contextWindow,
  imageGenerationWaitTimeSeconds,
  imageGenerationProfiles,
  supportsTool: false,
});

export const googleModels: Model[] = [
  {
    name: DEFAULT_GOOGLE_LIVE_AUDIO_MODEL,
    displayName: "Gemini 3.1 Flash Live",
    provider: "google",
    description:
      "Gemini Live API model for low-latency real-time voice conversations.",
    hasVision: true,
    hasAudio: true,
    contextWindow: 1048576,
    maxOutputTokens: 65500,
    supportsTool: true,
    price: {
      input: 0.5 * 7,
      output: 3 * 7,
      cachingWrite: 0.05 * 7,
      cachingRead: 0.05 * 7,
    },
  },
  {
    name: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    provider: "google",
    description: "The full version of Gemini 2.5 Pro with all features.",
    hasVision: true,
    hasAudio: true,
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: {
      input: 1.25 * 7,
      output: 10 * 7,
      cachingWrite: 0.2 * 7,
      cachingRead: 0.2 * 7,
    },
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 200001,
          price: {
            input: 2.5 * 7,
            output: 15 * 7,
            cachingWrite: 0.25 * 7,
            cachingRead: 0.25 * 7,
          },
        },
      ],
    },
  },
  {
    name: "gemini-2.5-flash-lite",
    displayName: "Gemini 2.5 Flash Lite",
    provider: "google",
    description:
      "Our smallest and most cost-effective model, built for at scale usage.",
    hasVision: false,
    hasAudio: true,
    contextWindow: 1048576,
    maxOutputTokens: 4096,
    supportsTool: true,
    price: {
      input: 0.1 * 7,
      output: 0.4 * 7,
      cachingWrite: 0.2 * 7,
      cachingRead: 0.2 * 7,
    },
  },
  {
    name: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    provider: "google",
    description:
      "Gemini 3.5 Flash GA model for fast frontier agentic, coding, and multimodal tasks.",
    hasVision: true,
    hasAudio: true,
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: {
      input: 1.5 * 7,
      output: 9 * 7,
      cachingWrite: 0.15 * 7,
      cachingRead: 0.15 * 7,
    },
    serviceTierPriceMultipliers: {
      batch: { inputOutput: 0.5, cache: 0.5 },
      flex: { inputOutput: 0.5, cache: 0.08 / 0.15 },
      priority: { inputOutput: 1.8, cache: 1.8 },
    },
  },
  {
    name: "gemini-3.1-flash-lite",
    displayName: "Gemini 3.1 Flash-Lite",
    provider: "google",
    hasVision: true,
    contextWindow: 1048576,
    maxOutputTokens: 65500,
    supportsTool: true,
    price: {
      input: 0.25 * 7,
      output: 1.5 * 7,
      cachingWrite: 0.025 * 7,
      cachingRead: 0.025 * 7,
    },
    serviceTierPriceMultipliers: {
      batch: { inputOutput: 0.5, cache: 0.5 },
      flex: { inputOutput: 0.5, cache: 0.5 },
      priority: { inputOutput: 1.8, cache: 1.8 },
    },
  },
  {
    name: "gemini-3-flash-preview",
    displayName: "Gemini 3 Flash Preview",
    provider: "google",
    hasVision: true,
    contextWindow: 1048576,
    maxOutputTokens: 65500,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: {
      input: 0.5 * 7,
      output: 3 * 7,
      cachingWrite: 0.05 * 7,
      cachingRead: 0.05 * 7,
    },
    serviceTierPriceMultipliers: {
      priority: { inputOutput: 1.8, cache: 1.8 },
    },
  },
  {
    name: "gemini-3-pro-preview",
    displayName: "Gemini 3 Pro (Preview)",
    provider: "google",
    description:
      "Google's most advanced model with enhanced reasoning, vision, and audio.",
    hasVision: true,
    hasAudio: true,
    contextWindow: 2097152,
    maxOutputTokens: 65536,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: {
      input: 2 * 7,
      output: 12 * 7,
      cachingWrite: 0.2 * 7,
      cachingRead: 0.2 * 7,
    },
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 200001,
          price: {
            input: 4 * 7,
            output: 18 * 7,
            cachingWrite: 0.4 * 7,
            cachingRead: 0.4 * 7,
          },
        },
      ],
    },
  },
  {
    name: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    provider: "google",
    hasVision: true,
    contextWindow: 1050000,
    maxOutputTokens: 65500,
    supportsTool: true,
    supportsReasoningEffort: true,
    price: {
      input: 2 * 7,
      output: 12 * 7,
      cachingRead: 0.2 * 7,
      cachingWrite: 0.2 * 7,
    },
    serviceTierPriceMultipliers: {
      priority: { inputOutput: 1.8, cache: 1.8 },
    },
    pricingStrategy: {
      type: "tiered_context",
      tiers: [
        {
          minContext: 200001,
          price: {
            input: 4 * 7,
            output: 18 * 7,
            cachingRead: 0.4 * 7,
            cachingWrite: 0.4 * 7,
          },
        },
      ],
    },
  },
  createGoogleImageModel({
    name: "gemini-3-pro-image-preview",
    displayName: "Nano Banana Pro (Gemini 3 Pro Image Preview)",
    inputPrice: 2 * 7,
    outputPrice: 12 * 7,
    imageTokenPricePerMillion: 120 * 7,
    imageOutputTokenEstimateBySize: {
      "1K": 1120,
      "2K": 1120,
      "4K": 2000,
    },
    maxOutputTokens: 8192,
    contextWindow: 65536,
    imageGenerationWaitTimeSeconds: {
      min: 25,
      max: 60,
    },
    imageGenerationProfiles: [
      {
        key: "speed",
        label: "速度优先",
        imageModel: "gemini-3.1-flash-image-preview",
        waitTimeSeconds: {
          min: 10,
          max: 25,
        },
      },
      {
        key: "quality",
        label: "质量优先",
        imageModel: "gemini-3-pro-image-preview",
        waitTimeSeconds: {
          min: 25,
          max: 60,
        },
      },
    ],
  }),
  createGoogleImageModel({
    name: "gemini-3.1-flash-image-preview",
    displayName: "Nano Banana 2 (Gemini 3.1 Flash Image Preview)",
    inputPrice: 0.5 * 7,
    outputPrice: 3 * 7,
    imageTokenPricePerMillion: 60 * 7,
    imageOutputTokenEstimateBySize: {
      "1K": 1120,
      "2K": 1680,
      "4K": 2520,
    },
    maxOutputTokens: 65536,
    contextWindow: 65536,
    imageGenerationWaitTimeSeconds: {
      min: 10,
      max: 25,
    },
    imageGenerationProfiles: [
      {
        key: "speed",
        label: "速度优先",
        imageModel: "gemini-3.1-flash-image-preview",
        waitTimeSeconds: {
          min: 10,
          max: 25,
        },
      },
      {
        key: "quality",
        label: "质量优先",
        imageModel: "gemini-3-pro-image-preview",
        waitTimeSeconds: {
          min: 25,
          max: 60,
        },
      },
    ],
  }),
  createGoogleImageModel({
    name: "gemini-3.1-flash-lite-image",
    displayName: "Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image)",
    inputPrice: 0.25 * 7,
    outputPrice: 1.5 * 7,
    pricePerImage: 0.034 * 7,
    maxOutputTokens: 65536,
    contextWindow: 65536,
    imageGenerationWaitTimeSeconds: {
      min: 4,
      max: 10,
    },
    imageGenerationProfiles: [
      {
        key: "speed",
        label: "速度优先",
        imageModel: "gemini-3.1-flash-lite-image",
        waitTimeSeconds: {
          min: 4,
          max: 10,
        },
      },
      {
        key: "quality",
        label: "质量优先",
        imageModel: "gemini-3-pro-image-preview",
        waitTimeSeconds: {
          min: 25,
          max: 60,
        },
      },
    ],
  }),
];
