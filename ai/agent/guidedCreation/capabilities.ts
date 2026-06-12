import type { GuidedAgentCapabilityId } from "./types";

type CapabilityDefinition = {
  id: GuidedAgentCapabilityId;
  label: {
    zhCN: string;
    en: string;
  };
  description: {
    zhCN: string;
    en: string;
  };
  toolIds: string[];
};

export const GUIDED_AGENT_CAPABILITIES: Record<
  GuidedAgentCapabilityId,
  CapabilityDefinition
> = {
  webSearch: {
    id: "webSearch",
    label: { zhCN: "联网搜索", en: "Search the web" },
    description: {
      zhCN: "需要获取外部网页、资料或最新信息时使用。",
      en: "Use when the agent needs external webpages, research, or current information.",
    },
    toolIds: ["exa_search", "fetchWebpage"],
  },
  docs: {
    id: "docs",
    label: { zhCN: "读写文档", en: "Read and write docs" },
    description: {
      zhCN: "需要读取、创建或更新知识页和文档时使用。",
      en: "Use when the agent should read, create, or update docs.",
    },
    toolIds: ["createDoc", "updateDoc", "read"],
  },
  tables: {
    id: "tables",
    label: { zhCN: "处理表格", en: "Work with tables" },
    description: {
      zhCN: "需要创建表、追加记录或整理结构化数据时使用。",
      en: "Use when the agent should create tables or manage structured rows.",
    },
    toolIds: ["createTable", "addTableRow", "addTableRows", "read"],
  },
  agents: {
    id: "agents",
    label: { zhCN: "调用其他 AI", en: "Call other AI agents" },
    description: {
      zhCN: "需要多 Agent 协作、评审或分工时使用。",
      en: "Use when the agent should collaborate with other agents.",
    },
    toolIds: ["callAgent", "startAgentDialog"],
  },
  apps: {
    id: "apps",
    label: { zhCN: "创建应用或代码", en: "Create apps or code" },
    description: {
      zhCN: "需要生成应用、代码或使用 App Builder 能力时使用。",
      en: "Use when the agent should build apps, code, or App Builder outputs.",
    },
    toolIds: ["appDeploy", "appList", "appRead"],
  },
};

export const mapCapabilityIdsToToolIds = (
  capabilityIds: GuidedAgentCapabilityId[]
): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const id of capabilityIds) {
    const definition = GUIDED_AGENT_CAPABILITIES[id];
    if (!definition) continue;
    for (const toolId of definition.toolIds) {
      if (seen.has(toolId)) continue;
      seen.add(toolId);
      result.push(toolId);
    }
  }

  return result;
};
