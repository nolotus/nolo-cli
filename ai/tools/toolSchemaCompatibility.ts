const COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;

const LIMITED_JSON_SCHEMA_PROVIDERS = new Set([
  "fireworks",
]);

const isPlainObject = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const sanitizeSchemaNode = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSchemaNode(item));
  }

  if (!isPlainObject(value)) {
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
  typeof provider === "string" &&
  LIMITED_JSON_SCHEMA_PROVIDERS.has(provider.trim().toLowerCase());

export const sanitizeToolForProvider = (
  tool: any,
  provider: string | undefined
) => {
  if (!shouldSanitizeProviderSchema(provider)) {
    return tool;
  }

  const parameters = tool?.function?.parameters;
  if (!isPlainObject(parameters)) {
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
