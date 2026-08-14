import { asOptionalTrimmedString } from "../../core/optionalString";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";
import {
  findModelConfig,
  getProviderByModelName,
} from "./providers";

export type AgentCapabilityConfig = {
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

/**
 * 剥离 Antigravity 等 wire 层的 effort 后缀，得到 catalog 基础模型名。
 * 能力检测只看基础模型的多模态能力，与 effort（-low/-medium/-high/-extra-low）无关；
 * record 里存的常是带后缀的 wire id（如 gemini-3.6-flash-high），而 catalog 只收
 * 基础名（gemini-3.6-flash），精确匹配会漏判，故在查 catalog 前先折叠后缀。
 */
const ANTIGRAVITY_EFFORT_SUFFIXES = [
  "-tiered",
  "-extra-low",
  "-low",
  "-medium",
  "-high",
] as const;

function stripEffortSuffix(model: string): string {
  for (const suffix of ANTIGRAVITY_EFFORT_SUFFIXES) {
    if (model.endsWith(suffix) && model.length > suffix.length) {
      return model.slice(0, -suffix.length);
    }
  }
  return model;
}

/**
 * 去掉模型 id 末尾的 `-preview` 后缀，用于把存量「预览版」agent 记录归一化到
 * 已正式上线的同名模型。例如 qwen3.8-max-preview → qwen3.8-max，使能力检测
 * 仍能从 catalog 精确命中，而不是回退到存的 false（导致 CLI 误切 Kimi、chat 拦图）。
 * 与 stripEffortSuffix 同模式；无 -preview 后缀时原样返回。
 */
function stripPreviewSuffix(model: string): string {
  const suffix = "-preview";
  if (model.endsWith(suffix) && model.length > suffix.length) {
    return model.slice(0, -suffix.length);
  }
  return model;
}

const lookupKnownModelVision = (
  provider: string | null,
  model: string,
): boolean | undefined => {
  if (!model) return undefined;

  const candidates = [model];
  const strippedEffort = stripEffortSuffix(model);
  if (strippedEffort !== model) candidates.push(strippedEffort);
  const strippedPreview = stripPreviewSuffix(model);
  if (strippedPreview !== model) candidates.push(strippedPreview);

  for (const candidate of candidates) {
    if (provider) {
      const direct = findModelConfig(provider, candidate);
      if (direct) return direct.hasVision;
    }

    const detected = getProviderByModelName(candidate);
    if (detected) {
      const found = findModelConfig(detected, candidate)?.hasVision;
      if (found !== undefined) return found;
    }

    if (!provider && candidate.includes("/")) {
      const slash = candidate.indexOf("/");
      const modelProvider = candidate.slice(0, slash).toLowerCase();
      const modelName = candidate.slice(slash + 1);
      const nested = findModelConfig(modelProvider, modelName);
      if (nested) return nested.hasVision;
    }
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
