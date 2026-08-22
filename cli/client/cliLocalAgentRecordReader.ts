/**
 * CLI local agent + dialog record readers.
 *
 * Extracted from localRuntimeAdapter.ts. Pure functions that read agent
 * configs and dialog messages from a HybridRecordStore — no module-level
 * state, no lazy-loading coupling.
 */

import type { AgentRuntimeAgentConfig, AgentRuntimeChatMessage } from "../../agent-runtime";
import { resolveAgentRuntimeConfigFromRecord } from "../../agent-runtime";
import {
  applyBuiltinAgentRuntimeOverride,
  resolveBuiltinPlatformAgentConfig,
} from "../../agent-runtime/builtinPlatformAgentConfigs";
import type { HybridRecordStore } from "./hybridRecordStore";
import { buildLocalAgentLookupKeys } from "./localAgentRecords";
import { dialogMessageRange } from "../../database/keys";
import { localDialogMessageRecordToRuntimeMessage } from "./localDialogRecords";
import {
  LOCAL_CODEX_AGENT_ID,
  LOCAL_CODEX_AGENT_KEY,
} from "../agentAliases";

/**
 * Resolve the builtin Local Codex agent config when the agentRef matches.
 * Returns null for any other ref — callers fall back to store lookup.
 */
export function resolveBuiltinLocalCliAgentConfig(
  agentRef: string,
  userId: string,
): AgentRuntimeAgentConfig | null {
  const normalized = agentRef.trim();
  if (
    normalized === LOCAL_CODEX_AGENT_KEY ||
    normalized === LOCAL_CODEX_AGENT_ID
  ) {
    return {
      key: LOCAL_CODEX_AGENT_KEY,
      name: "Local Codex",
      prompt:
        "You are a local Codex CLI coding agent. Use the workspace and dialog evidence available to you, keep changes scoped, run relevant checks, and report worktree, branch, commit or dirty diff, tests, and blockers.",
      apiSource: "cli",
      provider: "cli",
      cliProvider: "codex",
      toolNames: ["readFile", "execShell", "fetchWebpage", "exa_search"],
      rawRecord: {
        dbKey: LOCAL_CODEX_AGENT_KEY,
        id: LOCAL_CODEX_AGENT_ID,
        userId,
        type: "agent",
        name: "Local Codex",
        apiSource: "cli",
        provider: "cli",
        cliProvider: "codex",
      },
    };
  }
  return null;
}

/**
 * Read an agent config from the store.
 *
 * Local-first lookup:
 * 1. Key lookup: build candidate dbKeys from agentRef (alias → agent-{userId}-{ref}),
 *    read each from the store with hybrid defaults — local cache hit is used
 *    directly; on local miss the store falls back to remote servers (including
 *    NOLO_SYNC_SERVERS) and caches the fetched record locally. This keeps the
 *    runtime usable regardless of which site created the agent.
 * 2. If no key matched, fall back to the builtin platform agent config.
 */
export async function readAgentFromStore(args: {
  store: HybridRecordStore;
  agentRef: string;
  userId: string;
}): Promise<AgentRuntimeAgentConfig | null> {
  // Sequential lookup with early return — each key must be checked in order, stopping at first match.
  for (const key of buildLocalAgentLookupKeys(args)) {
    const record = await args.store.read(key);
    if (!record || typeof record !== "object") continue;
    // 内置 agent 的 provider/model 由 catalog 托管，命中记录也要盖一层：
    // 服务端那道 override（agentRun/agentLookup）管不到本地 runtime，而本地
    // 缓存里存的可能正是过期记录（hybrid store 会把远端读到的原始记录缓存下来，
    // 客户端升级并不会重写它）。不盖的话本地模式又会回到「状态行显示 catalog
    // 模型的窗口、实际却跑记录里的旧模型」——正是这次要消灭的分叉。
    return applyBuiltinAgentRuntimeOverride(
      args.agentRef,
      resolveAgentRuntimeConfigFromRecord(key, record),
    );
  }
  // Last-chance fallback: known built-in platform agent keys (quick-chat
  // tiers + builtin nolo) may not be in the local store or the remote
  // record may 404. Synthesize the platform config so auto-mode routing
  // keeps working instead of erroring "Local agent config not found".
  return resolveBuiltinPlatformAgentConfig(args.agentRef);
}

/**
 * Read all messages for a dialog from the store, in key order.
 */
export async function readDialogMessages(args: {
  store: HybridRecordStore;
  dialogId: string;
}): Promise<AgentRuntimeChatMessage[]> {
  const messages: AgentRuntimeChatMessage[] = [];
  const { start, end } = dialogMessageRange(args.dialogId);
  const iterator = args.store.iterator({ gte: start, lte: end });
  // Async iterator — must consume entries sequentially from the store cursor.
  for await (const [, value] of iterator) {
    const message = localDialogMessageRecordToRuntimeMessage(value);
    if (message) messages.push(message);
  }
  return messages;
}