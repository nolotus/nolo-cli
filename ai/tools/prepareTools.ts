import i18n from "../../app/i18n";
import { toolRegistry } from ".";
import { canonicalizeToolNames } from "./toolNameAliases";
import { sanitizeToolForProvider } from "./toolSchemaCompatibility";

/** Per (language, toolName) translated function schema — avoids re-walking i18n on every turn. */
const translatedFunctionCache = new Map<string, any>();
/** Per (language, provider, disabled, toolNames) full prepareTools result. */
const prepareToolsResultCache = new Map<string, any[]>();
const PREPARE_TOOLS_CACHE_LIMIT = 128;

function getTranslation(keys: string[], defaultVal: string): string {
  for (const key of keys) {
    if (i18n.exists(key)) {
      return i18n.t(key);
    }
    const aiKey = key.startsWith("ai:") ? key : `ai:${key}`;
    if (i18n.exists(aiKey)) {
      return i18n.t(aiKey);
    }
  }
  return defaultVal;
}

export function translateSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;

  const nextSchema = JSON.parse(JSON.stringify(schema));
  const toolName = nextSchema.name;
  if (!toolName) return nextSchema;

  const walk = (node: any, path: string) => {
    if (!node || typeof node !== "object") return;

    if (typeof node.description === "string") {
      const keysToTry = [
        `${path}.description`,
        `${path}.desc`,
        path,
        node.description,
      ];
      node.description = getTranslation(keysToTry, node.description);
    }

    if (node.parameters && typeof node.parameters === "object") {
      walk(node.parameters, path);
    }

    if (node.properties && typeof node.properties === "object") {
      for (const [key, child] of Object.entries(node.properties)) {
        const nextPath = path.endsWith(".params")
          ? `${path}.${key}`
          : `${path}.params.${key}`;
        walk(child, nextPath);
      }
    }

    if (node.items && typeof node.items === "object") {
      walk(node.items, path);
    }

    const compositions = ["anyOf", "oneOf", "allOf"] as const;
    for (const comp of compositions) {
      if (Array.isArray(node[comp])) {
        node[comp].forEach((child: any, idx: number) => {
          const suffix =
            child.type === "string"
              ? "stringDesc"
              : child.type === "object"
                ? "objectDesc"
                : `${idx}`;
          walk(child, `${path}.${suffix}`);
        });
      }
    }
  };

  walk(nextSchema, `tools.${toolName}`);
  return nextSchema;
}

function currentI18nLanguage(): string {
  return typeof i18n.language === "string" ? i18n.language : "";
}

function translateSchemaCached(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const toolName = typeof schema.name === "string" ? schema.name : "";
  if (!toolName) return translateSchema(schema);

  const cacheKey = `${currentI18nLanguage()}\0${toolName}`;
  const hit = translatedFunctionCache.get(cacheKey);
  if (hit) return hit;

  const translated = translateSchema(schema);
  translatedFunctionCache.set(cacheKey, translated);
  return translated;
}

function buildPrepareToolsCacheKey(
  toolNames: string[],
  disabledToolNames: string[],
  provider: string | undefined,
): string {
  return [
    currentI18nLanguage(),
    provider ?? "",
    disabledToolNames.join("\x1f"),
    toolNames.join("\x1f"),
  ].join("\0");
}

function rememberPrepareToolsResult(key: string, value: any[]) {
  if (prepareToolsResultCache.size >= PREPARE_TOOLS_CACHE_LIMIT) {
    const oldest = prepareToolsResultCache.keys().next().value;
    if (oldest !== undefined) {
      prepareToolsResultCache.delete(oldest);
    }
  }
  prepareToolsResultCache.set(key, value);
}

/**
 * Build OpenAI-style tool definitions for the given tool names.
 *
 * Results are cached per (language, provider, disabled set, ordered names) so the
 * streamAgentChatTurn / agent-loop hot path does not re-deep-clone and re-translate
 * schemas on every request or loop iteration.
 */
export const prepareTools = (
  toolNames: string[],
  options?: { provider?: string; disabledToolNames?: string[] },
) => {
  const disabledList = canonicalizeToolNames(options?.disabledToolNames ?? []);
  const disabledToolNames = new Set(disabledList);
  const canonicalNames = canonicalizeToolNames(toolNames).filter(
    (toolName) => !disabledToolNames.has(toolName),
  );
  const cacheKey = buildPrepareToolsCacheKey(
    canonicalNames,
    disabledList,
    options?.provider,
  );
  const cached = prepareToolsResultCache.get(cacheKey);
  if (cached) {
    // Shallow-copy the array so callers cannot poison the cache via push/splice.
    return cached.slice();
  }

  const prepared = canonicalNames
    .map((toolName: string) => {
      const regTool = toolRegistry[toolName];
      if (!regTool) return regTool;
      return {
        ...regTool,
        function: translateSchemaCached(regTool.function),
      };
    })
    .map((tool) => sanitizeToolForProvider(tool, options?.provider))
    .filter(Boolean);

  rememberPrepareToolsResult(cacheKey, prepared);
  return prepared.slice();
};

/** Test-only: drop prepareTools caches between cases. */
export const __clearPrepareToolsCacheForTests = () => {
  translatedFunctionCache.clear();
  prepareToolsResultCache.clear();
};
