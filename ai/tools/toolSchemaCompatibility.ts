import { isRecord } from "../../core/isRecord";
import { asTrimmedLowercaseString } from "../../core/trimmedLowercaseString";

const COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;

const LIMITED_JSON_SCHEMA_PROVIDERS = new Set([
  "fireworks",
]);

const sanitizeSchemaNode = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchemaNode(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  const next: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (COMPOSITION_KEYS.includes(key as (typeof COMPOSITION_KEYS)[number])) {
      continue;
    }
    next[key] = sanitizeSchemaNode(child);
  }
  return next;
};

const shouldSanitizeProviderSchema = (provider: string | undefined): boolean =>
  LIMITED_JSON_SCHEMA_PROVIDERS.has(asTrimmedLowercaseString(provider));

export const sanitizeToolForProvider = (
  tool: any,
  provider: string | undefined
) => {
  if (!shouldSanitizeProviderSchema(provider)) {
    return tool;
  }

  const parameters = tool?.function?.parameters;
  if (!isRecord(parameters)) {
    return tool;
  }

  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: sanitizeSchemaNode(parameters),
    },
  };
};
