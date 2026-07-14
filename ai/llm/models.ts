// ai/llm/models.ts

import type { Model } from "./types";

// 导入所有提供商的模型数据
import { deepSeekModels } from "../../integrations/deepseek/models";
import { googleModels } from "../../integrations/google/models";
import { openAIModels } from "../../integrations/openai/models";
import { deepinfraModels } from "./deepinfra";
import { xaiModels } from "../../integrations/xai/models";
import { openrouterModels } from "./openrouterModels";
import { fireworksModels } from "./fireworks";
import { ollamaCloudModels } from "./ollamaCloud";
import { mistralModels } from "./mistral";
import { mimoModels } from "./mimo";
import { cloudflareModels } from "./cloudflare";
import { gmiModels } from "./gmi";
import { zaiModels } from "./zai";

/**
 * @interface ModelWithProvider
 * 扩展基础 Model 类型，增加了 provider 字段，用于UI显示和逻辑处理。
 */
export interface ModelWithProvider extends Model {
  provider: string;
}

/**
 * 将一组模型打上 provider 标记的纯函数，方便复用和测试
 */
const withProvider =
  (provider: ModelWithProvider["provider"]) =>
    (models: Model[]): ModelWithProvider[] =>
      models.map((model) => ({ ...model, provider }));

/**
 * @const ALL_MODELS
 * 聚合了所有来源的模型数据，并为每个模型附加了其提供商信息。
 * 这是整个应用中模型选择器的唯一数据源。
 */
export const ALL_MODELS: ModelWithProvider[] = [
  ...withProvider("google")(googleModels),
  ...withProvider("openai")(openAIModels),
  ...withProvider("openrouter")(openrouterModels),
  ...withProvider("xai")(xaiModels),
  ...withProvider("deepseek")(deepSeekModels),
  ...withProvider("deepinfra")(deepinfraModels),
  ...withProvider("fireworks")(fireworksModels),
  ...withProvider("ollama-cloud")(ollamaCloudModels),
  ...withProvider("mistral")(mistralModels),
  ...withProvider("mimo")(mimoModels),
  ...withProvider("cloudflare")(cloudflareModels),
  ...withProvider("gmi")(gmiModels),
  ...withProvider("zai")(zaiModels),
];
