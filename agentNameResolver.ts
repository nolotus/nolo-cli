import { getReadableCliDb, type OutputLike } from "./agentCommandSupport";
import {
  listLocalCachedAgents,
  listRemoteAgentsAcrossServers,
  type ListedAgent,
} from "./agentListHelpers";
import { resolveCliAgentKeyInput } from "./agentAliases";
import {
  parseUserIdFromAuthToken,
  resolveAuthToken,
  resolveServerCandidates,
  resolveServerUrl,
  type EnvLike,
} from "./cliEnvHelpers";
import type { CliKvDb } from "./client/hybridRecordStore";

export type ResolvedAgentInput = {
  agentKey: string;
  agentName: string;
  source: "explicit" | "agent-list";
};

function normalizeAgentName(value: string) {
  return value.trim().toLowerCase();
}

function isExplicitAgentKey(value: string) {
  return /^(agent|cybot)-(pub-|[^-]+-).+/i.test(value);
}

function findAgentByName(input: string, agents: ListedAgent[]) {
  const normalized = normalizeAgentName(input);
  return agents.filter((agent) => normalizeAgentName(agent.name) === normalized);
}

function formatAmbiguousAgentName(input: string, matches: ListedAgent[]) {
  return [
    `ambiguous agent name: ${input}`,
    ...matches.map((agent) => `- ${agent.name}: ${agent.privateKey}`),
  ].join("\n");
}

function isAmbiguousAgentNameError(error: unknown) {
  return error instanceof Error && error.message.startsWith("ambiguous agent name:");
}

async function listLocalAgentsForResolution(args: {
  authToken: string;
  db?: CliKvDb;
  output: OutputLike;
}) {
  const userId = parseUserIdFromAuthToken(args.authToken);
  if (!userId) {
    throw new Error("could not read userId from AUTH_TOKEN; run `nolo login` first.");
  }
  const db = args.db ?? await getReadableCliDb(args.output);
  return listLocalCachedAgents({ db, userId });
}

async function listRemoteAgentsForResolution(args: {
  authToken: string;
  env: EnvLike;
  fallbackFetchImpl?: typeof fetch;
  fetchImpl: typeof fetch;
}) {
  const userId = parseUserIdFromAuthToken(args.authToken);
  if (!userId) {
    throw new Error("could not read userId from AUTH_TOKEN; run `nolo login` first.");
  }
  const serverUrl = resolveServerUrl(args.env);
  const serverUrls = resolveServerCandidates(args.env, serverUrl);
  return (await listRemoteAgentsAcrossServers({
    authToken: args.authToken,
    fallbackFetchImpl: args.fallbackFetchImpl,
    fetchImpl: args.fetchImpl,
    includeLegacy: false,
    serverUrls,
    userId,
  })).agents;
}

function resolveUniqueAgentName(input: string, agents: ListedAgent[]) {
  const matches = findAgentByName(input, agents);
  if (matches.length === 1) {
    return {
      agentKey: matches[0].privateKey,
      agentName: matches[0].name,
      source: "agent-list" as const,
    };
  }
  if (matches.length > 1) {
    throw new Error(formatAmbiguousAgentName(input, matches));
  }
  return null;
}

export async function resolveAgentInput(args: {
  agentInput: string;
  authToken?: string;
  db?: CliKvDb;
  env: EnvLike;
  fallbackFetchImpl?: typeof fetch;
  fetchImpl: typeof fetch;
  output: OutputLike;
}): Promise<ResolvedAgentInput> {
  const parsed = resolveCliAgentKeyInput(args.agentInput);
  if (isExplicitAgentKey(parsed)) {
    return {
      agentKey: parsed,
      agentName: args.agentInput,
      source: "explicit",
    };
  }

  const authToken = args.authToken ?? resolveAuthToken(args.env);
  if (!authToken) {
    throw new Error(
      `agent not found: ${args.agentInput}. Run \`nolo login\` and \`nolo agent list\`, or pass an explicit agent key.`
    );
  }

  if (args.db) {
    try {
      const localAgents = await listLocalAgentsForResolution({
        authToken,
        db: args.db,
        output: args.output,
      });
      const localMatch = resolveUniqueAgentName(parsed, localAgents);
      if (localMatch) return localMatch;
    } catch (error) {
      if (isAmbiguousAgentNameError(error)) throw error;
      // Local cache is an optimization; remote agent list remains authoritative enough to resolve names.
    }
  }

  try {
    const remoteAgents = await listRemoteAgentsForResolution({
      authToken,
      env: args.env,
      fallbackFetchImpl: args.fallbackFetchImpl,
      fetchImpl: args.fetchImpl,
    });
    const remoteMatch = resolveUniqueAgentName(parsed, remoteAgents);
    if (remoteMatch) return remoteMatch;
  } catch (error) {
    if (isAmbiguousAgentNameError(error)) throw error;
    if (!args.db) {
      try {
        const localAgents = await listLocalAgentsForResolution({
          authToken,
          output: args.output,
        });
        const localMatch = resolveUniqueAgentName(parsed, localAgents);
        if (localMatch) return localMatch;
      } catch (localError) {
        if (isAmbiguousAgentNameError(localError)) throw localError;
        // Fall through to the user-facing not-found message below.
      }
    }
  }

  throw new Error(`agent not found by name: ${args.agentInput}. Run \`nolo agent list\` to see available agents.`);
}
