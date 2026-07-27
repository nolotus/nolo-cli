// packages/cli/client/cliRemoteDialogSync.ts
//
// Remote dialog 同步链——从 localRuntimeAdapter.ts 提取。
//
// 本地 CLI agent 运行后需要把对话记录同步到远程服务器，以及在子对话完成时
// 唤醒父对话。这组函数负责：
// - prepareRemoteDialogEvidenceRecord：消息记录标准化
// - postRemoteRecord / readRemoteRecord：远程 db read/write
// - syncLocalDialogEvidenceToRemote：批量同步本地写入 ops 到远程
// - maybeWakeParentDialogAfterLocalSync：子对话 terminal → 唤醒父对话
// - pushLocalDialogToRemote：本地对话推送到远程（fallback 用）
// - ensureDialogSyncedForServerFallback：检查远程是否存在，不存在则推送
//
// 外部依赖：resolveRuntimeServerUrl / resolveRuntimeAuthToken / remoteDialogSyncTimeout /
// readDialogFromLocalDb / parseUserIdFromAuthToken / clipCompactText

import { isRecord } from "../core/isRecord";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedNonEmptyStringArray } from "../core/stringArray";
import { toErrorMessage } from "../core/errorMessage";
import type { CliFetchImpl } from "../cliFetch";
import {
  readDialogFromLocalDb,
  type LocalDialogReadResult,
} from "../agent-runtime/localDialogRead";
import { isLevelLockError } from "../database/levelLockError";
import { getDefaultCliLocalRuntimeDb } from "../localRuntimeAuthority";
import { parseUserIdFromAuthToken } from "../cliEnvHelpers";
import {
  resolveRuntimeServerUrl,
  resolveRuntimeAuthToken,
  remoteDialogSyncTimeout,
  type EnvLike,
} from "./localRuntimeHelpers";
import { clipCompactText } from "../core/clipCompactText";
import type { AgentRuntimeSaveTurnInput } from "../agent-runtime";

// ── helpers ──────────────────────────────────────────────────────────────

export function prepareRemoteDialogEvidenceRecord(key: string, value: any) {
  const record = isRecord(value) ? { ...value } : {};
  if (key.includes("-msg-") && typeof record.type !== "string") {
    record.type = "msg";
  }
  return record;
}

export function normalizeRemoteStringList(value: unknown): string[] {
  return [...new Set(asTrimmedNonEmptyStringArray(value))];
}

function normalizeRemoteSubjectRef(value: unknown) {
  if (!isRecord(value)) return null;
  const kind = asOptionalTrimmedString(value.kind);
  const id = asOptionalTrimmedString(value.id);
  if (!kind || !id) return null;
  const role = asOptionalTrimmedString(value.role);
  return { kind, id, ...(role ? { role } : {}) };
}

function mergeRemoteSubjectRefs(...groups: unknown[]) {
  const refs: Array<{ kind: string; id: string; role?: string }> = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const ref = normalizeRemoteSubjectRef(item);
      if (!ref) continue;
      const key = `${ref.kind}\0${ref.id}\0${ref.role ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

function resolveParentAgentKeyFromDialog(parentDialog: Record<string, any>) {
  const primaryKey = asOptionalTrimmedString(parentDialog.primaryAgentKey);
  if (primaryKey) return primaryKey;
  const agentKey = asOptionalTrimmedString(parentDialog.agentKey);
  if (agentKey) return agentKey;
  if (Array.isArray(parentDialog.cybots)) {
    for (const item of parentDialog.cybots) {
      const normalized = asOptionalTrimmedString(item);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

function clipLocalWakeEvidence(value: unknown, max = 1200) {
  if (typeof value !== "string") return undefined;
  const compact = clipCompactText(value, max);
  return compact || undefined;
}

function buildLocalParentWakeMessage(args: {
  childAgentKey: string;
  childDialogId: string;
  childDialogKey: string;
  childEvidenceSummary?: string;
}) {
  return [
    "A child agent dialog you started has reached a terminal status.",
    "",
    `childDialogId: ${args.childDialogId}`,
    `childDialogKey: ${args.childDialogKey}`,
    `childAgentKey: ${args.childAgentKey}`,
    "status: done",
    ...(args.childEvidenceSummary
      ? ["", "childEvidenceSummary:", args.childEvidenceSummary]
      : []),
    "",
    "Read the childEvidenceSummary and decide the next step yourself. This wake came from a local CLI run, so completion evidence is the synced child dialog, subjectRefs, commits, artifacts, and test output rather than a server-side child process.",
  ].join("\n");
}

// ── remote record I/O ────────────────────────────────────────────────────

export async function postRemoteRecord(args: {
  authToken: string;
  data: any;
  fetchImpl: CliFetchImpl;
  key: string;
  serverUrl: string;
  userId: string;
}) {
  const response = await args.fetchImpl(`${args.serverUrl}/api/v1/db/write/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.authToken}`,
    },
    body: JSON.stringify({
      customKey: args.key,
      userId: args.userId,
      data: prepareRemoteDialogEvidenceRecord(args.key, args.data),
    }),
    signal: AbortSignal.timeout(remoteDialogSyncTimeout()),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `remote dialog evidence write failed: HTTP ${response.status} ${text.slice(0, 500)}`,
    );
  }
}

async function readRemoteRecord(args: {
  authToken: string;
  fetchImpl: CliFetchImpl;
  key: string;
  serverUrl: string;
}) {
  const response = await args.fetchImpl(
    `${args.serverUrl}/api/v1/db/read/${encodeURIComponent(args.key)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
      },
      signal: AbortSignal.timeout(remoteDialogSyncTimeout()),
    },
  );
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  return payload?.data && typeof payload.data === "object"
    ? payload.data
    : null;
}

// ── parent dialog wake ───────────────────────────────────────────────────

async function maybeWakeParentDialogAfterLocalSync(args: {
  authToken: string;
  childDialogKey: string;
  childDialogRecord: Record<string, any>;
  fetchImpl: CliFetchImpl;
  input: AgentRuntimeSaveTurnInput;
  serverUrl: string;
  userId: string;
}) {
  if (args.input.runtimeContext?.parentWakeOnTerminal !== true) return;
  if (args.childDialogRecord.parentWake?.terminalNotifiedAt) return;
  const parentDialogId = asOptionalTrimmedString(
    args.childDialogRecord.parentDialogId,
  );
  if (!parentDialogId) return;

  const parentDialogKey = `dialog-${args.userId}-${parentDialogId}`;
  const parentDialog = await readRemoteRecord({
    authToken: args.authToken,
    fetchImpl: args.fetchImpl,
    key: parentDialogKey,
    serverUrl: args.serverUrl,
  });
  if (!parentDialog) return;
  const parentAgentKey = resolveParentAgentKeyFromDialog(parentDialog);
  if (!parentAgentKey) return;

  const childDialogId = asOptionalTrimmedString(args.childDialogRecord.id);
  if (!childDialogId) return;
  const subjectRefs = mergeRemoteSubjectRefs(
    args.childDialogRecord.subjectRefs,
    [{ kind: "dialog", id: childDialogId, role: "completed-child-dialog" }],
  );
  const allowedChildAgentKeys = normalizeRemoteStringList(
    args.input.runtimeContext?.allowedChildAgentKeys,
  );
  const allowedToolNames = normalizeRemoteStringList(
    args.input.runtimeContext?.allowedToolNames,
  );
  const blockedToolNames = normalizeRemoteStringList(
    args.input.runtimeContext?.blockedToolNames,
  );
  const wakeResponse = await args.fetchImpl(`${args.serverUrl}/api/agent/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.authToken}`,
    },
    body: JSON.stringify({
      agentKey: parentAgentKey,
      userInput: buildLocalParentWakeMessage({
        childAgentKey:
          args.childDialogRecord.primaryAgentKey ?? args.input.agentKey,
        childDialogId,
        childDialogKey: args.childDialogKey,
        childEvidenceSummary: clipLocalWakeEvidence(args.input.result.content),
      }),
      background: true,
      continueDialogId: parentDialogId,
      runtimeContext: {
        surface: "cli",
        host: "terminal",
        runtime: "bun",
        entrypoint: "agent-runtime:parent-child-terminal-wake",
        subjectRefs,
        ...(allowedChildAgentKeys.length ? { allowedChildAgentKeys } : {}),
        ...(allowedToolNames.length ? { allowedToolNames } : {}),
        ...(blockedToolNames.length ? { blockedToolNames } : {}),
      },
    }),
  });
  if (!wakeResponse.ok) {
    const text = await wakeResponse.text().catch(() => "");
    throw new Error(
      `parent dialog wake failed: HTTP ${wakeResponse.status} ${text.slice(0, 500)}`,
    );
  }

  const notifiedAt = Date.now();
  await postRemoteRecord({
    authToken: args.authToken,
    data: {
      ...args.childDialogRecord,
      parentWake: {
        terminalNotifiedAt: notifiedAt,
        terminalStatus: "done",
        parentDialogId,
        childDialogId,
      },
      updatedAt: new Date(notifiedAt).toISOString(),
    },
    fetchImpl: args.fetchImpl,
    key: args.childDialogKey,
    serverUrl: args.serverUrl,
    userId: args.userId,
  });
}

// ── sync local dialog evidence to remote ─────────────────────────────────

export async function syncLocalDialogEvidenceToRemote(args: {
  env: EnvLike;
  fetchImpl: CliFetchImpl;
  input: AgentRuntimeSaveTurnInput;
  ops: Array<{ type: "put"; key: string; value: any }>;
  output?: { write(chunk: string): unknown };
  userId: string;
}) {
  const serverUrl = resolveRuntimeServerUrl(args.env);
  const authToken = resolveRuntimeAuthToken(args.env);
  if (!serverUrl || !authToken) {
    return { attempted: false as const };
  }

  // Single pass: partition into msg ops (front) and non-msg ops (back)
  const orderedOps: Array<{ type: "put"; key: string; value: any }> = [];
  const nonMsgOps: Array<{ type: "put"; key: string; value: any }> = [];
  for (const op of args.ops) {
    if (op.type !== "put") continue;
    if (op.key.includes("-msg-")) {
      orderedOps.push(op);
    } else {
      nonMsgOps.push(op);
    }
  }
  orderedOps.push(...nonMsgOps);

  // Remote post requests are independent — parallelize with Promise.all
  await Promise.all(
    orderedOps
      .filter((op) => op.type === "put")
      .map((op) =>
        postRemoteRecord({
          authToken,
          data: op.value,
          fetchImpl: args.fetchImpl,
          key: op.key,
          serverUrl,
          userId: args.userId,
        }),
      ),
  );

  const childDialogOp = args.ops.find(
    (op) => op.type === "put" && !op.key.includes("-msg-"),
  );
  const childDialogRecord =
    childDialogOp?.value && typeof childDialogOp.value === "object"
      ? childDialogOp.value
      : null;
  if (childDialogOp && childDialogRecord) {
    try {
      await maybeWakeParentDialogAfterLocalSync({
        authToken,
        childDialogKey: childDialogOp.key,
        childDialogRecord,
        fetchImpl: args.fetchImpl,
        input: args.input,
        serverUrl,
        userId: args.userId,
      });
    } catch (error) {
      args.output?.write(
        `[nolo] Parent dialog wake failed; synced local child evidence remains queryable: ${toErrorMessage(
          error,
        )}\n`,
      );
    }
  }

  return { attempted: true as const };
}

// ── push local dialog to remote (fallback) ───────────────────────────────

export async function pushLocalDialogToRemote(args: {
  authToken: string;
  continueDialogId: string;
  env: EnvLike;
  fetchImpl?: CliFetchImpl;
  output?: { write(chunk: string): unknown };
  serverUrl?: string;
  userId: string;
}): Promise<{ ok: boolean; exitCode?: number }> {
  const serverUrl =
    (args.serverUrl && args.serverUrl.trim() ? args.serverUrl.trim() : undefined) ||
    resolveRuntimeServerUrl(args.env);
  if (!serverUrl) {
    args.output?.write(
      `[nolo] Dialog "${args.continueDialogId}" exists only locally and failed to sync to server (server URL missing). Please check your network or authentication, or start a new dialog.\n`,
    );
    return { ok: false, exitCode: 1 };
  }
  const fetchImpl =
    args.fetchImpl ?? (globalThis.fetch as unknown as CliFetchImpl);
  const dialogKey = `dialog-${args.userId}-${args.continueDialogId}`;

  let localData: LocalDialogReadResult;
  try {
    // 走 CLI authority broker：attach-to-existing + 重试，不直接 new Level() 抢 LOCK。
    // 当本地 dev server / 上一轮 agent runtime 持有 LevelDB LOCK 时，直接 import serverDb
    // 会立刻抛 LEVEL_LOCKED，导致 fallback sync 静默失败、server 带着残缺历史继续。
    const localDb = await getDefaultCliLocalRuntimeDb({ env: args.env });
    localData = await readDialogFromLocalDb({
      dialogKey,
      dialogId: args.continueDialogId,
      limit: 0,
      db: localDb,
    });
  } catch (err) {
    args.output?.write(
      `[nolo] Dialog "${args.continueDialogId}" exists only locally and failed to sync to server (${toErrorMessage(err)}). Please check your network or authentication, or start a new dialog.\n`,
    );
    return { ok: false, exitCode: 1 };
  }

  if (!localData || !localData.meta) {
    args.output?.write(
      `[nolo] Dialog "${args.continueDialogId}" exists only locally and failed to sync to server (local dialog record not found). Please check your network or authentication, or start a new dialog.\n`,
    );
    return { ok: false, exitCode: 1 };
  }

  try {
    for (const msg of localData.msgs || []) {
      const msgKey =
        msg._key ||
        msg.dbKey ||
        `dialog-msg-${args.continueDialogId}-${msg.id}`;
      await postRemoteRecord({
        authToken: args.authToken,
        data: msg,
        fetchImpl,
        key: msgKey,
        serverUrl,
        userId: args.userId,
      });
    }

    await postRemoteRecord({
      authToken: args.authToken,
      data: localData.meta,
      fetchImpl,
      key: dialogKey,
      serverUrl,
      userId: args.userId,
    });
  } catch (err) {
    args.output?.write(
      `[nolo] Dialog "${args.continueDialogId}" exists only locally and failed to sync to server (${toErrorMessage(err)}). Please check your network or authentication, or start a new dialog.\n`,
    );
    return { ok: false, exitCode: 1 };
  }

  return { ok: true };
}

/** 与 pushLocalDialogToRemote 同一套 key 推导，两处必须一致否则会重复写入。 */
const dialogMessageKey = (dialogId: string, msg: any) =>
  msg?._key || msg?.dbKey || `dialog-msg-${dialogId}-${msg?.id}`;

/**
 * 补齐远端缺失的本地消息（best-effort，失败绝不阻塞 fallback）。
 *
 * 只补不删、只按 key 补差集：远端比本地新时（例如对话本来就在服务端跑）
 * 这里什么都不做，不会用陈旧的本地状态覆盖服务端。
 */
async function pushLocalMessagesMissingFromRemote(args: {
  authToken: string;
  continueDialogId: string;
  dialogKey: string;
  env: EnvLike;
  fetchImpl: CliFetchImpl;
  output?: { write(chunk: string): unknown };
  serverUrl: string;
  userId: string;
}): Promise<void> {
  try {
    // 与 pushLocalDialogToRemote 同走 broker，避免直接抢 LevelDB LOCK。
    const localDb = await getDefaultCliLocalRuntimeDb({ env: args.env });
    const localData = await readDialogFromLocalDb({
      dialogKey: args.dialogKey,
      dialogId: args.continueDialogId,
      limit: 0,
      db: localDb,
    });
    const localMsgs = localData?.msgs ?? [];
    if (localMsgs.length === 0) return;

    const remoteRes = await args.fetchImpl(`${args.serverUrl}/rpc/getConvMsgs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ dialogId: args.continueDialogId, limit: 0 }),
    });
    if (!remoteRes.ok) return;
    const remoteMsgs = await remoteRes.json();
    if (!Array.isArray(remoteMsgs)) return;

    const remoteKeys = new Set(
      remoteMsgs.map((msg) => dialogMessageKey(args.continueDialogId, msg)),
    );
    const missing = localMsgs.filter(
      (msg) => !remoteKeys.has(dialogMessageKey(args.continueDialogId, msg)),
    );
    if (missing.length === 0) return;

    for (const msg of missing) {
      await postRemoteRecord({
        authToken: args.authToken,
        data: msg,
        fetchImpl: args.fetchImpl,
        key: dialogMessageKey(args.continueDialogId, msg),
        serverUrl: args.serverUrl,
        userId: args.userId,
      });
    }
    args.output?.write(
      `[nolo] Synced ${missing.length} local-only message(s) to the server before falling back.\n`,
    );
  } catch (err) {
    // 补齐是 best-effort：宁可带着略旧的历史继续，也不要因为同步失败而整轮失败。
    // 但 lock 错误要给用户人话提示，告诉他为什么历史会缺——不是网络问题，
    // 而是本地 dev server / 上一轮 agent runtime 还握着 LevelDB LOCK。
    if (isLevelLockError(err)) {
      args.output?.write(
        `[nolo] Warning: local database is locked; server fallback will continue with incomplete history. `
          + `Release the local DB (stop the dev server / kill stale agent processes) and retry, or use the server-side history directly.\n`,
      );
    } else {
      args.output?.write(
        `[nolo] Warning: could not sync local-only messages before fallback (${toErrorMessage(err)}).\n`,
      );
    }
  }
}

export async function ensureDialogSyncedForServerFallback(
  options: {
    continueDialogId?: string;
    env: EnvLike;
    fetchImpl?: CliFetchImpl;
    output?: { write(chunk: string): unknown };
    serverUrl?: string;
  },
  authToken: string,
): Promise<{ ok: boolean; exitCode?: number }> {
  const continueDialogId = options.continueDialogId
    ? String(options.continueDialogId).trim()
    : "";
  if (!continueDialogId) {
    return { ok: true };
  }

  const userId = parseUserIdFromAuthToken(authToken);
  if (!userId || userId === "local") {
    return { ok: true };
  }

  const serverUrl =
    resolveRuntimeServerUrl(options.env) ||
    (options.serverUrl && options.serverUrl.trim() ? options.serverUrl.trim() : undefined);
  if (!serverUrl) {
    return { ok: true };
  }
  const fetchImpl =
    options.fetchImpl ?? (globalThis.fetch as unknown as CliFetchImpl);
  const dialogKey = `dialog-${userId}-${continueDialogId}`;

  let response: Response;
  try {
    response = await fetchImpl(
      `${serverUrl}/api/v1/db/read/${encodeURIComponent(dialogKey)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      },
    );
  } catch (err) {
    options.output?.write(
      `[nolo] Warning: Failed to check remote dialog status (${toErrorMessage(err)}); continuing fallback.\n`,
    );
    return { ok: true };
  }

  if (response.ok) {
    // 远端有 dialog 记录 ≠ 远端有完整消息。此前这里直接放行，于是本地轮次
    // 同步失败后（服务器繁忙时 chat 代理与 db 写入会同时退化）server fallback
    // 会带着过期历史重跑，用户看到的就是「刚说过的话它不记得」。补齐差额。
    await pushLocalMessagesMissingFromRemote({
      authToken,
      continueDialogId,
      dialogKey,
      env: options.env,
      fetchImpl,
      output: options.output,
      serverUrl,
      userId,
    });
    return { ok: true };
  }

  if (response.status === 404) {
    return pushLocalDialogToRemote({
      authToken,
      continueDialogId,
      env: options.env,
      fetchImpl,
      output: options.output,
      serverUrl,
      userId,
    });
  }

  options.output?.write(
    `[nolo] Warning: Failed to check remote dialog status (HTTP ${response.status}); continuing fallback.\n`,
  );
  return { ok: true };
}