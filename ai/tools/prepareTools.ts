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

function buildActivitySchema() {
  const refs = {
    type: "array",
    items: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["file", "terminal", "url"] },
        path: { type: "string" },
        id: { type: "string" },
        label: { type: "string" },
        url: { type: "string" },
      },
    },
  };
  const action = {
    type: "object",
    properties: {
      title: { type: "string" },
      kind: {
        type: "string",
        enum: ["read", "write", "edit", "search", "terminal", "version", "test", "build", "preview", "other"],
      },
      detail: { type: "string" },
      refs,
    },
    required: ["title"],
  };
  const planPhase = {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      index: { type: "number" },
      status: { type: "string", enum: ["pending", "running", "success", "failed"] },
    },
    required: ["id", "title"],
  };
  return {
    type: "object",
    description:
      "Optional human-readable activity metadata for UI progress display only. Use plan for the visible task skeleton, phase for the current task step, and action for this specific tool call.",
    properties: {
      plan: {
        type: "object",
        properties: {
          title: { type: "string" },
          phases: {
            type: "array",
            items: planPhase,
          },
        },
        required: ["phases"],
      },
      phase: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          index: { type: "number" },
          total: { type: "number" },
          status: { type: "string", enum: ["pending", "running", "success", "failed"] },
        },
        required: ["id", "title"],
      },
      action,
      title: { type: "string" },
      kind: action.properties.kind,
      detail: { type: "string" },
      refs,
    },
  };
}

function addActivityMetadataToToolSchema(tool: any) {
  if (!tool?.function?.parameters || typeof tool.function.parameters !== "object") {
    return tool;
  }
  const parameters = tool.function.parameters;
  if (parameters.type !== "object" || !parameters.properties || typeof parameters.properties !== "object") {
    return tool;
  }
  if (parameters.properties._activity) return tool;

  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        ...parameters,
        properties: {
          ...parameters.properties,
          _activity: buildActivitySchema(),
        },
      },
    },
  };
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
    .map(addActivityMetadataToToolSchema)
    .map((tool) => sanitizeToolForProvider(tool, options?.provider))
    .filter(Boolean); // 过滤掉未找到的工具
};
