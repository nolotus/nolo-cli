import type { CliKvDb } from "./client/hybridRecordStore";
import type { CliFetchImpl } from "./cliFetch";
import {
  listUserRecordsFromServers,
  readLiveDbRecordAfterTombstoneMerge,
} from "./globalRecordOperations";

export type ListedAgent = {
  id: string;
  privateKey: string;
  publicKey: string;
  name: string;
  model: string;
  updatedAt: string | number | null;
  isPublicFlag: boolean;
  publicRecordExists: boolean;
  type: string | null;
  tools: string[];
};

function parseAgentRecordId(privateKey: string, explicitId?: string) {
  if (explicitId) return explicitId;
  const agentMatch = privateKey.match(/^agent-[^-]+-(.+)$/i);
  if (agentMatch?.[1]) return agentMatch[1];
  const cybotMatch = privateKey.match(/^cybot-[^-]+-([0-9A-HJKMNP-TV-Z]{26})$/i);
  return cybotMatch?.[1] ?? "";
}

function buildCompanionKeys(privateKey: string, rawId: string, userId: string) {
  if (privateKey.startsWith("cybot-")) {
    return {
      privateKey: `cybot-${userId}-${rawId}`,
      publicKey: `cybot-pub-${rawId}`,
    };
  }
  return {
    privateKey: `agent-${userId}-${rawId}`,
    publicKey: `agent-pub-${rawId}`,
  };
}

export function normalizeListedAgent(record: any): ListedAgent | null {
  const privateKey = typeof record?.dbKey === "string" ? record.dbKey : "";
  const explicitId = typeof record?.id === "string" && record.id ? record.id : undefined;
  const ownerUserId = typeof record?.userId === "string" ? record.userId : "";
  const rawId = explicitId
    || (ownerUserId && privateKey.startsWith(`agent-${ownerUserId}-`)
      ? privateKey.slice(`agent-${ownerUserId}-`.length)
      : ownerUserId && privateKey.startsWith(`cybot-${ownerUserId}-`)
        ? privateKey.slice(`cybot-${ownerUserId}-`.length)
        : parseAgentRecordId(privateKey, explicitId));
  if (!privateKey || !rawId || !ownerUserId) return null;
  const keys = buildCompanionKeys(privateKey, rawId, ownerUserId);
  return {
    id: rawId,
    privateKey,
    publicKey: keys.publicKey,
    name: typeof record?.name === "string" && record.name ? record.name : "(unnamed)",
    model: typeof record?.model === "string" && record.model ? record.model : "-",
    updatedAt:
      typeof record?.updatedAt === "string" || typeof record?.updatedAt === "number"
        ? record.updatedAt
        : typeof record?.createdAt === "string" || typeof record?.createdAt === "number"
          ? record.createdAt
          : typeof record?.created === "string" || typeof record?.created === "number"
            ? record.created
            : null,
    isPublicFlag: !!record?.isPublic,
    publicRecordExists: false,
    type: typeof record?.type === "string" ? record.type : null,
    tools: Array.isArray(record?.tools)
      ? record.tools.filter((tool: unknown): tool is string => typeof tool === "string")
      : [],
  };
}

export function sortListedAgents(agents: ListedAgent[]) {
  agents.sort((a, b) => {
    const ta = a.updatedAt == null ? 0 : new Date(a.updatedAt).getTime();
    const tb = b.updatedAt == null ? 0 : new Date(b.updatedAt).getTime();
    return tb - ta;
  });
  return agents;
}

export function parseAgentListArgs(args: string[]) {
  return {
    wantJson: args.includes("--json"),
    publicOnly: args.includes("--public-only"),
    idsOnly: args.includes("--ids-only"),
    includeLegacy: args.includes("--include-legacy"),
  };
}

export async function listLocalCachedAgents(args: {
  db: CliKvDb;
  userId: string;
}) {
  const privateRecords = new Map<string, any>();
  const publicKeys = new Set<string>();
  for await (const [key, value] of args.db.iterator({ gte: "", lte: "\uffff" })) {
    if (typeof key !== "string" || !value || typeof value !== "object") continue;
    if (key.startsWith(`agent-${args.userId}-`) || key.startsWith(`cybot-${args.userId}-`)) {
      privateRecords.set(key, { ...(value as Record<string, unknown>), dbKey: key });
      continue;
    }
    if (key.startsWith("agent-pub-") || key.startsWith("cybot-pub-")) {
      publicKeys.add(key);
    }
  }

  const agents = sortListedAgents(
    [...privateRecords.values()]
      .map((record) => normalizeListedAgent(record))
      .filter((agent): agent is ListedAgent => agent != null)
  );

  for (const agent of agents) {
    agent.publicRecordExists = publicKeys.has(agent.publicKey);
  }
  return agents;
}

async function hasReadableRecord(args: {
  authToken: string;
  dbKey: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrl: string;
  readDbRecord: (args: {
    authToken: string;
    dbKey: string;
    fallbackFetchImpl?: CliFetchImpl;
    fetchImpl: CliFetchImpl;
    serverUrl: string;
  }) => Promise<any>;
}) {
  try {
    await args.readDbRecord(args);
    return true;
  } catch {
    return false;
  }
}

export async function listRemoteAgents(args: {
  authToken: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  includeLegacy: boolean;
  serverUrl: string;
  userId: string;
  queryUserRecords: (args: {
    authToken: string;
    fallbackFetchImpl?: CliFetchImpl;
    fetchImpl: CliFetchImpl;
    serverUrl: string;
    userId: string;
    type: "agent" | "cybot";
  }) => Promise<any[]>;
  readDbRecord: (args: {
    authToken: string;
    dbKey: string;
    fallbackFetchImpl?: CliFetchImpl;
    fetchImpl: CliFetchImpl;
    serverUrl: string;
  }) => Promise<any>;
}) {
  const recordGroups = [await args.queryUserRecords({ ...args, type: "agent" as const })];
  if (args.includeLegacy) {
    recordGroups.push(await args.queryUserRecords({ ...args, type: "cybot" as const }));
  }
  const agents = sortListedAgents(
    recordGroups
      .flat()
      .map((record) => normalizeListedAgent(record))
      .filter((agent): agent is ListedAgent => agent != null)
  );
  await Promise.all(
    agents.map(async (agent) => {
      agent.publicRecordExists = await hasReadableRecord({
        authToken: args.authToken,
        dbKey: agent.publicKey,
        fallbackFetchImpl: args.fallbackFetchImpl,
        fetchImpl: args.fetchImpl,
        serverUrl: args.serverUrl,
        readDbRecord: args.readDbRecord,
      });
    })
  );
  return agents;
}

export async function listRemoteAgentsAcrossServers(args: {
  authToken: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  includeLegacy: boolean;
  serverUrls: string[];
  userId: string;
}) {
  const remoteResult = await listUserRecordsFromServers({
    authToken: args.authToken,
    fallbackFetchImpl: args.fallbackFetchImpl,
    fetchImpl: args.fetchImpl,
    label: "agent query",
    serverUrls: args.serverUrls,
    type: args.includeLegacy ? ["agent", "cybot"] : "agent",
    userId: args.userId,
  });
  const agents = sortListedAgents(
    remoteResult.records
      .map((record) => normalizeListedAgent(record))
      .filter((agent): agent is ListedAgent => agent != null)
  );
  return { agents, failures: remoteResult.failures };
}

export async function decorateAgentsWithPublicStatusAcrossServers(args: {
  agents: ListedAgent[];
  authToken: string;
  fallbackFetchImpl?: CliFetchImpl;
  fetchImpl: CliFetchImpl;
  serverUrls: string[];
}) {
  await Promise.all(
    args.agents.map(async (agent) => {
      try {
        const result = await readLiveDbRecordAfterTombstoneMerge({
          authToken: args.authToken,
          dbKey: agent.publicKey,
          fallbackFetchImpl: args.fallbackFetchImpl,
          fetchImpl: args.fetchImpl,
          serverUrls: args.serverUrls,
        });
        agent.publicRecordExists = result.record?.isPublic === true;
      } catch {
        agent.publicRecordExists = false;
      }
    })
  );
  return args.agents;
}
