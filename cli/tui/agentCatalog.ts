import {
  listLocalCachedAgents,
  listRemoteAgents,
  listRemoteAgentsAcrossServers,
  type ListedAgent,
} from "../agentListHelpers";
import { getReadableCliDb } from "../agentCommandSupport";
import { queryUserRecords, readDbRecord } from "../agentRecordHelpers";
import type { CliFetchImpl } from "../cliFetch";
import {
  parseUserIdFromAuthToken,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
} from "../cliEnvHelpers";
export const DEFAULT_TUI_AGENT_KEY = "agent-pub-01NOLOAPPBLD000000019KCKT0";

export type AgentCatalogEntry = {
  name: string;
  key: string;
  model: string;
  kind: "platform" | "private";
  description?: string;
  updatedAt?: number;
};

export const PLATFORM_AGENTS: AgentCatalogEntry[] = [
  {
    name: "nolo",
    key: DEFAULT_TUI_AGENT_KEY,
    model: "-",
    kind: "platform",
    description: "one assistant that routes work across your agents and data",
  },
  {
    name: "app-builder",
    key: "agent-pub-01APPBUILDER00000001YAII3I",
    model: "-",
    kind: "platform",
    description: "builds web apps, tools, charts, and product prototypes",
  },
];

type EnvLike = Record<string, string | undefined>;

function toUpdatedAt(value: string | number | null | undefined) {
  if (value == null) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function listedAgentToCatalogEntry(agent: ListedAgent): AgentCatalogEntry {
  return {
    name: agent.name,
    key: agent.privateKey,
    model: agent.model,
    kind: "private",
    updatedAt: toUpdatedAt(agent.updatedAt),
  };
}

function mergeCatalogEntries(
  currentKey: string,
  platformAgents: AgentCatalogEntry[],
  privateAgents: AgentCatalogEntry[]
) {
  const seen = new Set<string>();
  const merged: AgentCatalogEntry[] = [];

  const push = (entry: AgentCatalogEntry) => {
    if (seen.has(entry.key)) return;
    seen.add(entry.key);
    merged.push(entry);
  };

  const current =
    [...platformAgents, ...privateAgents].find((entry) => entry.key === currentKey) ??
    null;
  if (current) push(current);

  for (const entry of platformAgents) {
    if (entry.key !== currentKey) push(entry);
  }

  const sortedPrivate = [...privateAgents].sort((a, b) => {
    const tb = b.updatedAt ?? 0;
    const ta = a.updatedAt ?? 0;
    if (tb !== ta) return tb - ta;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sortedPrivate) {
    if (entry.key !== currentKey) push(entry);
  }

  return merged;
}

export async function loadAgentCatalog(args: {
  env?: EnvLike;
  currentKey: string;
  fetchImpl?: CliFetchImpl;
  fallbackFetchImpl?: CliFetchImpl;
}): Promise<AgentCatalogEntry[]> {
  const env = args.env ?? process.env;
  const fetchImpl = args.fetchImpl ?? fetch;
  const fallbackFetchImpl = args.fallbackFetchImpl;
  const authToken = resolveAuthToken([], env);
  const userId = authToken ? parseUserIdFromAuthToken(authToken) : null;

  if (!authToken || !userId) {
    return mergeCatalogEntries(args.currentKey, PLATFORM_AGENTS, []);
  }

  const serverUrl = resolveServerUrl(env);
  const serverUrls = resolveServerCandidates([], env, serverUrl);
  let privateAgents: AgentCatalogEntry[] = [];

  try {
    const remoteResult = await listRemoteAgentsAcrossServers({
      authToken,
      fallbackFetchImpl,
      fetchImpl,
      serverUrls,
      userId,
    });
    privateAgents = remoteResult.agents.map(listedAgentToCatalogEntry);
  } catch {
    try {
      const db = await getReadableCliDb({ write: () => {} });
      const cached = await listLocalCachedAgents({ db, userId });
      privateAgents = cached.map(listedAgentToCatalogEntry);
    } catch {
      privateAgents = (
        await listRemoteAgents({
          authToken,
          fallbackFetchImpl,
          fetchImpl,
          serverUrl,
          userId,
          queryUserRecords,
          readDbRecord,
        })
      ).map(listedAgentToCatalogEntry);
    }
  }

  return mergeCatalogEntries(args.currentKey, PLATFORM_AGENTS, privateAgents);
}

export function renderAgentCatalogList(entries: AgentCatalogEntry[], currentKey: string) {
  const lines = ["Agents:"];
  entries.forEach((entry, index) => {
    const current = entry.key === currentKey ? " (current)" : "";
    const kind = entry.kind === "platform" ? "platform" : "private";
    const detail = entry.description ? ` — ${entry.description}` : "";
    lines.push(
      `  ${String(index + 1).padStart(2)}  ${entry.name.padEnd(18)} ${entry.model.padEnd(14)} ${kind}${detail}${current}`
    );
  });
  lines.push("");
  lines.push("Tip: run /agent in an interactive terminal to pick with ↑↓.");
  return lines.join("\n");
}

export function findAgentCatalogEntry(
  entries: AgentCatalogEntry[],
  rawTarget: string
) {
  const target = rawTarget.trim();
  if (!target) return null;

  if (/^\d+$/.test(target)) {
    const entry = entries[Number(target) - 1];
    return entry ? { name: entry.name, key: entry.key } : null;
  }

  const lower = target.toLowerCase();
  const byName = entries.find(
    (entry) =>
      entry.name.toLowerCase() === lower ||
      entry.key.toLowerCase() === lower ||
      entry.key.toLowerCase().endsWith(`-${lower}`)
  );
  if (byName) return { name: byName.name, key: byName.key };

  if (target.startsWith("agent-") || target.startsWith("agent-pub-")) {
    return { name: target, key: target };
  }

  return null;
}