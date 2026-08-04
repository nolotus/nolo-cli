/**
 * Agent capabilities that Nolo provides globally.
 *
 * This is the single registry for capabilities exposed in the global settings
 * page. Runtime capability packs and persisted defaults are derived from it.
 */
export type SystemAgentCapability = {
  /** Stable id; also used as the capability-pack id and settings key. */
  id: string;
  label: string;
  description: string;
  tools: readonly string[];
  defaultEnabled: boolean;
  icon: string;
};

export const SYSTEM_AGENT_CAPABILITIES = [
  {
    id: "web-search",
    label: "联网搜索",
    description: "让 agent 能搜索互联网、抓取网页内容，获取最新信息。",
    tools: ["exa_search", "fetchWebpage"],
    defaultEnabled: true,
    icon: "🌐",
  },
] as const satisfies readonly SystemAgentCapability[];

export const SYSTEM_AGENT_CAPABILITY_IDS = SYSTEM_AGENT_CAPABILITIES.map(
  ({ id }) => id,
);

export const DEFAULT_SYSTEM_AGENT_CAPABILITIES: Record<string, boolean> =
  Object.fromEntries(
    SYSTEM_AGENT_CAPABILITIES.map(({ id, defaultEnabled }) => [
      id,
      defaultEnabled,
    ]),
  );
