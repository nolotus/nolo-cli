import type { NormalizedUsage, RawUsage } from "./types";

type BillingUsage = Pick<
  RawUsage | NormalizedUsage,
  "billing_provider" | "billing_model" | "billing_service_tier"
>;

const normalizeString = (value?: string) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
};

const resolveBillingModel = (
  usageModel?: string,
  fallbackModel?: string
) => {
  const model = normalizeString(usageModel) ?? normalizeString(fallbackModel);
  if (!model) {
    throw new Error("Billing model is required");
  }
  return model;
};

export const resolveBillingTarget = ({
  usage,
  fallbackProvider,
  fallbackModel,
}: {
  usage?: BillingUsage | null;
  fallbackProvider?: string;
  fallbackModel: string;
}) => {
  const provider =
    normalizeString(usage?.billing_provider) ?? normalizeString(fallbackProvider);
  const model = resolveBillingModel(usage?.billing_model, fallbackModel);
  const serviceTier = normalizeString(usage?.billing_service_tier);

  return {
    provider,
    model,
    serviceTier,
  };
};
