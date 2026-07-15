import { toErrorMessage } from "./core/errorMessage";
import { getReadableCliDb, type AgentCommandDeps } from "./agentCommandSupport";
import {
  decorateAgentsWithPublicStatusAcrossServers,
  listLocalCachedAgents,
  listRemoteAgentsAcrossServers,
  listRemoteAgents,
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
  const { wantJson, publicOnly, idsOnly, includeLegacy } = parseAgentListArgs(args);
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
        includeLegacy,
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
          includeLegacy,
          serverUrl,
          userId,
          queryUserRecords,
          readDbRecord,
        });
        source = "remote-cache";
      }
    }

    if (!includeLegacy) {
      agents = agents.filter((agent) => agent.privateKey.startsWith("agent-"));
    }
    let resolvedSpaceId: string | null = null;
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
      const spaceContentKeys = getSpaceContentKeys(spaceRecord);
      agents = agents.filter((agent) =>
        spaceContentKeys.has(agent.privateKey) ||
        spaceContentKeys.has(agent.publicKey) ||
        spaceContentKeys.has(agent.id)
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
      output.write(
        [
          `\n[${status}] ${agent.name}`,
          `id=${agent.id}`,
          `type=${agent.type ?? "-"}`,
          `model=${agent.model}`,
          `updatedAt=${agent.updatedAt ?? "-"}`,
          `privateKey=${agent.privateKey}`,
          `publicKey=${agent.publicKey}${flagMismatch}`,
          `tools=${agent.tools.join(", ") || "-"}`,
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
