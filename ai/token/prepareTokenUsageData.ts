import { extractUserId } from "../../core/prefix";
import { calculatePrice } from "./calculatePrice";
import { normalizeUsage } from "./normalizeUsage";
import { resolveBillingTarget } from "./resolveBillingTarget";
import type { RawUsage, TokenUsageData } from "./types";

type SharingLevel = "default" | "split" | "full";

interface BillingAgentConfig {
  model: string;
  provider?: string;
  apiSource?: string;
  inputPrice?: number;
  outputPrice?: number;
  sharingLevel?: SharingLevel;
  id?: string;
  userId?: string;
}

interface PrepareTokenUsageDataParams {
  rawUsage: RawUsage;
  agentConfig: BillingAgentConfig;
  userId?: string;
  username?: string;
  cybotId: string;
  dialogId: string;
  timestamp?: number;
}

export interface PreparedTokenUsageData {
  usage: ReturnType<typeof normalizeUsage>;
  billedProvider?: string;
  billedModel: string;
  billedServiceTier?: string;
  recordProvider: string;
  tokenData: TokenUsageData;
}

export const prepareTokenUsageData = ({
  rawUsage,
  agentConfig,
  userId,
  username,
  cybotId,
  dialogId,
  timestamp = Date.now(),
}: PrepareTokenUsageDataParams): PreparedTokenUsageData => {
  const usage = normalizeUsage(rawUsage);
  const billingTarget = resolveBillingTarget({
    usage,
    fallbackProvider: agentConfig.provider,
    fallbackModel: agentConfig.model,
  });
  const billedProvider = billingTarget.provider;
  const billedModel = billingTarget.model;
  const billedServiceTier = billingTarget.serviceTier;
  const recordProvider = billedProvider ?? agentConfig.provider ?? "unknown";
  const { cost, pay } = calculatePrice({
    provider: billedProvider,
    modelName: billedModel,
    billingServiceTier: billedServiceTier,
    usage,
    externalPrice: agentConfig.id
      ? {
          input: agentConfig.inputPrice ?? 0,
          output: agentConfig.outputPrice ?? 0,
          creatorId: agentConfig.userId ?? extractUserId(agentConfig.id),
        }
      : undefined,
    sharingLevel: agentConfig.sharingLevel,
  });

  return {
    usage,
    billedProvider,
    billedModel,
    billedServiceTier,
    recordProvider,
    tokenData: {
      ...usage,
      userId,
      cybotId,
      model: billedModel,
      provider: recordProvider,
      billing_service_tier: billedServiceTier,
      dialogId,
      cost,
      pay,
      timestamp,
    },
  };
};
