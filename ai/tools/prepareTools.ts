import i18n from "../../app/i18n";
import {
  toolRegistry,
  toolDefinitionsByName,
  findToolExecutor,
  ToolBehavior,
} from ".";
import { canonicalizeToolNames } from "./toolNameAliases";
import { sanitizeToolForProvider } from "./toolSchemaCompatibility";

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
        const nextPath = path.endsWith(".params") ? `${path}.${key}` : `${path}.params.${key}`;
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
          const suffix = child.type === "string" ? "stringDesc" : child.type === "object" ? "objectDesc" : `${idx}`;
          walk(child, `${path}.${suffix}`);
        });
      }
    }
  };

  walk(nextSchema, `tools.${toolName}`);
  return nextSchema;
}

export const prepareTools = (
  toolNames: string[],
  options?: { provider?: string; disabledToolNames?: string[] }
) => {
  // logic moved to mergeAgentToolsWithRuntime for better tiered capabilities
  const disabledToolNames = new Set(
    canonicalizeToolNames(options?.disabledToolNames ?? [])
  );
  return canonicalizeToolNames(toolNames)
    .filter((toolName) => !disabledToolNames.has(toolName))
    .map((toolName: string) => {
      const regTool = toolRegistry[toolName];
      if (!regTool) return regTool;
      return {
        ...regTool,
        function: translateSchema(regTool.function),
      };
    })
    .map((tool) => sanitizeToolForProvider(tool, options?.provider))
    .filter(Boolean); // 过滤掉未找到的工具
};
