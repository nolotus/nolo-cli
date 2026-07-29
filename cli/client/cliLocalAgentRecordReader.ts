/**
 * CLI local agent + dialog record readers.
 *
 * Extracted from localRuntimeAdapter.ts. Pure functions that read agent
 * configs and dialog messages from a HybridRecordStore — no module-level
 * state, no lazy-loading coupling.
 */

import type { AgentRuntimeAgentConfig, AgentRuntimeChatMessage } from "../../agent-runtime";
import { resolveAgentRuntimeConfigFromRecord } from "../../agent-runtime";
import type { HybridRecordStore } from "./hybridRecordStore";
import {
  buildLocalAgentLookupKeys,
  shouldReadAgentKeyRemotely,
} from "./localAgentRecords";
import { normalizeAgentHandle } from "../../core/agentHandle";
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
      toolNames: ["readFile", "searchFiles", "execShell", "fetchWebpage", "exa_search"],
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
 * Two-phase lookup:
 * 1. Key lookup: build candidate dbKeys from agentRef (alias → agent-{userId}-{ref}),
 *    read each from the store (remote-first for concrete agent keys).
 * 2. Handle scan: if no key matched, iterate all `agent-*` records and match
 *    by `handle` field (case-insensitive, whitespace-collapsed).
 */
export async function readAgentFromStore(args: {
  store: HybridRecordStore;
  agentRef: string;
  userId: string;
}): Promise<AgentRuntimeAgentConfig | null> {
  // Sequential lookup with early return — each key must be checked in order, stopping at first match.
  for (const key of buildLocalAgentLookupKeys(args)) {
    const record = await args.store.read(key, {
      remote: shouldReadAgentKeyRemotely(key),
    });
    if (!record || typeof record !== "object") continue;
    return resolveAgentRuntimeConfigFromRecord(key, record);
  }
  const normalizedRef = normalizeAgentHandle(args.agentRef);
  if (!normalizedRef) return null;
  try {
    // Async iterator — must consume entries sequentially from the store cursor.
    const iterator = args.store.iterator({
      gte: "agent-",
      lte: "agent-\uffff",
    });
    for await (const [key, record] of iterator) {
      if (!record || typeof record !== "object") continue;
      const handle = normalizeAgentHandle((record as any).handle);
      if (handle !== normalizedRef) continue;
      return resolveAgentRuntimeConfigFromRecord(key, record);
    }
  } catch {
    // local handle scan unavailable
  }
  return null;
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