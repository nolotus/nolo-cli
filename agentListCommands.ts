import { toErrorMessage } from "./core/errorMessage";
import { toSafeAgentSummary, sortSafeAgentSummaries } from "./ai/agent/safeAgentSummary";
import { getReadableCliDb, type AgentCommandDeps } from "./agentCommandSupport";
import {
  decorateAgentsWithPublicStatusAcrossServers,
  listFavoriteAgentIdsAcrossServers,
  listLocalCachedAgents,
  listRemoteAgentsAcrossServers,
  listRemoteAgents,
  normalizeListedAgent,
  parseAgentListArgs,
  type ListedAgent,
} from "./agentListHelpers";
import {
  queryUserRecords,
  readDbRecord,
} from "./agentRecordHelpers";
import { buildSpaceLookup, getSpaceContentKeys } from "./cliSpaceHelpers";
import {
  parseUserIdFromAuthToken,
  readOption,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
} from "./cliEnvHelpers";
import { readLiveDbRecordAfterTombstoneMerge } from "./globalRecordOperations";

export async function runAgentListCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const { wantJson, wantSafe, publicOnly, idsOnly } = parseAgentListArgs(args);
  const spaceInput = readOption(args, "--space") ?? readOption(args, "--space-id");

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] agent list requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write("[nolo] agent list could not read userId from AUTH_TOKEN.\n");
    return 1;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;
  const serverUrl = resolveServerUrl(args, env);
  const serverUrls = resolveServerCandidates(args, env, serverUrl);

  try {
    let agents: ListedAgent[];
    let source: "local-cache" | "remote-cache" | "global-cache";
    let serverFailures: Array<{ serverUrl: string; error: string }> = [];
    try {
      const remoteResult = await listRemoteAgentsAcrossServers({
        authToken,
        fallbackFetchImpl,
        fetchImpl,
        serverUrls,
        userId,
      });
      agents = remoteResult.agents;
      serverFailures = remoteResult.failures;
      source = "global-cache";
    } catch {
      try {
        const db = deps.db ?? await getReadableCliDb(output);
        agents = await listLocalCachedAgents({ db, userId });
        source = "local-cache";
      } catch {
        agents = await listRemoteAgents({
          authToken,
          fallbackFetchImpl,
          fetchImpl,
          serverUrl,
          userId,
          queryUserRecords,
          readDbRecord,
        });
        source = "remote-cache";
      }
    }

    agents = agents.filter((agent) => agent.privateKey.startsWith("agent-"));
    let resolvedSpaceId: string | null = null;
    let spaceContentKeys: Set<string> | null = null;
    if (spaceInput) {
      const { spaceId, spaceKey } = buildSpaceLookup(spaceInput);
      resolvedSpaceId = spaceId;
      const spaceRead = await readLiveDbRecordAfterTombstoneMerge({
        authToken,
        dbKey: spaceKey,
        fallbackFetchImpl,
        fetchImpl,
        serverUrls,
      });
      serverFailures = [...serverFailures, ...spaceRead.failures];
      const spaceRecord = spaceRead.record;
      const currentSpaceContentKeys = getSpaceContentKeys(spaceRecord);
      spaceContentKeys = currentSpaceContentKeys;
      agents = agents.filter((agent) =>
        currentSpaceContentKeys.has(agent.privateKey) ||
        currentSpaceContentKeys.has(agent.publicKey) ||
        currentSpaceContentKeys.has(agent.id)
      );
    }
    if (source === "global-cache") {
      await decorateAgentsWithPublicStatusAcrossServers({
        agents,
        authToken,
        fallbackFetchImpl,
        fetchImpl,
        serverUrls,
      });
    }
    if (publicOnly) {
      agents = agents.filter((agent) => agent.publicRecordExists);
    }

    if (idsOnly) {
      output.write(`${agents.map((agent) => agent.id).join("\n")}\n`);
      return 0;
    }

    if (wantSafe) {
      const favoritesMap = await listFavoriteAgentIdsAcrossServers({
        authToken,
        fetchImpl,
        serverUrls,
      }).catch(() => ({} as Record<string, number>));

      const existingKeys = new Set<string>();
      for (const agent of agents) {
        existingKeys.add(agent.privateKey);
        existingKeys.add(agent.publicKey);
        existingKeys.add(agent.id);
      }
      const extraFavoriteRecords: any[] = [];
      const hydratedFavoriteAgents: ListedAgent[] = [];

      for (const favKey of Object.keys(favoritesMap)) {
        if (existingKeys.has(favKey)) continue;
        try {
          const favRead = await readLiveDbRecordAfterTombstoneMerge({
            authToken,
            dbKey: favKey,
            fallbackFetchImpl,
            fetchImpl,
            serverUrls,
          });
          const record = favRead.record;
          if (!record || (record.type && record.type !== "agent")) continue;
          const norm = normalizeListedAgent(record);
          const candidateKeys = [record.dbKey, record.publicKey, record.id]
            .filter((key): key is string => typeof key === "string" && key.length > 0);
          if (
            spaceContentKeys &&
            !candidateKeys.some((key) => spaceContentKeys?.has(key))
          ) {
            continue;
          }
          if (norm) {
            agents.push(norm);
            hydratedFavoriteAgents.push(norm);
            existingKeys.add(norm.privateKey);
            existingKeys.add(norm.publicKey);
            existingKeys.add(norm.id);
          } else {
            extraFavoriteRecords.push(record);
            for (const key of candidateKeys) existingKeys.add(key);
          }
        } catch {
          // orphan favorite key, skip it.
        }
      }

      if (source === "global-cache" && hydratedFavoriteAgents.length > 0) {
        await decorateAgentsWithPublicStatusAcrossServers({
          agents: hydratedFavoriteAgents,
          authToken,
          fallbackFetchImpl,
          fetchImpl,
          serverUrls,
        });
      }

      let safeAgents = agents.map((agent) =>
        toSafeAgentSummary(agent, { favoritesMap, userId })
      );
      safeAgents.push(
        ...extraFavoriteRecords.map((record) =>
          toSafeAgentSummary(record, { favoritesMap, userId })
        )
      );
      if (publicOnly) {
        safeAgents = safeAgents.filter((agent) => agent.isPublic);
      }
      safeAgents = sortSafeAgentSummaries(safeAgents);

      output.write(JSON.stringify({
        success: true,
        userId,
        ...(resolvedSpaceId ? { spaceId: resolvedSpaceId } : {}),
        total: safeAgents.length,
        agents: safeAgents,
      }, null, 2));
      output.write("\n");
      return 0;
    }

    if (wantJson) {
      output.write(JSON.stringify({
        userId,
        ...(resolvedSpaceId ? { spaceId: resolvedSpaceId } : {}),
        targetServers: serverUrls,
        ...(serverFailures.length ? { serverFailures } : {}),
        total: agents.length,
        publicCount: agents.filter((agent) => agent.publicRecordExists).length,
        source,
        agents,
      }, null, 2));
      output.write("\n");
      return 0;
    }

    output.write(`userId: ${userId}\n`);
    if (resolvedSpaceId) {
      output.write(`spaceId: ${resolvedSpaceId}\n`);
    }
    output.write(`targetServers: ${serverUrls.join(", ")}\n`);
    if (serverFailures.length) {
      output.write(`serverFailures: ${serverFailures.length}\n`);
    }
    output.write(`total agents: ${agents.length}\n`);
    output.write(`public agents: ${agents.filter((agent) => agent.publicRecordExists).length}\n`);
    output.write(`source: ${source}\n`);
    if (agents.length === 0) {
      output.write("\n(no agents found)\n");
      return 0;
    }
    for (const agent of agents) {
      const status = agent.publicRecordExists ? "public" : "private";
      const flagMismatch = agent.isPublicFlag !== agent.publicRecordExists
        ? ` flag=${agent.isPublicFlag}`
        : "";
      const credentialLine = agent.credentialConfigured
        ? `credentialConfigured=true${agent.credentialRef ? ` credentialRef=${agent.credentialRef}` : ""}${agent.apiKeyRef ? ` apiKeyRef=${agent.apiKeyRef}` : ""}`
        : "credentialConfigured=false";
      output.write(
        [
          `\n[${status}] ${agent.name}`,
          `id=${agent.id}`,
          `type=${agent.type ?? "-"}`,
          `model=${agent.model}`,
          `updatedAt=${agent.updatedAt ?? "-"}`,
          // 不输出 privateKey（dbKey 属敏感标识，与 web 端 listAgentsFunc 降权
          // 对齐；需要完整记录请用 --json）。
          `publicKey=${agent.publicKey}${flagMismatch}`,
          `tools=${agent.tools.join(", ") || "-"}`,
          credentialLine,
        ].join("\n")
      );
      output.write("\n");
    }
    return 0;
  } catch (error) {
    output.write(
      `[nolo] agent list failed: ${toErrorMessage(error)}\n`
    );
    return 1;
  }
}
