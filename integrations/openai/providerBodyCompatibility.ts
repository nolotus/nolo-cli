import { isFireworksKimiModel } from "../../ai/llm/kimi";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

type NormalizeChatCompletionsBodyArgs = {
  body: Record<string, any>;
  provider: string;
  model: string;
};

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

  return nextBody;
};
