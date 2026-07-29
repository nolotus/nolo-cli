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
//
// 外部依赖：resolveRuntimeServerUrl / resolveRuntimeAuthToken / remoteDialogSyncTimeout /
// parseUserIdFromAuthToken / clipCompactText

import { isRecord } from "../core/isRecord";
import { asOptionalTrimmedString } from "../core/optionalString";
import { asTrimmedNonEmptyStringArray } from "../core/stringArray";
import { toErrorMessage } from "../core/errorMessage";
import type { CliFetchImpl } from "../cliFetch";
import { parseUserIdFromAuthToken } from "../cliEnvHelpers";
import {
  resolveRuntimeServerUrl,
  resolveRuntimeAuthToken,
  remoteDialogSyncTimeout,
  type EnvLike,
} from "./localRuntimeHelpers";
import { fetchWithTransientRetry } from "./localRuntimeFetchRetry";
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

// ── throttled batch helpers ──────────────────────────────────────────────
//
// 服务端 db write 限流 120 次/分/IP；补同步大差集突发会直接打满。
// 写循环按批执行：每批最多 `EVIDENCE_WRITE_BATCH_SIZE` 条并发，批间 sleep
// `EVIDENCE_WRITE_BATCH_GAP_MS`。批间 fail-fast：某批任一写失败即抛出，
// 后续批不再派发（此前无界 Promise.all 失败时其余写已在途）。失败由调用方
// 的 try/catch 兜底，这里只做节流。
const EVIDENCE_WRITE_BATCH_SIZE = 4;
const EVIDENCE_WRITE_BATCH_GAP_MS = 300;

async function defaultEvidenceSleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 按批并发执行写入任务，批间节流。保持输入顺序语义（前一批全部完成后
 * 才开始下一批），避免乱序覆盖。
 */
async function runThrottledBatches<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
  options: { batchSize?: number; batchGapMs?: number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const batchSize = options.batchSize ?? EVIDENCE_WRITE_BATCH_SIZE;
  const batchGapMs = options.batchGapMs ?? EVIDENCE_WRITE_BATCH_GAP_MS;
  const sleep = options.sleep ?? defaultEvidenceSleep;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map((item) => run(item)));
    if (i + batchSize < items.length) {
      await sleep(batchGapMs);
    }
  }
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
  const response = await fetchWithTransientRetry(
    args.fetchImpl,
    `${args.serverUrl}/api/v1/db/write/`,
    {
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
    },
    // evidence 写是 customKey 幂等覆盖写（同 key 重写结果相同），
    // 因此 502 重试安全：即便前一次已被服务端处理，重写结果不变。
    { retryableStatuses: new Set([429, 502, 503]) },
  );
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
  /** 可注入 sleep，测试用于断言批间节流；生产路径用默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
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

  // Remote post requests are independent — but unbounded Promise.all can
  // burst past the server's 120/min/IP db-write limit on a large backlog.
  // Bounded concurrency (4) preserves the msg-then-nonMsg ordering while
  // keeping the write rate within the throttle budget. 某批失败即中止后续
  // 批次（fail-fast），由调用方 try/catch 兜底。
  await runThrottledBatches(
    orderedOps.filter((op) => op.type === "put"),
    (op) =>
      postRemoteRecord({
        authToken,
        data: op.value,
        fetchImpl: args.fetchImpl,
        key: op.key,
        serverUrl,
        userId: args.userId,
      }),
    args.sleep ? { sleep: args.sleep } : {},
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
// Removed: pushLocalDialogToRemote, pushLocalMessagesMissingFromRemote,
// ensureDialogSyncedForServerFallback — auto runtime no longer falls back
// to server when local fails (see agentRun.ts).