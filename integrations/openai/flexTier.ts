export type OpenAIServiceTier = "flex" | "default";

type OpenAIModelProfile = {
  upstreamModel: string;
  defaultServiceTier?: OpenAIServiceTier;
  preAdjustedFlexPrice?: boolean;
};

const OPENAI_MODEL_PROFILES: Record<string, OpenAIModelProfile> = {
  "gpt-5.5": {
    upstreamModel: "gpt-5.5",
    defaultServiceTier: "default",
  },
  "gpt-5.5-flex": {
    upstreamModel: "gpt-5.5",
    defaultServiceTier: "flex",
    preAdjustedFlexPrice: true,
  },
  "gpt-5.5-pro-flex": {
    upstreamModel: "gpt-5.5-pro",
    defaultServiceTier: "flex",
    preAdjustedFlexPrice: true,
  },
  "gpt-5.4": {
    upstreamModel: "gpt-5.4",
    defaultServiceTier: "default",
  },
  "gpt-5.4-flex": {
    upstreamModel: "gpt-5.4",
    defaultServiceTier: "flex",
    preAdjustedFlexPrice: true,
  },
  "gpt-5.4-pro-flex": {
    upstreamModel: "gpt-5.4-pro",
    defaultServiceTier: "flex",
    preAdjustedFlexPrice: true,
  },
};

const getOpenAIModelProfile = (model?: string | null): OpenAIModelProfile | undefined => {
  if (!model) return undefined;
  return OPENAI_MODEL_PROFILES[model];
};

const isExplicitFlexModel = (model?: string | null): boolean => {
  return getOpenAIModelProfile(model)?.defaultServiceTier === "flex";
};

export const resolveOpenAIUpstreamModel = ({
  providerName,
  model,
}: {
  providerName?: string | null;
  model?: string | null;
}): string | undefined => {
  if (!model) return undefined;
  if (providerName !== "openai") return model;
  return getOpenAIModelProfile(model)?.upstreamModel ?? model;
};

export const isOpenAIFlexPricedModel = (model?: string | null): boolean => {
  return getOpenAIModelProfile(model)?.preAdjustedFlexPrice === true;
};

export const resolveOpenAIServiceTier = ({
  providerName,
  model,
  requestedServiceTier,
}: {
  providerName?: string | null;
  model?: string | null;
  requestedServiceTier?: string | null;
}): OpenAIServiceTier | undefined => {
  if (providerName !== "openai" || !model) return undefined;
  const normalizedRequestedServiceTier =
    requestedServiceTier === "flex" || requestedServiceTier === "default"
      ? requestedServiceTier
      : undefined;

  if (normalizedRequestedServiceTier === "flex") {
    return isExplicitFlexModel(model) ? "flex" : undefined;
  }
  if (normalizedRequestedServiceTier === "default") return "default";
  return getOpenAIModelProfile(model)?.defaultServiceTier;
};

export const resolveOpenAIRequestTarget = ({
  providerName,
  model,
  requestedServiceTier,
}: {
  providerName?: string | null;
  model?: string | null;
  requestedServiceTier?: string | null;
}): { model?: string; serviceTier?: OpenAIServiceTier } => ({
  model: resolveOpenAIUpstreamModel({ providerName, model }),
  serviceTier: resolveOpenAIServiceTier({
    providerName,
    model,
    requestedServiceTier,
  }),
});
