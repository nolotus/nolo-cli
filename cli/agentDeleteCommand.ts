/**
 * agentDeleteCommand.ts — nolo agent delete 子命令
 *
 * 用法：
 *   nolo agent delete <agentId|agentKey|agentUrl>
 *   nolo agent delete --id <agentId|agentKey|agentUrl>
 *   nolo agent delete <agent> --yes --json
 *   nolo agent delete <agent> --server https://nolo.chat
 *
 * 行为：
 *   - 通过 resolveAgentRecordFromHybridStore 解析输入（支持 alias / URL / dbKey / bare id）
 *   - 计算私有 key (agent-{userId}-{id}) 与公开 key (agent-pub-{id})
 *   - 在 resolveDeleteServerCandidates 给出的所有候选服务器上 tombstone 这两个 key
 *   - 默认是 dry-run；只有 --yes 才会真正调用 DELETE /api/v1/db/delete
 *   - 任一服务器失败 -> exit code 1
 */

import { toErrorMessage } from "../core/errorMessage";
import { resolveCliAgentKeyInput } from "./agentAliases";
import { getReadableCliDb, type AgentCommandDeps } from "./agentCommandSupport";
import { resolveAgentRecordFromHybridStore } from "./agentRecordHelpers";
import {
  parseUserIdFromAuthToken,
  resolveAuthToken,
  resolveDeleteServerCandidates,
  resolveServerUrl,
} from "./cliEnvHelpers";
import { deleteDbRecordOnServers, type GlobalDeleteResult } from "./globalRecordOperations";
import { clearAgentKeysFromLocalLevelDbs } from "./localLevelDbCleanup";

const AGENT_PRIVATE_KEY_RE = /^agent-([^-]+)-(.+)$/i;
const AGENT_PUBLIC_KEY_RE = /^agent-pub-(.+)$/i;

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function readAllPositional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a || a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

function extractAgentId(agentKey: string): string | undefined {
  const pub = agentKey.match(AGENT_PUBLIC_KEY_RE);
  if (pub) return pub[1];
  const priv = agentKey.match(AGENT_PRIVATE_KEY_RE);
  if (priv) return priv[2];
  return undefined;
}

function extractUserId(agentKey: string): string | undefined {
  const priv = agentKey.match(AGENT_PRIVATE_KEY_RE);
  if (priv) return priv[1];
  return undefined;
}

function buildAgentKeys(agentKey: string, fallbackUserId: string | undefined) {
  const agentId = extractAgentId(agentKey);
  if (!agentId) return null;
  const privateUserId = extractUserId(agentKey) ?? fallbackUserId;
  if (!privateUserId) return null;
  return {
    agentId,
    privateKey: `agent-${privateUserId}-${agentId}`,
    publicKey: `agent-pub-${agentId}`,
  };
}

function printUsage(output: { write(chunk: string): unknown }) {
  output.write("Usage: nolo agent delete <agentId|agentKey|agentUrl> [--yes] [--json]\n");
  output.write(
    "       nolo agent delete --id <agentId|agentKey|agentUrl> [--yes] [--json]\n",
  );
  output.write("\n");
  output.write("删除一个 agent 的私有记录 (agent-{userId}-{id}) 与公开记录 (agent-pub-{id})。\n");
  output.write("服务器端为 tombstone 软删除，DELETE 后再次 read 会返回 404。\n");
  output.write("\n");
  output.write("Flags:\n");
  output.write("  --yes            真正执行删除；缺省时仅 dry-run 输出目标摘要。\n");
  output.write("  --json           输出 JSON 结果。\n");
  output.write("  --id <agent>     与位置参数等价，传入 alias / dbKey / URL / 26-char id。\n");
  output.write("  --server / --server-url  仅删除指定服务器（仍保留集群 fan-out 之外的副本）。\n");
  output.write("  --user <userId>  显式覆盖 userId（与 AUTH_TOKEN 不一致则报错）。\n");
  output.write("  --token / --machine-key  临时覆盖 AUTH_TOKEN。\n");
  output.write("\n");
  output.write("Examples:\n");
  output.write("  nolo agent delete 01MIMOREALPLUS0608 --yes\n");
  output.write("  nolo agent delete https://nolo.chat/agent-0e95801d90-01MIMOREALPLUS0608 --yes --json\n");
}

export async function runAgentDeleteCommand(
  args: string[],
  deps: AgentCommandDeps = {},
) {
  const env = deps.env ?? process.env;
  const output = deps.output ?? process.stdout;

  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printUsage(output);
    return 0;
  }

  const explicitId = readOption(args, "--id");
  const positionals = readAllPositional(args);
  const agentInput = explicitId?.trim() || positionals[0]?.trim();
  if (!agentInput) {
    printUsage(output);
    return 1;
  }

  const authToken = resolveAuthToken(args, env);
  if (!authToken) {
    output.write(
      "[nolo] agent delete requires an auth token. Run `nolo login` or set AUTH_TOKEN.\n",
    );
    return 1;
  }

  const tokenUserId = parseUserIdFromAuthToken(authToken);
  if (!tokenUserId) {
    output.write(
      "[nolo] agent delete could not read userId from AUTH_TOKEN.\n",
    );
    return 1;
  }

  const userOverride = readOption(args, "--user");
  if (userOverride && userOverride !== tokenUserId) {
    output.write(
      `[nolo] agent delete --user (${userOverride}) does not match AUTH_TOKEN userId (${tokenUserId}).\n`,
    );
    return 1;
  }

  const agentKey = resolveCliAgentKeyInput(agentInput);
  const db = deps.db ?? await getReadableCliDb(output);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const fallbackFetchImpl = deps.fallbackFetchImpl;
  const json = hasFlag(args, "--json");
  const shouldDelete = hasFlag(args, "--yes");

  const serverUrl = resolveServerUrl(args, env);
  const serverUrls = resolveDeleteServerCandidates(args, env, serverUrl);

  let resolved: Awaited<ReturnType<typeof resolveAgentRecordFromHybridStore>>;
  try {
    resolved = await resolveAgentRecordFromHybridStore({
      agentInput,
      cliArgs: args,
      env,
      db,
      fetchImpl,
      fallbackFetchImpl,
    });
  } catch (error) {
    const msg = toErrorMessage(error);
    output.write(`[nolo] agent delete failed to resolve "${agentInput}": ${msg}\n`);
    return 1;
  }

  if (!resolved) {
    output.write(`[nolo] agent delete: agent not found: ${agentInput}\n`);
    return 1;
  }

  const keys = buildAgentKeys(resolved.agentKey, tokenUserId);
  if (!keys) {
    output.write(
      `[nolo] agent delete: cannot derive agent id from resolved key ${resolved.agentKey}.\n`,
    );
    return 1;
  }

  const record = resolved.record as Record<string, unknown> | undefined;
  const agentName =
    typeof record?.name === "string" && record.name.trim() ? record.name : "(unnamed)";
  const resolvedBase =
    typeof record?.serverOrigin === "string" && record.serverOrigin
      ? record.serverOrigin
      : "";

  let privateDeleteResults: GlobalDeleteResult[] = [];
  let publicDeleteResults: GlobalDeleteResult[] = [];

  if (shouldDelete) {
    try {
      privateDeleteResults = await deleteDbRecordOnServers({
        authToken,
        dbKey: keys.privateKey,
        fetchImpl,
        fallbackFetchImpl,
        serverUrls,
      });
      publicDeleteResults = await deleteDbRecordOnServers({
        authToken,
        dbKey: keys.publicKey,
        fetchImpl,
        fallbackFetchImpl,
        serverUrls,
      });
    } catch (error) {
      const msg = toErrorMessage(error);
      output.write(`[nolo] agent delete fan-out failed: ${msg}\n`);
      return 1;
    }
  }

  // 清理本地所有 LevelDB 副本中的 agent 记录（防止 slot 进程回写旧记录）
  if (shouldDelete) {
    try {
      const cleanedPaths = await clearAgentKeysFromLocalLevelDbs({
        keys: [keys.privateKey, keys.publicKey],
      });
      if (cleanedPaths.length > 0 && !json) {
        output.write(`Cleaned local LevelDB copies: ${cleanedPaths.length}\n`);
      }
    } catch (error) {
      const msg = toErrorMessage(error);
      if (!json) output.write(`[nolo] local LevelDB cleanup skipped: ${msg}\n`);
    }
  }

  const allResults = [...privateDeleteResults, ...publicDeleteResults];
  const failed = allResults.filter((r) => !r.ok);
  const succeededCount = allResults.length - failed.length;

  const payload = {
    agentKey: resolved.agentKey,
    agentName,
    agentId: keys.agentId,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    resolvedBase: resolvedBase || null,
    targetServers: serverUrls,
    dryRun: !shouldDelete,
    deleted: shouldDelete,
    deleteResults: shouldDelete
      ? {
          private: privateDeleteResults,
          public: publicDeleteResults,
        }
      : undefined,
  };

  if (json) {
    output.write(JSON.stringify(payload, null, 2));
    output.write("\n");
  } else {
    output.write(`agent: ${agentName}\n`);
    output.write(`agentKey: ${resolved.agentKey}\n`);
    output.write(`privateKey: ${keys.privateKey}\n`);
    output.write(`publicKey: ${keys.publicKey}\n`);
    output.write(`targetServers: ${serverUrls.join(", ")}\n`);
    if (resolvedBase) output.write(`resolvedBase: ${resolvedBase}\n`);
    if (!shouldDelete) {
      output.write(
        "\nDry-run only. Re-run with --yes to tombstone this agent on the target servers.\n",
      );
    } else {
      if (privateDeleteResults.length || publicDeleteResults.length) {
        output.write(
          `Deleted on ${succeededCount}/${allResults.length} targets. ${
            failed.length
              ? `Failures: ${failed
                  .map((r) => `${r.dbKey ?? ""}@${r.serverUrl} (${r.error ?? "unknown"})`)
                  .join("; ")}`
              : ""
          }\n`,
        );
      } else {
        output.write("No delete requests issued.\n");
      }
    }
  }

  return failed.length > 0 ? 1 : 0;
}
