import { isFireworksKimiModel } from "../../ai/llm/kimi";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

type NormalizeChatCompletionsBodyArgs = {
  body: Record<string, any>;
  provider: string;
  model: string;
};

/** Moonshot 开放平台旗舰模型 id（api.moonshot.cn OpenAI 兼容模式）。 */
const MOONSHOT_KIMI_K3_MODEL = "kimi-k3";

const isMoonshotKimiK3 = (provider: string, model: string): boolean =>
  asTrimmedLowercaseString(provider) === "moonshot" &&
  asTrimmedLowercaseString(model) === MOONSHOT_KIMI_K3_MODEL;

export const normalizeChatCompletionsBodyForProvider = ({
  body,
  provider,
  model,
}: NormalizeChatCompletionsBodyArgs): Record<string, any> => {
  const nextBody: Record<string, any> = { ...body, model };
  const normalizedProvider = asTrimmedLowercaseString(provider);

  if (normalizedProvider === "fireworks" && isFireworksKimiModel(model)) {
    delete nextBody.reasoning;
    delete nextBody.reasoning_effort;
  }

  if (isMoonshotKimiK3(provider, model)) {
    // Kimi K3 官方要求固定采样参数，不应被通用 Agent 默认值覆盖。
    delete nextBody.temperature;
    delete nextBody.top_p;
    delete nextBody.frequency_penalty;
    delete nextBody.presence_penalty;
    // 通用 max_tokens 安全映射成 Kimi 兼容的 max_completion_tokens，
    // 不同时发送两个字段。
    if (typeof nextBody.max_tokens === "number") {
      nextBody.max_completion_tokens = nextBody.max_tokens;
      delete nextBody.max_tokens;
    }
  }

  return nextBody;
};
