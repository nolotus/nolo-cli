import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import {
  findModelConfig,
  getProviderByModelName,
} from "./providers";

type AgentCapabilityConfig = {
  apiSource?: string | null;
  provider?: string | null;
  model?: string | null;
  hasVision?: boolean | null;
  useServerProxy?: boolean | null;
};

const isCustomAgent = (agent: AgentCapabilityConfig): boolean => {
  const apiSource = agent.apiSource?.toLowerCase();
  const provider = agent.provider?.toLowerCase();
  return apiSource === "custom" || provider === "custom";
};

const lookupKnownModelVision = (
  provider: string | null,
  model: string,
): boolean | undefined => {
  if (!model) return undefined;

  if (provider) {
    const direct = findModelConfig(provider, model);
    if (direct) return direct.hasVision;
  }

  const detected = getProviderByModelName(model);
  if (detected) {
    return findModelConfig(detected, model)?.hasVision;
  }

  if (!provider && model.includes("/")) {
    const slash = model.indexOf("/");
    const modelProvider = model.slice(0, slash).toLowerCase();
    const modelName = model.slice(slash + 1);
    const nested = findModelConfig(modelProvider, modelName);
    if (nested) return nested.hasVision;
  }

  return undefined;
};

export const resolveAgentImageInputSupport = (
  agent: AgentCapabilityConfig | null | undefined,
): boolean => {
  if (!agent) return true;

  const provider = asTrimmedLowercaseString(agent.provider) || null;
  const model = asOptionalTrimmedString(agent.model) ?? "";
  const custom = isCustomAgent(agent);
  const catalogHasVision = lookupKnownModelVision(
    custom ? null : provider,
    model,
  );

  if (!custom && catalogHasVision !== undefined) {
    return catalogHasVision;
  }

  if (custom) {
    if (catalogHasVision === true) return true;
    return true;
  }

  if (typeof agent.hasVision === "boolean") {
    return agent.hasVision;
  }

  return true;
};
