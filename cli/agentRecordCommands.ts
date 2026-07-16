import { resolveCliAgentKeyInput } from "./agentAliases";
import { getReadableCliDb, type AgentCommandDeps } from "./agentCommandSupport";
import {
  buildUpdatedAgentRecord,
  buildCreatedAgentRecord,
  normalizeAgentRecordForOutput,
  parseAgentUpdateArgs,
  resolveAgentRecordFromHybridStore,
  sanitizeAgentRecordForCliOutput,
  writeAgentRecord,
} from "./agentRecordHelpers";
import { parseUserIdFromAuthToken, resolveAuthToken } from "./cliEnvHelpers";
import { clearCliLocalRuntimePreparedAgentCache } from "./client/localRuntimeAdapter";
import { toErrorMessage } from "../core/errorMessage";

export async function runAgentReadCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  const agentInput = args[0]?.trim();
  if (!agentInput || agentInput === "--help" || agentInput === "-h") {
    output.write("Usage: nolo agent read <agent>\n");
    return agentInput ? 0 : 1;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] agent read requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  const agentKey = resolveCliAgentKeyInput(agentInput);
  const db = deps.db ?? await getReadableCliDb(output);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;

  try {
    const result = await resolveAgentRecordFromHybridStore({
      agentInput,
      cliArgs: args,
      env,
      db,
      fetchImpl,
      fallbackFetchImpl,
    });
    if (!result) {
      throw new Error(`agent not found: ${agentKey}`);
    }
    output.write(JSON.stringify({
      ...normalizeAgentRecordForOutput(result.agentKey, authToken, result.record),
      source: result.source,
    }, null, 2));
    output.write("\n");
    return 0;
  } catch (error) {
    output.write(
      `[nolo] agent read failed: ${
        toErrorMessage(error)
      }\n`
    );
    return 1;
  }
}

export async function runAgentUpdateCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  let parsed;
  try {
    parsed = parseAgentUpdateArgs(args);
  } catch (error) {
    output.write(`[nolo] agent update failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
  if (!parsed) {
    output.write(
      "Usage: nolo agent update <agent> [--model <id>] [--cli-provider <provider>] [--api-source <source>] [--max-concurrent <n>] [--expires-at <iso>] [--prompt <text> | --prompt-file <path> | --prompt-doc <pageKey>] [--tools <json>] [--copy-provider-from <agent>] [--field key=value]\n"
        .replace("[--field key=value]", "[--handle <name>] [--field key=value]")
    );
    return args[0] ? 0 : 1;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] agent update requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write("[nolo] agent update could not read userId from AUTH_TOKEN.\n");
    return 1;
  }

  const db = deps.db ?? await getReadableCliDb(output);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;

  try {
    const built = await buildUpdatedAgentRecord({
      cliArgs: args,
      parsed,
      env,
      db,
      fetchImpl,
      fallbackFetchImpl,
      authToken,
    });

    await writeAgentRecord({
      agentKey: built.agentKey,
      authToken,
      fallbackFetchImpl,
      fetchImpl,
      serverUrl: built.serverUrl,
      userId,
      record: built.nextRecord,
    });
    await db.put(built.agentKey, {
      ...built.nextRecord,
      dbKey: built.agentKey,
      key: built.nextRecord?.key || built.agentKey,
      serverOrigin: built.serverUrl,
    });
    clearCliLocalRuntimePreparedAgentCache();

    output.write(JSON.stringify({
      ok: true,
      agentKey: built.agentKey,
      baseUrl: built.serverUrl,
      updates: sanitizeAgentRecordForCliOutput(built.updates),
      record: sanitizeAgentRecordForCliOutput(built.nextRecord),
    }, null, 2));
    output.write("\n");
    return 0;
  } catch (error) {
    output.write(
      `[nolo] agent update failed: ${
        toErrorMessage(error)
      }\n`
    );
    return 1;
  }
}

export async function runAgentCreateCommand(
  args: string[],
  deps: AgentCommandDeps = {}
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;
  let parsed;
  try {
    parsed = parseAgentUpdateArgs(args);
  } catch (error) {
    output.write(`[nolo] agent create failed: ${toErrorMessage(error)}\n`);
    return 1;
  }
  if (!parsed) {
    output.write(
      "Usage: nolo agent create <agent> [--model <id>] [--cli-provider <provider>] [--api-source <source>] [--max-concurrent <n>] [--expires-at <iso>] [--prompt <text> | --prompt-file <path> | --prompt-doc <pageKey>] [--tools <json>] [--copy-provider-from <agent>] [--name <name>] [--custom-provider-url <url>] [--provider-api-key <key>] [--field key=value]\n"
        .replace("[--field key=value]", "[--handle <name>] [--field key=value]")
    );
    return args[0] ? 0 : 1;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write("[nolo] agent create requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n");
    return 1;
  }

  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId) {
    output.write("[nolo] agent create could not read userId from AUTH_TOKEN.\n");
    return 1;
  }

  const db = deps.db ?? await getReadableCliDb(output);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;

  try {
    const built = await buildCreatedAgentRecord({
      cliArgs: args,
      parsed,
      env,
      db,
      fetchImpl,
      fallbackFetchImpl,
      authToken,
    });

    await writeAgentRecord({
      agentKey: built.agentKey,
      authToken,
      fallbackFetchImpl,
      fetchImpl,
      serverUrl: built.serverUrl,
      userId,
      record: built.nextRecord,
    });
    await db.put(built.agentKey, {
      ...built.nextRecord,
      dbKey: built.agentKey,
      key: built.nextRecord?.key || built.agentKey,
      serverOrigin: built.serverUrl,
    });
    clearCliLocalRuntimePreparedAgentCache();

    output.write(JSON.stringify({
      ok: true,
      agentKey: built.agentKey,
      baseUrl: built.serverUrl,
      updates: sanitizeAgentRecordForCliOutput(built.updates),
      record: sanitizeAgentRecordForCliOutput(built.nextRecord),
    }, null, 2));
    output.write("\n");
    return 0;
  } catch (error) {
    output.write(
      `[nolo] agent create failed: ${
        toErrorMessage(error)
      }\n`
    );
    return 1;
  }
}
